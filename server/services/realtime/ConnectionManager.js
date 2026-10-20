const {
  getVisibleDmUnreadCount,
} = require('../DmVisibilityService');

function getBlockedUserIds(user) {
  return new Set(
    (Array.isArray(user?.block) ? user.block : [])
      .map(Number)
      .filter(Number.isInteger),
  );
}

function blocksUser(user, targetUserId) {
  for (const blockedUserId of Array.isArray(user?.block) ? user.block : []) {
    if (Number(blockedUserId) === targetUserId) return true;
  }
  return false;
}

class ConnectionManager {
  constructor() {
    this.connectionsByUser = new Map();
    // 生のセッショントークンを保持せず、Push購読に保存されている値と同じハッシュだけを紐付ける。
    this.sessionHashBySocket = new WeakMap();
    this.maxConnectionsPerUser = 20; // 1ユーザーあたりの最大WebSocket接続数
    this.maxSocketBufferSize = 1024 * 1024; // 1MB 送信バッファ上限
    this._heartbeatTimer = null;

    // スペースの購読状態（テキストチャット配信）とボイス在室状態（通話シグナリング）。
    // どちらもプロセスメモリ上の状態で、再起動で消える。
    this.spaceSubscriptionsByUser = new Map(); // userId -> Set<spaceId>
    this.spaceVoiceRosters = new Map(); // `${spaceId}:${channelId}` -> Map<userId, {socket, muted, deafened, joinedAt}>
  }

  register(userId, socket, sessionTokenHash = null) {
    const normalizedUserId = Number(userId);
    if (!Number.isInteger(normalizedUserId) || normalizedUserId < 0 || !socket) {
      return;
    }

    socket.isAlive = true;
    if (typeof socket.on === 'function') {
      socket.on('pong', () => {
        socket.isAlive = true;
      });
    }

    if (!this.connectionsByUser.has(normalizedUserId)) {
      this.connectionsByUser.set(normalizedUserId, new Set());
    }
    const userSockets = this.connectionsByUser.get(normalizedUserId);

    // 接続数制限を超えた場合、最も古い接続を切断して新規接続を受け入れる
    if (userSockets.size >= this.maxConnectionsPerUser) {
      const oldestSocket = userSockets.values().next().value;
      if (oldestSocket) {
        userSockets.delete(oldestSocket);
        this.sessionHashBySocket.delete(oldestSocket);
        try {
          oldestSocket.close(1008, 'Max concurrent connections exceeded');
        } catch (_) {
          // 既に切断済みのソケットは閉じられなくても問題ない。
        }
      }
    }

    userSockets.add(socket);
    if (typeof sessionTokenHash === 'string' && sessionTokenHash) {
      this.sessionHashBySocket.set(socket, sessionTokenHash);
    }
  }

  unregister(userId, socket) {
    const normalizedUserId = Number(userId);
    const sockets = this.connectionsByUser.get(normalizedUserId);
    if (!sockets) return;

    sockets.delete(socket);
    this.sessionHashBySocket.delete(socket);
    if (sockets.size === 0) {
      this.connectionsByUser.delete(normalizedUserId);
    }

    // 切断されたソケットがボイス在室状態に残っていたら、その場で在室解除して配信する。
    for (const roster of this.spaceVoiceRosters.values()) {
      const entry = roster.get(normalizedUserId);
      if (entry && entry.socket === socket) {
        roster.delete(normalizedUserId);
        this._publishSpaceVoiceRoster(entry.spaceId, entry.channelId, roster);
      }
    }
    this.spaceSubscriptionsByUser.delete(normalizedUserId);
  }

  hasActiveSession(userId, sessionTokenHash) {
    const normalizedUserId = Number(userId);
    if (!Number.isInteger(normalizedUserId) || normalizedUserId < 0) return false;
    if (typeof sessionTokenHash !== 'string' || !sessionTokenHash) return false;

    const sockets = this.connectionsByUser.get(normalizedUserId);
    if (!sockets || sockets.size === 0) return false;

    for (const socket of Array.from(sockets)) {
      if (!socket || socket.readyState !== 1) {
        this.unregister(normalizedUserId, socket);
        continue;
      }
      if (this.sessionHashBySocket.get(socket) === sessionTokenHash) return true;
    }

    return false;
  }

  hasActiveConnection(userId) {
    const normalizedUserId = Number(userId);
    if (!Number.isInteger(normalizedUserId) || normalizedUserId < 0) return false;
    const sockets = this.connectionsByUser.get(normalizedUserId);
    if (!sockets || sockets.size === 0) return false;
    for (const socket of Array.from(sockets)) {
      if (socket && socket.readyState === 1) return true;
      this.unregister(normalizedUserId, socket);
    }
    return false;
  }

