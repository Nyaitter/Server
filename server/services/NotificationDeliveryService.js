const {
	hasBlockRelationship,
	normalizeUserId,
} = require('../utils/blockRelationship');

/**
 * 送信者と通知先の間にブロック関係がなく、検索除外中の送信者を
 * 通知先がフォローしている場合に限り通知を作成する。
 * fromUserId を持たないシステム通知は従来どおり作成する。
 */
async function createNotificationIfAllowed(db, notificationData) {
	const recipientId = normalizeUserId(notificationData?.userId);
	const senderId = normalizeUserId(notificationData?.fromUserId);
	if (recipientId != null && senderId != null && recipientId !== senderId) {
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
	return db.createNotification(notificationData);
}

module.exports = {
	createNotificationIfAllowed,
};
