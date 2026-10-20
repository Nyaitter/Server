const {
	hasBlockRelationship,
	normalizeUserId,
} = require('../utils/blockRelationship');
const { serializeNotification } = require('../utils/serialize');

// 通知の配信先（リアルタイム接続・Web Push）は起動時に一度だけ設定する。
// これにより通知の作成箇所は配信を意識せず、作成だけを行えばよい。
let deliveryContext = null;

function configureNotificationDelivery({ realtime = null, pushService = null } = {}) {
	deliveryContext = { realtime, pushService };
}

/**
 * 作成済みの通知をリアルタイム配信し、Web Push を送る。
 * createNotificationIfAllowed から自動で呼ばれるため、通常は直接呼ぶ必要はない。
 */
async function publishNotification(db, userId, notification) {
	if (!notification || !deliveryContext) return;
	const recipientId = normalizeUserId(userId ?? notification.userId);
	if (recipientId == null) return;

	let structured;
	try {
		structured = await serializeNotification(db, notification);
	} catch (error) {
		console.warn('[notifications] notification serialization failed:', error.message);
		return;
	}
	if (!structured) return;

	const { realtime, pushService } = deliveryContext;
	if (realtime?.publishNewNotification) {
		try {
			await realtime.publishNewNotification(recipientId, structured, db);
		} catch (error) {
			console.warn('[notifications] realtime delivery failed:', error.message);
		}
	}
	if (pushService?.enabled) {
		void pushService.sendNotificationToUser(recipientId, structured)
			.catch((error) => console.warn('[notifications] push delivery failed:', error.message));
	}
}

/**
 * 送信者と通知先の間にブロック関係がなく、検索除外中の送信者を
 * 通知先がフォローしている場合に限り通知を作成し、そのまま配信する。
 * fromUserId を持たないシステム通知は従来どおり作成する。
 * bypassBlockCheck は運営からの通知など、ブロック関係に関わらず必ず届ける場合に使う。
 */
async function createNotificationIfAllowed(db, notificationData, { bypassBlockCheck = false } = {}) {
	const recipientId = normalizeUserId(notificationData?.userId);
	const senderId = normalizeUserId(notificationData?.fromUserId);
	if (!bypassBlockCheck && recipientId != null && senderId != null && recipientId !== senderId) {
		const [blocked, sender] = await Promise.all([
			hasBlockRelationship(db, recipientId, senderId),
			db.getUserById(senderId),
		]);
		if (blocked) {
			return null;
		}

		if (sender?.shadow && !(await db.isFollowing(recipientId, senderId))) {
			return null;
		}
	}
	const notification = await db.createNotification(notificationData);
	await publishNotification(db, recipientId, notification);
	return notification;
}

module.exports = {
	createNotificationIfAllowed,
	publishNotification,
	configureNotificationDelivery,
};
