const api = require('../utils/ApiRegistry');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');
const config = require('../config');
const { NOTIFICATION_TYPES, normalizeTarget } = require('../utils/notification');
const { getPublicUrl } = require('../utils/nyaitterAddress');
const {
	serializeNotification,
	serializeNotifications,
} = require('../utils/serialize');
const {
	createNotificationIfAllowed,
} = require('../services/NotificationDeliveryService');

const router = api.createRouter({
	tag: 'notifications',
	basePath: '/notifications',
	description: '通知 API',
});

const notificationLimiter = createRateLimiter(config.rateLimit.notification);

// サーバー側イベントで自動生成される通知タイプ。クライアントからは作成できない。
const SERVER_GENERATED_TYPES = new Set(['post', 'like', 'star', 'follow', 'repost', 'reply', 'login_approval', 'group_invite', 'group_join_request', 'group_announcement']);

async function validateClientNotification(db, senderId, recipientId, type, target) {
	if (SERVER_GENERATED_TYPES.has(type)) {
		return { error: 'この通知タイプは送信できません。' };
	}
	if (!target || !['post', 'dm'].includes(target.kind)) {
		return { error: 'この通知タイプには投稿またはDMの対象が必要です。' };
	}

	if (type === 'mention' || type === 'repost') {
		if (target.kind !== 'post') {
			return { error: '投稿通知の対象は投稿を指定してください。' };
		}
		const post = await db.getPostById(target.id);
		if (!post || Number(post.userId) !== Number(senderId)) {
			return { error: '対象の投稿が見つからないか、自分の投稿ではありません。' };
		}
		if (type === 'repost') {
			const reposts = db.getReposts ? await db.getReposts(senderId) : [];
			const reposted = reposts.some((row) => {
				const ref = Number(row.repostOf ?? row.repost_to ?? row.repostTo ?? row.post_id ?? row.postId);
				return ref === Number(target.id);
			});
			if (!reposted) {
				return { error: 'この投稿をリポストした実績がありません。' };
			}
			return null;
		}
		if (type === 'mention' && !String(post.content || '').includes(`@${recipientId}`)) {
			return { error: '投稿本文にメンションが含まれていません。' };
		}
		return null;
	}

	if (target.kind !== 'dm') {
		return { error: 'この通知タイプにはDMの対象が必要です。' };
	}
	const dm = await db.getGroupDm(target.id);
	if (!dm) {
		return { error: 'DMが見つかりません。' };
	}
	const members = (dm.member || []).map(Number);
	const isMember = (id) => members.includes(Number(id));

	if (type === 'dm_invite') {
		if (!isMember(senderId) || !isMember(recipientId)) {
			return { error: 'DM招待通知はメンバー同士のみ送信できます。' };
		}
		return null;
	}
	if (type === 'dm_removed') {
		if (Number(dm.host_id) !== Number(senderId) || isMember(recipientId)) {
			return { error: 'DM退会通知はホストが退会メンバーにのみ送信できます。' };
		}
		return null;
	}
	if (type === 'dm_host_transfer') {
		if (Number(dm.host_id) !== Number(recipientId) || !isMember(senderId)) {
			return { error: '権限譲渡通知は新しいホストにのみ送信できます。' };
		}
		return null;
	}

	return { error: 'この通知タイプは送信できません。' };
}

function getDbAdapter(req) {
	return req.app.locals.dbAdapter;
}

async function publishNotificationUnreadCount(req, userId) {
	const realtime = req.app.locals.realtime;
	if (!realtime) return;
	try {
		await realtime.publishNotificationUnreadCount(userId, getDbAdapter(req));
	} catch (error) {
		console.warn('[notifications] unread realtime delivery failed:', error.message);
	}
}

async function publishNewNotification(req, userId, notification) {
	const realtime = req.app.locals.realtime;
	if (realtime) {
		try {
			await realtime.publishNewNotification(userId, notification, getDbAdapter(req));
		} catch (error) {
			console.warn('[notifications] new-notification realtime delivery failed:', error.message);
		}
	}

	const pushService = req.app.locals.pushNotificationService;
	if (pushService?.enabled) {
		void pushService.sendNotificationToUser(userId, notification, {
			publicUrl: getPublicUrl(req),
		}).catch((error) => {
			console.warn('[notifications] new-notification push delivery failed:', error.message);
		});
	}
}

router.post({
	path: '/',
	summary: '通知の新規作成・送信',
	auth: 'required',
}, requireAuth, notificationLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const senderId = req.user.id;

	const { recipient_id, type, target } = req.body || {};
	const recipientId = parseInt(recipient_id, 10);

	if (!Number.isInteger(recipientId) || recipientId <= 0) {
		return res.status(400).json({ error: 'recipient_id must be a positive integer' });
	}
	if (!NOTIFICATION_TYPES.includes(type)) {
		return res.status(400).json({ error: `Invalid notification type: ${type}` });
	}

	const normalizedTarget = normalizeTarget(target);
	if (req.user.role !== 'admin') {
		const validation = await validateClientNotification(db, senderId, recipientId, type, normalizedTarget);
		if (validation?.error) {
			return res.status(403).json({ error: validation.error });
		}
	}

	try {
		const notification = await createNotificationIfAllowed(db, {
			userId: recipientId,
			type,
			fromUserId: senderId,
			target: normalizedTarget,
		});
		if (!notification) {
			return res.json({ success: true, notification: null });
		}
		const serializedNotification = await serializeNotification(db, notification);
		await publishNewNotification(req, recipientId, serializedNotification);
		res.json({ success: true, notification: serializedNotification });
	} catch (err) {
		console.error('[notifications] create error:', err);
		res.status(500).json({ error: '通知の作成に失敗しました' });
	}
});

