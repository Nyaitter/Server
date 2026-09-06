'use strict';

const { normalizeBlockList } = require('../utils/blockList');
const { hasBlockRelationship } = require('../utils/blockRelationship');

function getDmUnreadCount(dm, userId) {
	return Number(
		dm?.unread?.[userId] ??
		dm?.unread?.[String(userId)] ??
		dm?.unread_count ??
		0,
	);
}

function isDmAccepted(dm, userId) {
	const accepted = Array.isArray(dm?.accepted)
		? dm.accepted
		: (Array.isArray(dm?.unread?._accepted) ? dm.unread._accepted : dm?.member || []);
	return accepted.map(Number).includes(Number(userId));
}

function blocksUser(user, otherUserId) {
	if (!user) return false;
	return normalizeBlockList(user.block, user.id).includes(Number(otherUserId));
}

async function hasBlockedDmMember(db, userId, memberIds) {
	for (const memberId of new Set((memberIds || []).map(Number))) {
		if (memberId === Number(userId)) continue;
		if (await hasBlockRelationship(db, userId, memberId)) return true;
	}
	return false;
}

async function getUsersByIdsForDmVisibility(db, ids) {
	const normalizedIds = [...new Set((ids || [])
		.map(Number)
		.filter(Number.isInteger))];
	if (normalizedIds.length === 0) return new Map();

	let users = [];
	if (typeof db.getUsersByIds === 'function') {
		try {
			users = await db.getUsersByIds(normalizedIds);
		} catch (error) {
			console.warn('[dmVisibility] batch member lookup fallback:', error.message);
		}
	}
	if (!Array.isArray(users) || users.length === 0) {
		if (typeof db.getUserById !== 'function') return new Map();
		users = await Promise.all(normalizedIds.map((id) => db.getUserById(id)));
	}
	return new Map(users.filter(Boolean).map((user) => [Number(user.id), user]));
}

/**
 * 閲覧者に表示できるDMの未読合計を返す。
 * ブロック関係を含む会話は、相手メッセージと存在を推測できる未読数の双方を除外する。
 * 会話をまたいでメンバーを一括取得するため、会話数や参加者数に比例してDB/Worker往復しない。
 */
async function getVisibleDmUnreadCount(db, userId, { viewer: knownViewer = null } = {}) {
	const getVisibilityDms = typeof db?.getGroupDmVisibilityDataForUser === 'function'
		? db.getGroupDmVisibilityDataForUser.bind(db)
		: typeof db?.getGroupDmsForUser === 'function'
			? db.getGroupDmsForUser.bind(db)
			: null;
	if (!getVisibilityDms) {
		return db?.getGroupDmUnreadTotal
			? db.getGroupDmUnreadTotal(userId)
			: 0;
	}

	const normalizedUserId = Number(userId);
	const dms = await getVisibilityDms(normalizedUserId);
	if (!Array.isArray(dms) || dms.length === 0) return 0;

	// 未読が存在するDMのみを対象とする。未読合計が0の場合は追加のユーザー取得をスキップして即座に0を返す。
	const dmsWithUnread = dms.filter((dm) =>
		isDmAccepted(dm, normalizedUserId) && getDmUnreadCount(dm, normalizedUserId) > 0,
	);
	if (dmsWithUnread.length === 0) return 0;

	const memberIds = new Set();
	for (const dm of dmsWithUnread) {
		for (const memberId of dm?.member || []) {
			const normalizedMemberId = Number(memberId);
			if (Number.isInteger(normalizedMemberId) && normalizedMemberId !== normalizedUserId) {
				memberIds.add(normalizedMemberId);
			}
		}
	}

	const [viewer, membersById] = await Promise.all([
		knownViewer || (typeof db.getUserById === 'function' ? db.getUserById(normalizedUserId) : null),
		getUsersByIdsForDmVisibility(db, [...memberIds]),
	]);

	const viewerBlockedIds = new Set(normalizeBlockList(viewer?.block, viewer?.id));
	const memberBlocksViewer = new Map();
	let unreadCount = 0;
	for (const dm of dmsWithUnread) {
		const hasBlockedMember = (dm?.member || []).some((memberId) => {
			const normalizedMemberId = Number(memberId);
			if (!Number.isInteger(normalizedMemberId) || normalizedMemberId === normalizedUserId) return false;
			if (viewerBlockedIds.has(normalizedMemberId)) return true;

			if (!memberBlocksViewer.has(normalizedMemberId)) {
				const member = membersById.get(normalizedMemberId) || null;
				memberBlocksViewer.set(
					normalizedMemberId,
					new Set(normalizeBlockList(member?.block, member?.id)).has(normalizedUserId),
				);
			}
			return memberBlocksViewer.get(normalizedMemberId);
		});
		if (hasBlockedMember) continue;
		unreadCount += getDmUnreadCount(dm, normalizedUserId);
	}
	return unreadCount;
}

module.exports = {
	blocksUser,
	getDmUnreadCount,
	hasBlockedDmMember,
	getVisibleDmUnreadCount,
};