  _sendSerializedToUser(userId, serialized) {
    const normalizedUserId = Number(userId);
    const sockets = this.connectionsByUser.get(normalizedUserId);
    if (!sockets || sockets.size === 0) return false;

    let delivered = false;
    for (const socket of Array.from(sockets)) {
      if (!socket || socket.readyState !== 1) {
        this.unregister(normalizedUserId, socket);
        continue;
      }

      if (socket.bufferedAmount > this.maxSocketBufferSize) {
        console.warn(`[realtime] Client buffer exceeded (${socket.bufferedAmount} bytes), terminating stalled socket for user ${normalizedUserId}`);
        this.unregister(normalizedUserId, socket);
        try {
          socket.terminate();
        } catch (_) {
          // バッファ超過で強制終了するソケットは、既に破棄済みなら無視する。
        }
        continue;
      }

      try {
        socket.send(serialized);
        delivered = true;
      } catch (error) {
        console.warn('[realtime] Event delivery failed:', error.message);
        this.unregister(normalizedUserId, socket);
        try {
          socket.terminate();
        } catch (_) {
          // Socket has already been torn down.
        }
      }
    }

    return delivered;
  }

  sendToUser(userId, event) {
    let serialized;
    try {
      serialized = JSON.stringify(event);
    } catch (error) {
      console.warn('[realtime] Event serialization failed:', error.message);
      return false;
    }
    return this._sendSerializedToUser(userId, serialized);
  }

  // ==================== Spaces ====================
  subscribeToSpace(userId, spaceId) {
    const normalizedUserId = Number(userId);
    if (!Number.isInteger(normalizedUserId) || normalizedUserId < 0) return;
    if (!this.spaceSubscriptionsByUser.has(normalizedUserId)) {
      this.spaceSubscriptionsByUser.set(normalizedUserId, new Set());
    }
    this.spaceSubscriptionsByUser.get(normalizedUserId).add(String(spaceId));
  }

  unsubscribeFromSpace(userId, spaceId) {
    const normalizedUserId = Number(userId);
    const subscribed = this.spaceSubscriptionsByUser.get(normalizedUserId);
    if (!subscribed) return;
    if (spaceId == null) subscribed.clear();
    else subscribed.delete(String(spaceId));
    if (subscribed.size === 0) this.spaceSubscriptionsByUser.delete(normalizedUserId);
  }

  /** スペースに参加しているユーザー全員（接続中）にイベントを送る。 */
  async broadcastToSpace(spaceId, dbAdapter, event) {
    const targetSpaceId = String(spaceId);
    if (!dbAdapter || typeof dbAdapter.listSpaceMembers !== 'function') {
      return 0;
    }
    let recipients;
    try {
      const members = await dbAdapter.listSpaceMembers(targetSpaceId, { limit: 200, offset: 0 });
      recipients = members.map((member) => Number(member.userId ?? member.user_id)).filter(Number.isInteger);
    } catch (_) {
      return 0;
    }
    const connected = recipients.filter((userId) => this.hasActiveConnection(userId));
    return connected.reduce((count, userId) => (this.sendToUser(userId, event) ? count + 1 : count), 0);
  }

  /** ボイスチャンネル在室リストのスナップショット。 */
  getSpaceVoiceRoster(spaceId, channelId) {
    const roster = this.spaceVoiceRosters.get(`${spaceId}:${channelId}`);
    if (!roster) return [];
    return [...roster.entries()].map(([userId, entry]) => ({
      user_id: userId,
      muted: Boolean(entry.muted),
      deafened: Boolean(entry.deafened),
      joined_at: entry.joinedAt,
    }));
  }

  /** ボイスチャンネルに参加し、在室者リストを配信して既存在室者に知らせる。 */
  joinSpaceVoice(userId, spaceId, channelId, socket, { muted = false, deafened = false } = {}) {
    const normalizedUserId = Number(userId);
    const key = `${spaceId}:${channelId}`;
    if (!this.spaceVoiceRosters.has(key)) this.spaceVoiceRosters.set(key, new Map());
    const roster = this.spaceVoiceRosters.get(key);
    roster.set(normalizedUserId, {
      socket, muted: Boolean(muted), deafened: Boolean(deafened),
      joinedAt: new Date().toISOString(), spaceId, channelId,
    });
    const rosterSnapshot = this.getSpaceVoiceRoster(spaceId, channelId);
    // 既存在室者に新規参加者を通知し、新規参加者には現状の在室リストを返す。
    this._publishToVoiceRoster(key, { type: 'space_voice_roster', space_id: String(spaceId), channel_id: String(channelId), roster: rosterSnapshot, joined_user_id: normalizedUserId });
    return rosterSnapshot;
  }