router.get({
	path: '/',
	summary: '通知一覧の取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
	const offset = parseInt(req.query.offset, 10) || 0;
	const since = req.query.since ? new Date(req.query.since) : null;

	try {
		let notifications = await db.getNotifications(userId, limit, offset);

		if (since) {
			notifications = notifications.filter(n => new Date(n.created_at || n.createdAt) > since);
		}

		const [serializedNotifications, unreadCount] = await Promise.all([
			serializeNotifications(db, notifications),
			db.getUnreadNotificationCount(userId),
		]);

		res.json({
			notifications: serializedNotifications.filter(Boolean),
			notification_unread_count: unreadCount,
		});
	} catch (err) {
		console.error('[notifications] list error:', err);
		res.status(500).json({ error: '通知の取得に失敗しました' });
	}
});

router.get({
	path: '/unread',
	summary: '未読通知件数の取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;

	try {
		const count = await db.getUnreadNotificationCount(userId);
		res.json({ unread_count: count });
	} catch (err) {
		console.error('[notifications] unread error:', err);
		res.status(500).json({ error: '未読数の取得に失敗しました' });
	}
});

router.put({
	path: '/:id/read',
	summary: '個別通知の既読化',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const notificationId = parseInt(req.params.id, 10);
	const userId = req.user.id;

	if (!Number.isInteger(notificationId)) {
		return res.status(400).json({ error: 'Invalid notification id' });
	}

	try {
		const notification = await db.getNotificationById
			? await db.getNotificationById(notificationId)
			: null;
		if (!notification) return res.status(404).json({ error: 'Notification not found' });
		if (Number(notification.userId ?? notification.user_id) !== Number(userId)) {
			return res.status(403).json({ error: 'Forbidden' });
		}
		await db.markNotificationAsRead(notificationId);
		const unreadCount = await db.getUnreadNotificationCount(userId);
		await publishNotificationUnreadCount(req, userId);
		res.json({ success: true, notification_unread_count: unreadCount });
	} catch (err) {
		console.error('[notifications] mark read error:', err);
		res.status(500).json({ error: '既読処理に失敗しました' });
	}
});

router.put({
	path: '/:id/clicked',
	summary: '個別通知のクリック済みマーク',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const notificationId = parseInt(req.params.id, 10);
	const userId = req.user.id;

	if (!Number.isInteger(notificationId)) {
		return res.status(400).json({ error: 'Invalid notification id' });
	}

	try {
		const notification = await db.getNotificationById
			? await db.getNotificationById(notificationId)
			: null;
		if (!notification) return res.status(404).json({ error: 'Notification not found' });
		if (Number(notification.userId ?? notification.user_id) !== Number(userId)) {
			return res.status(403).json({ error: 'Forbidden' });
		}
		if (typeof db.markNotificationAsRead === 'function') {
			await db.markNotificationAsRead(notificationId);
		}
		await db.markNotificationAsClicked(notificationId);
		const unreadCount = await db.getUnreadNotificationCount(userId);
		await publishNotificationUnreadCount(req, userId);
		res.json({ success: true, read: true, clicked: true, notification_unread_count: unreadCount });
	} catch (err) {
		console.error('[notifications] mark clicked error:', err);
		res.status(500).json({ error: 'クリック状態の更新に失敗しました' });
	}
});

router.delete({
	path: '/:id',
	summary: '個別通知の削除',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const notificationId = parseInt(req.params.id, 10);
	const userId = req.user.id;

	if (!Number.isInteger(notificationId)) {
		return res.status(400).json({ error: 'Invalid notification id' });
	}

	try {
		const notification = await db.getNotificationById
			? await db.getNotificationById(notificationId)
			: null;
		if (!notification) {
			return res.status(404).json({ error: 'Notification not found' });
		}
		if (Number(notification.userId) !== Number(userId)) {
			return res.status(403).json({ error: 'Forbidden' });
		}
		await db.deleteNotification(notificationId);
		await publishNotificationUnreadCount(req, userId);
		res.json({ success: true });
	} catch (err) {
		console.error('[notifications] delete error:', err);
		res.status(500).json({ error: '通知の削除に失敗しました' });
	}
});

router.put({
	path: '/read-all',
	summary: 'すべての通知の一括既読化',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;

	try {
		await db.markAllNotificationsAsRead(userId);
		const unreadCount = await db.getUnreadNotificationCount(userId);
		await publishNotificationUnreadCount(req, userId);
		res.json({ success: true, notification_unread_count: unreadCount });
	} catch (err) {
		console.error('[notifications] mark all read error:', err);
		res.status(500).json({ error: '未読数のリセットに失敗しました' });
	}
});

router.put({
	path: '/click-all',
	summary: 'すべての通知の一括クリック済み化',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;

	try {
		await db.markAllNotificationsAsClicked(userId);
		const unreadCount = await db.getUnreadNotificationCount(userId);
		await publishNotificationUnreadCount(req, userId);
		res.json({ success: true, notification_unread_count: unreadCount });
	} catch (err) {
		console.error('[notifications] mark all clicked error:', err);
		res.status(500).json({ error: '一括クリック済み処理に失敗しました' });
	}
});

module.exports = router;