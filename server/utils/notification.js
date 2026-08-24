const NOTIFICATION_TYPES = new Set([
  'post',
  'reply',
  'quote',
  'repost',
  'mention',
  'like',
  'star',
  'follow',
  'dm_invite',
  'dm_removed',
  'dm_host_transfer',
  'group_invite',
  'group_join_request',
  'group_announcement',
  'admin_notice',
  'auto_moderation',
  'login_approval',
  'moderation_assignment',
  'moderation_action_taken',
  'moderation_no_action',
  'appeal_approved',
  'appeal_rejected',
  'verification_approved',
  'verification_rejected',
  'poll_ended',
]);

const TARGET_KINDS = new Set(['post', 'dm', 'user', 'route']);

function normalizeTarget(target, { postId = null, open = '' } = {}) {
  if (target && typeof target === 'object' && TARGET_KINDS.has(target.kind)) {
    if (target.kind === 'route') {
      return typeof target.value === 'string' && target.value.startsWith('#')
        ? { kind: 'route', value: target.value }
        : null;
    }
    const id = Number(target.id);
    return Number.isInteger(id) && id >= 0 ? { kind: target.kind, id } : null;
  }

  const normalizedPostId = Number(postId);
  if (Number.isInteger(normalizedPostId) && normalizedPostId > 0) {
    return { kind: 'post', id: normalizedPostId };
  }
  if (typeof open === 'string' && open.startsWith('#')) {
    return { kind: 'route', value: open };
  }
  return null;
}

function getNotificationTargetHash(target, fallbackFromId = null) {
  if (!target) return fallbackFromId != null ? `#profile/${fallbackFromId}` : '#notifications';
  if (target.kind === 'post') return `#post/${target.id}`;
  if (target.kind === 'dm') return `#dm/${target.id}`;
  if (target.kind === 'user') return `#profile/${target.id}`;
  if (target.kind === 'route' && typeof target.value === 'string' && target.value.startsWith('#')) {
    return target.value;
  }
  return fallbackFromId != null ? `#profile/${fallbackFromId}` : '#notifications';
}

function getNotificationActorLabel(notification) {
  const actor = notification?.from;
  if (actor?.name) return `@${actor.name}`;
  const actorId = actor?.id ?? notification?.fromUserId ?? notification?.from_user_id;
  return Number.isInteger(Number(actorId)) ? `@#${String(actorId).padStart(4, '0')}` : '誰か';
}

function getNotificationText(notification) {
  if (typeof notification?.message === 'string' && notification.message.trim()) {
    return notification.message.trim();
  }
  const actor = getNotificationActorLabel(notification);
  switch (notification?.type) {
    case 'post': return `${actor} さんが新しいポストを投稿しました。`;
    case 'reply': return `${actor} さんがあなたのポストに返信しました。`;
    case 'quote': return `${actor} さんがあなたのポストを引用しました。`;
    case 'repost': return `${actor} さんがあなたのポストをリポストしました。`;
    case 'mention': return `${actor} さんがあなたをメンションしました。`;
    case 'like': return `${actor} さんがあなたのポストにいいねしました。`;
    case 'star': return `${actor} さんがあなたのポストをお気に入りに追加しました。`;
    case 'follow': return `${actor} さんがあなたをフォローしました。`;
    case 'dm_invite': return `${actor} さんがあなたをDMに招待しました。`;
    case 'dm_removed': return `${actor} さんによってDMから削除されました。`;
    case 'dm_host_transfer': return `${actor} さんからDMの管理者権限を受け取りました。`;
    case 'group_invite': return `${actor} さんからグループ招待が届いています。`;
    case 'group_join_request': return `${actor} さんからグループへの参加申請が届いています。`;
    case 'group_announcement': return `${actor} さんがグループアナウンスを投稿しました。`;
    case 'admin_notice': return `${actor} さんからお知らせがあります。`;
    case 'auto_moderation': return '自動モデレーションによりポストの公開範囲が変更されました。';
    case 'login_approval': return '不明な場所からのログイン承認が必要です。';
    case 'moderation_assignment': return '新しい報告があなたに割り当てられました。';
    case 'moderation_action_taken': return 'あなたが報告したコンテンツは、審査により不適切であると判定されました。コミュニティの健全化へのご協力に感謝します。';
    case 'moderation_no_action': return 'あなたが報告したコンテンツは、審査により適切だと判定されたため対応されません。';
    case 'appeal_approved': return '異議申し立てが承認され、アカウントの凍結が解除されました。';
    case 'appeal_rejected': return '異議申し立ては審査の結果、承認されませんでした。';
    case 'verification_approved': return '認証申請が承認されました。プロフィールに認証バッジが表示されます。';
    case 'verification_rejected': return '認証申請は審査の結果、承認されませんでした。';
    default: return '新しい通知があります。';
  }
}

function normalizeNotificationRecord(notification) {
  if (!notification || typeof notification !== 'object') return null;
  const type = NOTIFICATION_TYPES.has(notification.type) ? notification.type : 'admin_notice';
  const fromUserId = notification.fromUserId ?? notification.from_user_id ?? null;
  return {
    id: Number(notification.id),
    type,
    fromUserId: Number.isInteger(Number(fromUserId)) ? Number(fromUserId) : null,
    target: normalizeTarget(notification.target, {
      postId: notification.postId ?? notification.post_id,
      open: notification.open,
    }),
    read: Boolean(notification.read),
    clicked: Boolean(notification.clicked),
    message: typeof notification.message === 'string' ? notification.message : null,
    createdAt: notification.createdAt ?? notification.created_at ?? null,
  };
}

module.exports = {
  NOTIFICATION_TYPES,
  TARGET_KINDS,
  normalizeTarget,
  getNotificationTargetHash,
  getNotificationText,
  normalizeNotificationRecord,
};