  leaveSpaceVoice(userId, spaceId, channelId) {
    const normalizedUserId = Number(userId);
    const key = `${spaceId}:${channelId}`;
    const roster = this.spaceVoiceRosters.get(key);
    if (!roster) return [];
    roster.delete(normalizedUserId);
    if (roster.size === 0) this.spaceVoiceRosters.delete(key);
    else {
      this._publishToVoiceRoster(key, { type: 'space_voice_roster', space_id: String(spaceId), channel_id: String(channelId), roster: this.getSpaceVoiceRoster(spaceId, channelId), left_user_id: normalizedUserId });
      return this.getSpaceVoiceRoster(spaceId, channelId);
    }
    this._publishToVoiceRoster(key, { type: 'space_voice_roster', space_id: String(spaceId), channel_id: String(channelId), roster: [], left_user_id: normalizedUserId });
    return [];
  }

  /** ミュート・スピーカーオフの状態を在室者全員に通知する。 */
  updateSpaceVoiceState(userId, spaceId, channelId, { muted, deafened }) {
    const normalizedUserId = Number(userId);
    const key = `${spaceId}:${channelId}`;
    const roster = this.spaceVoiceRosters.get(key);
    const entry = roster?.get(normalizedUserId);
    if (!entry) return null;
    if (muted !== undefined) entry.muted = Boolean(muted);
    if (deafened !== undefined) entry.deafened = Boolean(deafened);
    this._publishToVoiceRoster(key, { type: 'space_voice_roster', space_id: String(spaceId), channel_id: String(channelId), roster: this.getSpaceVoiceRoster(spaceId, channelId) });
    return { muted: entry.muted, deafened: entry.deafened };
  }

  /** WebRTCシグナリング（offer/answer/ICE）を同じボイスチャンネル内の特定ユーザーへ中継する。 */
  relaySpaceSignal(fromUserId, spaceId, channelId, toUserId, data) {
    const normalizedFrom = Number(fromUserId);
    const normalizedTo = Number(toUserId);
    const roster = this.spaceVoiceRosters.get(`${spaceId}:${channelId}`);
    if (!roster) return false;
    const source = roster.get(normalizedFrom);
    if (!source) return false;
    // 同一チャンネルの在室者同士のみの中継。
    if (!roster.has(normalizedTo)) return false;
    return this.sendToUser(normalizedTo, {
      type: 'space_signal',
      space_id: String(spaceId),
      channel_id: String(channelId),
      from_user_id: normalizedFrom,
      data,
    });
  }

  _publishSpaceVoiceRoster(spaceId, channelId, roster) {
    this._publishToVoiceRoster(`${spaceId}:${channelId}`, {
      type: 'space_voice_roster',
      space_id: String(spaceId),
      channel_id: String(channelId),
      roster: [...roster.entries()].map(([userId, entry]) => ({ user_id: userId, muted: Boolean(entry.muted), deafened: Boolean(entry.deafened), joined_at: entry.joinedAt })),
    });
  }

  _publishToVoiceRoster(key, event) {
    const roster = this.spaceVoiceRosters.get(key);
    if (!roster) return;
    for (const userId of roster.keys()) {
      this.sendToUser(userId, event);
    }
  }

  async publishNotificationUnreadCount(userId, dbAdapter) {
    const unreadCount = await dbAdapter.getUnreadNotificationCount(userId);
    this.sendToUser(userId, {
      type: 'notification_unread_count',
      unread_count: unreadCount,
    });
    return unreadCount;
  }

  async publishNewNotification(userId, notification, dbAdapter) {
    const unreadCount = await dbAdapter.getUnreadNotificationCount(userId);
    // notification_newに未読数を含める。クライアントは同イベントだけで
    // 通知一覧とバッジを更新できるため、同一値の二重配信を避ける。
    this.sendToUser(userId, {
      type: 'notification_new',
      notification,
      unread_count: unreadCount,
    });
    return unreadCount;
  }

  publishDmMessage(userId, dmId, message, sender = null) {
    return this.sendToUser(userId, {
      type: 'dm_message',
      dm_id: String(dmId),
      message,
      ...(sender ? { sender } : {}),
    });
  }

  publishDmRead(userId, dmId, readerId) {
    return this.sendToUser(userId, {
      type: 'dm_read',
      dm_id: String(dmId),
      reader_id: Number(readerId),
    });
  }

  async publishDmUnreadCount(userId, dbAdapter, dmId = null) {
    const unreadCount = await getVisibleDmUnreadCount(dbAdapter, userId);
    this.sendToUser(userId, {
      type: 'dm_unread_count',
      unread_count: unreadCount,
      ...(dmId ? { dm_id: String(dmId) } : {}),
    });
    return unreadCount;
  }

