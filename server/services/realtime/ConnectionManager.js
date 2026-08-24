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
    this.maxConnectionsPerUser = 20; // 1ユーザーあたりの最大WebSocket接続数（DoS/リソース枯渇防止）
  }

  register(userId, socket, sessionTokenHash = null) {
    const normalizedUserId = Number(userId);
    if (!Number.isInteger(normalizedUserId) || normalizedUserId < 0 || !socket) {
      return;
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
        } catch (_) {}
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
        // 旧アダプター互換のフォールバック。
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

  closeAll(code = 1001, reason = 'Server shutting down') {
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