  async publishPostToFollowers(authorUserId, dbAdapter, post) {
    if (post && typeof post === 'object' && (post.replyTo != null || post.reply_to != null)) {
      return 0;
    }
    const postId = Number(post && typeof post === 'object' ? post.id : post);
    const authorId = Number(authorUserId);
    if (!Number.isInteger(authorId) || authorId < 0 || !Number.isInteger(postId) || postId < 1 || !dbAdapter) {
      return 0;
    }

    const connectedUserIds = [...this.connectionsByUser.keys()].filter(
      (userId) => Number(userId) !== authorId,
    );
    if (connectedUserIds.length === 0) return 0;

    let recipientIds = [];
    try {
      if (typeof dbAdapter.getFollowRelationshipSnapshot === 'function') {
        const snapshot = await dbAdapter.getFollowRelationshipSnapshot(
          authorId,
          connectedUserIds,
        );
        recipientIds = Array.isArray(snapshot?.followerIds)
          ? snapshot.followerIds.map(Number).filter(Number.isInteger)
          : [];
      } else if (typeof dbAdapter.getFollowIds === 'function') {
        // 一括取得が無い場合はフォロー一覧から該当者を求める。
        const following = await Promise.all(
          connectedUserIds.map(async (recipientId) => ({
            recipientId,
            followingIds: await dbAdapter.getFollowIds(recipientId),
          })),
        );
        recipientIds = following
          .filter(({ followingIds }) =>
            (followingIds || []).some((id) => Number(id) === authorId),
          )
          .map(({ recipientId }) => recipientId);
      }
    } catch (error) {
      console.warn('[realtime] Failed to determine post recipients:', error.message);
      return 0;
    }

    recipientIds = [...new Set(recipientIds)].filter((recipientId) =>
      this.connectionsByUser.has(recipientId),
    );
    if (recipientIds.length === 0) return 0;

    // フォロー関係と同じく、ブロック判定に必要なユーザー情報も一括取得する。
    let usersById = new Map();
    try {
      const userIds = [authorId, ...recipientIds];
      const users = typeof dbAdapter.getUsersByIds === 'function'
        ? await dbAdapter.getUsersByIds(userIds)
        : await Promise.all(userIds.map((userId) => dbAdapter.getUserById(userId)));
      usersById = new Map(
        (users || [])
          .filter(Boolean)
          .map((user) => [Number(user.id), user]),
      );
    } catch (error) {
      console.warn('[realtime] Failed to load post recipient visibility:', error.message);
      return 0;
    }

    const authorBlocks = getBlockedUserIds(usersById.get(authorId));
    let serializedEvent;
    try {
      // 同一イベントを全受信者へ送るため、JSON化は配信ごとに一度だけ行う。
      serializedEvent = JSON.stringify({
        type: 'timeline_post',
        timeline: 'following',
        author_id: authorId,
        post_id: Number(postId),
      });
    } catch (error) {
      console.warn('[realtime] Timeline event serialization failed:', error.message);
      return 0;
    }

    let deliveredCount = 0;
    for (const recipientId of recipientIds) {
      const recipient = usersById.get(recipientId);
      if (!recipient) continue;
      if (authorBlocks.has(recipientId) || blocksUser(recipient, authorId)) {
        continue;
      }
      if (this._sendSerializedToUser(recipientId, serializedEvent)) {
        deliveredCount += 1;
      }
    }

    return deliveredCount;
  }

  closeUser(userId, code = 1012, reason = 'Account maintenance') {
    const normalizedUserId = Number(userId);
    const sockets = this.connectionsByUser.get(normalizedUserId);
    if (!sockets) return 0;
    let closed = 0;
    for (const socket of sockets) {
      try {
        socket.close(code, reason);
        closed += 1;
      } catch (_) {
        // Socket may already be closed.
      }
      this.sessionHashBySocket.delete(socket);
    }
    this.connectionsByUser.delete(normalizedUserId);
    return closed;
  }

  startHeartbeat(intervalMs = 30000) {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => {
      for (const [userId, sockets] of this.connectionsByUser.entries()) {
        for (const socket of Array.from(sockets)) {
          if (!socket || socket.readyState !== 1 || socket.isAlive === false) {
            this.unregister(userId, socket);
            try { socket.terminate(); } catch (_) {}
            continue;
          }
          socket.isAlive = false;
          try {
            socket.ping();
          } catch (_) {
            this.unregister(userId, socket);
            try { socket.terminate(); } catch (_) {}
          }
        }
      }
    }, intervalMs);
    this._heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  closeAll(code = 1001, reason = 'Server shutting down') {
    this.stopHeartbeat();
    for (const sockets of this.connectionsByUser.values()) {
      for (const socket of sockets) {
        try {
          socket.close(code, reason);
        } catch (_) {
          // Socket may have been closed concurrently.
        }
      }
    }
    this.connectionsByUser.clear();
  }
}

module.exports = ConnectionManager;
