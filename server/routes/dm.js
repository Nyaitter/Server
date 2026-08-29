const api = require('../utils/ApiRegistry');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { hasBlockRelationship } = require('../utils/blockRelationship');
const { getVisibleDmUnreadCount } = require('../services/DmVisibilityService');
const config = require('../config');
const { isWithinRange, describeIntegerRange } = require('../utils/settingFormats');

const router = api.createRouter({
	tag: 'dm',
	basePath: '/dm',
	description: 'ダイレクトメッセージAPI',
});

const { createRateLimiter } = require('../middleware/rateLimit');
const dmSendLimiter = createRateLimiter(config.rateLimit.dmSend);

function getDbAdapter(req) {
	return req.app.locals.dbAdapter;
}

function lengthError(label, range) {
	return `${label} must be ${describeIntegerRange(range)} characters`;
}

async function publishDmMessage(req, userIds, dmId, message, sender = null) {
	const realtime = req.app.locals.realtime;
	if (!realtime) return;

	const db = getDbAdapter(req);
	const senderId = Number(message?.userid);
	for (const userId of new Set((userIds || []).map(Number))) {
		if (!Number.isInteger(userId) || userId < 0) continue;
		if (
			Number.isInteger(senderId) &&
			userId !== senderId &&
			await hasBlockRelationship(db, userId, senderId)
		) {
			continue;
		}
		try {
			realtime.publishDmMessage(userId, dmId, message, sender);
		} catch (error) {
			console.warn('[dm] message realtime delivery failed:', error.message);
		}
	}
}

async function publishDmUnreadCounts(req, userIds, dmId = null) {
	const realtime = req.app.locals.realtime;
	if (!realtime) return;

	for (const userId of new Set((userIds || []).map(Number))) {
		if (!Number.isInteger(userId) || userId < 0) continue;
		try {
			await realtime.publishDmUnreadCount(userId, getDbAdapter(req), dmId);
		} catch (error) {
			console.warn('[dm] unread realtime delivery failed:', error.message);
		}
	}
}

async function publishDmReadEvent(req, userIds, dmId, readerId) {
	const realtime = req.app.locals.realtime;
	if (!realtime) return;

	for (const userId of new Set((userIds || []).map(Number))) {
		if (!Number.isInteger(userId) || userId < 0) continue;
		try {
			if (typeof realtime.publishDmRead === 'function') {
				realtime.publishDmRead(userId, dmId, readerId);
			} else if (typeof realtime.sendToUser === 'function') {
				realtime.sendToUser(userId, {
					type: 'dm_read',
					dm_id: String(dmId),
					reader_id: Number(readerId),
				});
			}
		} catch (error) {
			console.warn('[dm] read realtime delivery failed:', error.message);
		}
	}
}

function serializeDmMember(user) {
	return {
		id: user.id,
		name: user.name || '',
		scid: user.scid || null,
		icon_data: user.icon_data || null,
	};
}

async function buildDmPayload(db, dms, userId, { includePosts = true } = {}) {
	const records = await Promise.all(
		(dms || []).map((dm) => serializeGroupDm(db, dm, userId, { includePosts })),
	);
	const memberIds = [...new Set(records.flatMap((dm) => dm.member || []))];
	let users = [];
	if (memberIds.length > 0) {
		try {
			users = db.getUsersByIds
				? await db.getUsersByIds(memberIds)
				: await Promise.all(memberIds.map((id) => db.getUserById(id)));
		} catch (_) {
			users = [];
		}
	}
	return {
		dm: records,
		members: (users || []).filter(Boolean).map(serializeDmMember),
		unread_total: records.reduce((sum, dm) => sum + Number(dm.unread_count || 0), 0),
	};
}

function normalizeClientMessage(message, userId) {
	if (!message || typeof message !== 'object') {
		throw new Error('message is required');
	}
	if (message.type === 'system') {
		throw new Error('System messages cannot be sent by users');
	}

	const content = String(message.content || '').trim();

	// E2E暗号化メッセージ
	if (message.e2e && typeof message.e2e === 'object') {
		if (!config.dm.e2eEnabled) {
			throw new Error('DM E2E encryption is temporarily disabled');
		}
		if (content) {
			throw new Error('E2E messages must not contain plaintext content');
		}
		const e2e = message.e2e;
		if (e2e.v !== 1) {
			throw new Error('Unsupported E2E format');
		}
			if (
				typeof e2e.eph !== 'string' ||
				!isWithinRange(e2e.eph.length, config.limits.dmE2eEphemeralKeyLength)
			) {
				throw new Error(lengthError('e2e.eph', config.limits.dmE2eEphemeralKeyLength));
			}
		if (!e2e.ct || typeof e2e.ct !== 'object') {
			throw new Error('e2e.ct is required');
		}
		const ctEntries = Object.entries(e2e.ct);
		if (ctEntries.length === 0) {
			throw new Error('e2e.ct is empty');
		}
		let totalDataLength = 0;
		for (const [recipientId, entry] of ctEntries) {
			const numericId = Number(recipientId);
			if (!Number.isInteger(numericId) || numericId < 0) {
				throw new Error('Invalid E2E recipient id');
			}
			if (!entry || typeof entry !== 'object') {
				throw new Error('Invalid E2E ciphertext entry');
			}
			if (
				typeof entry.iv !== 'string' || entry.iv.length === 0 ||
				typeof entry.data !== 'string' || entry.data.length === 0
			) {
				throw new Error('Invalid E2E ciphertext');
			}
				if (!isWithinRange(entry.data.length, config.limits.dmE2eCiphertextLength)) {
					throw new Error(lengthError('E2E ciphertext', config.limits.dmE2eCiphertextLength));
				}
			totalDataLength += entry.data.length;
		}
			if (!isWithinRange(totalDataLength, config.limits.dmE2ePayloadLength)) {
				throw new Error(lengthError('E2E payload', config.limits.dmE2ePayloadLength));
			}
		return {
			id: crypto.randomUUID(),
			created_at: new Date().toISOString(),
			type: 'user',
			userid: userId,
			content: '',
			e2e,
			...(Array.isArray(message.attachments) ? { attachments: message.attachments } : {}),
		};
	}

	if (content && !isWithinRange(content.length, config.limits.dmContentLength)) {
		throw new Error(lengthError('DM content', config.limits.dmContentLength));
	}
	if (!content && (!Array.isArray(message.attachments) || message.attachments.length === 0)) {
		throw new Error('Message content or attachments are required');
	}

	return {
		id: crypto.randomUUID(),
		created_at: new Date().toISOString(),
		type: 'user',
		userid: userId,
		content,
		...(Array.isArray(message.attachments) ? { attachments: message.attachments } : {}),
	};
}

function validateMessageHistoryUpdate(existingMessages, requestedMessages, userId) {
	if (!Array.isArray(requestedMessages)) {
		throw new Error('post must be an array');
	}

	const existingById = new Map(existingMessages.map((message) => [message.id, message]));
	const requestedIds = new Set();

	for (const message of requestedMessages) {
		if (!message || typeof message.id !== 'string' || requestedIds.has(message.id)) {
			throw new Error('Invalid message history');
		}
		requestedIds.add(message.id);
		const original = existingById.get(message.id);
		if (!original) {
			throw new Error('New messages must use the send endpoint');
		}
		if (original.userid !== userId) {
			if (JSON.stringify(message) !== JSON.stringify(original)) {
				throw new Error('You can only edit your own messages');
			}
			continue;
		}
		if (message.userid !== userId || message.type !== 'user') {
			throw new Error('You can only edit your own messages');
		}
		const content = String(message.content || '').trim();
		if (content && !message.e2e && !isWithinRange(content.length, config.limits.dmContentLength)) {
			throw new Error(lengthError('DM content', config.limits.dmContentLength));
		}
	}

	for (const original of existingMessages) {
		if (!requestedIds.has(original.id) && original.userid !== userId) {
			throw new Error('You can only delete your own messages');
		}
	}
}

async function getBlockedDmMemberIds(db, userId, memberIds) {
	const blockedMemberIds = new Set();
	for (const memberId of new Set((memberIds || []).map(Number))) {
		if (memberId === Number(userId)) continue;
		if (await hasBlockRelationship(db, userId, memberId)) {
			blockedMemberIds.add(memberId);
		}
	}
	return blockedMemberIds;
}

async function hasBlockedDmMemberPair(db, memberIds) {
	const uniqueMemberIds = [...new Set((memberIds || []).map(Number))];
	for (let index = 0; index < uniqueMemberIds.length; index += 1) {
		for (let otherIndex = index + 1; otherIndex < uniqueMemberIds.length; otherIndex += 1) {
			if (await hasBlockRelationship(db, uniqueMemberIds[index], uniqueMemberIds[otherIndex])) {
				return true;
			}
		}
	}
	return false;
}

async function serializeGroupDm(db, dm, userId, { includePosts = true } = {}) {
	const blockedMemberIds = await getBlockedDmMemberIds(db, userId, dm.member || []);
	const rawMessages = dm.post ? dm.post.slice() : [];
	const unreadMap = dm.unread || {};
	const totalRawCount = rawMessages.length;

	const messages = rawMessages
		.filter((message) => !blockedMemberIds.has(Number(message?.userid)))
		.map((message, index) => {
			const { time, createdAt, ...rest } = message || {};
			let readCount = typeof message.read_count === 'number' ? message.read_count : 0;
			if (message.read_count === undefined) {
				const senderId = Number(message.userid);
				const recipients = (dm.member || []).map(Number).filter((id) => id !== senderId);
				let readers = 0;
				for (const recipientId of recipients) {
					const unreadForRecipient = Number(unreadMap[recipientId] ?? unreadMap[String(recipientId)] ?? 0);
					const unreadStartIndex = Math.max(0, totalRawCount - unreadForRecipient);
					if (index < unreadStartIndex) {
						readers += 1;
					}
				}
				readCount = readers;
			}
			return {
				...rest,
				created_at: message?.created_at || createdAt || time || null,
				read_count: readCount,
			};
		});
	const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null;
	const unreadCount = Number(
		dm.unread?.[userId] ?? dm.unread?.[String(userId)] ?? dm.unread_count ?? 0,
	);
	const acceptedList = Array.isArray(dm.accepted)
		? dm.accepted.map(Number)
		: (Array.isArray(dm.unread?._accepted) ? dm.unread._accepted.map(Number) : (dm.member || []).map(Number));
	const isPending = !acceptedList.includes(Number(userId));

	return {
		id: dm.id,
		title: dm.title || '',
		member: dm.member.slice(),
		accepted: acceptedList,
		is_pending: isPending,
		host_id: dm.host_id,
		created_at: dm.created_at || dm.createdAt || dm.time || null,
		post: includePosts ? messages : [],
		message_count: messages.length,
		latest_message: includePosts ? null : (latestMessage ? {
			id: latestMessage.id,
			created_at: latestMessage.created_at,
			type: latestMessage.type,
			userid: latestMessage.userid || null,
			content: latestMessage.e2e
				? '🔒 暗号化されたメッセージ'
				: String(latestMessage.content || '').slice(0, 200),
		} : null),
		// ブロックした相手の未読数から、メッセージの存在を推測できないようにする。
		unread_count: blockedMemberIds.size > 0 ? 0 : unreadCount,
	};
}

router.get({
	path: '/',
	summary: 'DMグループ一覧の取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
	const offset = parseInt(req.query.offset, 10) || 0;

	try {
		const dms = await db.getGroupDmsForUser(userId, { limit, offset });
		const payload = await buildDmPayload(db, dms, userId, { includePosts: false });
		res.json(payload);
	} catch (err) {
		console.error('[dm] list error:', err);
		res.status(500).json({ error: 'DMの取得に失敗しました' });
	}
});

router.get({
	path: '/unread',
	summary: 'DM全体の未読件数取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;

	try {
		const count = await getVisibleDmUnreadCount(db, userId);
		res.json({ unread_count: count });
	} catch (err) {
		console.error('[dm] unread error:', err);
		res.status(500).json({ error: '未読数の取得に失敗しました' });
	}
});

router.get({
	path: '/unread-counts',
	summary: 'DMグループごとの未読件数マップ取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;

	try {
		const dms = await db.getGroupDmsForUser(userId);
		const payload = await buildDmPayload(db, dms, userId, { includePosts: false });
		const unreadByDm = {};
		for (const d of payload.dm) {
			unreadByDm[d.id] = d.unread_count || 0;
		}
		res.json({
			unread_total: payload.unread_total,
			unread_by_dm: unreadByDm,
		});
	} catch (err) {
		console.error('[dm] unread-counts error:', err);
		res.status(500).json({ error: '未読サマリーの取得に失敗しました' });
	}
});

router.get({
	path: '/find',
	summary: '指定ユーザーとの1対1 DMグループの検索',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const currentUserId = Number(req.user.id);
	const otherUserId = Number(req.query.user_id);

	if (!Number.isInteger(otherUserId) || otherUserId < 0) {
		return res.status(400).json({ error: '有効なuser_idを指定してください' });
	}

	try {
		const directDm = await findDirectDmBetweenUsers(db, currentUserId, otherUserId);
		if (!directDm) {
			return res.json({ dm: null });
		}
		res.json({ dm: await serializeGroupDm(db, directDm, currentUserId) });
	} catch (err) {
		console.error('[dm] find direct dm error:', err);
		res.status(500).json({ error: 'DMの検索に失敗しました' });
	}
});

router.get({
	path: '/keys',
	summary: 'DMメンバーのE2E公開鍵一覧取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	if (!config.dm.e2eEnabled) {
		return res.status(410).json({ error: 'DM E2E encryption is temporarily disabled' });
	}
	const db = getDbAdapter(req);

	try {
		const rawIds = String(req.query.user_ids || '')
			.split(',')
			.map((s) => parseInt(s.trim(), 10))
			.filter((n) => Number.isInteger(n) && n >= 0);
		if (rawIds.length === 0) {
			return res.json({ keys: {} });
		}
		const rows = await db.getDmPublicKeys(rawIds);
		const keys = {};
		for (const row of rows) {
			keys[String(row.user_id)] = row.public_key;
		}
		res.json({ keys });
	} catch (err) {
		console.error('[dm] keys error:', err);
		res.status(500).json({ error: '公開鍵の取得に失敗しました' });
	}
});

router.post({
	path: '/keys',
	summary: '自分のE2E暗号化公開鍵の登録・更新',
	auth: 'required',
}, requireAuth, async (req, res) => {
	if (!config.dm.e2eEnabled) {
		return res.status(410).json({ error: 'DM E2E encryption is temporarily disabled' });
	}
	const db = getDbAdapter(req);
	const { public_key } = req.body || {};

	if (typeof public_key !== 'string' || public_key.length < 10 || public_key.length > 2048) {
		return res.status(400).json({ error: 'public_key is required' });
	}

	try {
		await db.setDmPublicKey(req.user.id, public_key);
		res.json({ success: true });
	} catch (err) {
		console.error('[dm] set keys error:', err);
		res.status(500).json({ error: '公開鍵の登録に失敗しました' });
	}
});

router.post({
	path: '/',
	summary: '新規DMグループの作成',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const { member, title } = req.body || {};

	try {
		if (!Array.isArray(member) || member.length === 0) {
			return res.status(400).json({ error: 'member is required' });
		}

		const memberIds = Array.from(new Set(member)).map(Number);
		if (memberIds.some((id) => !Number.isInteger(id) || id < 0)) {
			return res.status(400).json({ error: 'Invalid member ids' });
		}
		if (!memberIds.includes(userId)) {
			memberIds.unshift(userId);
		}

		const membersToValidate = memberIds.filter((id) => id !== userId);
		const targetUsers = [];
		for (const memberId of membersToValidate) {
			const user = await db.getUserById(memberId);
			if (!user) {
				return res
					.status(404)
					.json({ error: `User ${memberId} not found` });
			}
			const invitationPolicy = user.settings?.dm_invitation || user.settings?.dm_permission || 'require_approval';
			if (invitationPolicy === 'deny' || invitationPolicy === 'reject') {
				return res.status(403).json({
					error: `${user.name || 'ユーザー'}はDMの招待を受け付けていません`,
				});
			}
			targetUsers.push(user);
		}
		if (await hasBlockedDmMemberPair(db, memberIds)) {
			return res.status(403).json({
				error: 'ブロック関係のユーザーとDMを作成できません',
			});
		}

		const existing = await db.findGroupDmByMembers(memberIds);
		if (existing) {
			return res.json({
				dm: await serializeGroupDm(db, existing, userId),
				created: false,
			});
		}

		const acceptedMembers = [userId];
		for (const targetUser of targetUsers) {
			const memberId = targetUser.id;
			const invitationPolicy = targetUser.settings?.dm_invitation || targetUser.settings?.dm_permission || 'require_approval';
			if (invitationPolicy === 'always' || invitationPolicy === 'allow') {
				acceptedMembers.push(memberId);
			} else if (typeof db.isFollowing === 'function' && await db.isFollowing(memberId, userId)) {
				acceptedMembers.push(memberId);
			}
		}

		const dm = await db.createGroupDm({
			hostId: userId,
			member: memberIds,
			accepted: acceptedMembers,
			title: typeof title === 'string' ? title.trim() : '',
		});

		res.status(201).json({ dm: await serializeGroupDm(db, dm, userId), created: true });
	} catch (err) {
		console.error('[dm] create error:', err);
		res.status(500).json({ error: 'DM 作成に失敗しました' });
	}
});

router.get({
	path: '/:dmId',
	summary: 'DMグループの詳細とメッセージ一覧の取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const dmId = req.params.dmId;

	try {
		const dm = await db.getGroupDm(dmId);
		if (!dm) {
			return res.status(404).json({ error: 'DM not found' });
		}
		if (!dm.member.includes(userId)) {
			return res.status(403).json({ error: 'Forbidden' });
		}
				if (req.query.mark_read === '1') {
					const unreadBefore = Number(dm.unread?.[userId] || 0);
					await db.markGroupDmRead(dmId, userId);
					// 未読表示更新と競合して再読込ループを起こすため、状態変化時だけ通知する。
					if (unreadBefore > 0) {
						await publishDmUnreadCounts(req, [userId], dmId);
						const otherMembers = (dm.member || []).filter((id) => Number(id) !== Number(userId));
						await publishDmReadEvent(req, otherMembers, dmId, userId);
					}
					const refreshed = await db.getGroupDm(dmId);
				return res.json(await buildDmPayload(db, [refreshed || dm], userId));
				}
		res.json(await buildDmPayload(db, [dm], userId));
	} catch (err) {
		console.error('[dm] get error:', err);
		res.status(500).json({ error: 'DM 取得に失敗しました' });
	}
});

router.put({
	path: '/:dmId',
	summary: 'DMグループの設定・メンバー更新',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const dmId = req.params.dmId;
	const body = req.body || {};

	try {
		const dm = await db.getGroupDm(dmId);
		if (!dm) {
			return res.status(404).json({ error: 'DM not found' });
		}
		if (!dm.member.includes(userId)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const updates = {};
		const isHost = dm.host_id === userId;

			if (body.post !== undefined) {
			try {
				validateMessageHistoryUpdate(dm.post || [], body.post, userId);
			} catch (error) {
				return res.status(403).json({ error: error.message || 'Invalid message update' });
			}
			updates.post = body.post;
		}

		if (body.title !== undefined || body.member !== undefined || body.host_id !== undefined) {
			if (!isHost) {
				return res.status(403).json({ error: 'Host only' });
			}
			if (body.title !== undefined) {
				updates.title =
					typeof body.title === 'string' ? body.title.trim() : '';
			}
			if (body.member !== undefined) {
				const memberIds = Array.from(new Set(body.member)).map(Number);
				if (
					memberIds.some((id) => !Number.isInteger(id) || id < 0)
				) {
					return res.status(400).json({ error: 'Invalid member ids' });
				}
				if (!memberIds.includes(userId)) {
					return res.status(400).json({ error: 'Host must stay a member' });
				}
				if (await hasBlockedDmMemberPair(db, memberIds)) {
					return res.status(403).json({
						error: 'ブロック関係のユーザーをDMに招待できません',
					});
				}

				const currentAccepted = Array.isArray(dm.accepted)
					? dm.accepted.slice()
					: (Array.isArray(dm.unread?._accepted) ? dm.unread._accepted.slice() : (dm.member || []).slice());
				const newlyAddedMemberIds = memberIds.filter((id) => !dm.member.includes(id));
				for (const newMemberId of newlyAddedMemberIds) {
					const user = await db.getUserById(newMemberId);
					if (!user) {
						return res.status(404).json({ error: `User ${newMemberId} not found` });
					}
					const invitationPolicy = user.settings?.dm_invitation || user.settings?.dm_permission || 'require_approval';
					if (invitationPolicy === 'deny' || invitationPolicy === 'reject') {
						return res.status(403).json({
							error: `${user.name || 'ユーザー'}はDMの招待を受け付けていません`,
						});
					}
					if (invitationPolicy === 'always' || invitationPolicy === 'allow') {
						if (!currentAccepted.includes(newMemberId)) {
							currentAccepted.push(newMemberId);
						}
					} else if (typeof db.isFollowing === 'function' && await db.isFollowing(newMemberId, userId)) {
						if (!currentAccepted.includes(newMemberId)) {
							currentAccepted.push(newMemberId);
						}
					}
				}

				updates.member = memberIds;
				updates.accepted = currentAccepted;
			}
			if (body.host_id !== undefined) {
				if (!dm.member.includes(Number(body.host_id))) {
					return res.status(400).json({ error: 'New host must be a member' });
				}
				updates.host_id = Number(body.host_id);
			}
		}

		if (Object.keys(updates).length === 0) {
			return res.json({
				dm: await serializeGroupDm(db, dm, userId),
			});
		}

			const updated = await db.updateGroupDm(dmId, updates);
			if (updates.member) {
				await publishDmUnreadCounts(req, [...dm.member, ...updated.member], dmId);
			}
			res.json({
			dm: await serializeGroupDm(db, updated, userId),
		});
	} catch (err) {
		console.error('[dm] update error:', err);
		res.status(500).json({ error: 'DM 更新に失敗しました' });
	}
});

router.delete({
	path: '/:dmId',
	summary: 'DMグループの削除',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const dmId = req.params.dmId;

	try {
		const dm = await db.getGroupDm(dmId);
		if (!dm) {
			return res.status(404).json({ error: 'DM not found' });
		}
		if (dm.host_id !== userId) {
			return res.status(403).json({ error: 'Host only' });
		}

			await db.deleteGroupDm(dmId);
			await publishDmUnreadCounts(req, dm.member, dmId);
			res.json({ success: true });
	} catch (err) {
		console.error('[dm] delete error:', err);
		res.status(500).json({ error: 'DM の解散に失敗しました' });
	}
});

router.post({
	path: '/:dmId/messages',
	summary: 'DMメッセージの送信',
	auth: 'required',
}, requireAuth, dmSendLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const dmId = req.params.dmId;
	const { message } = req.body || {};

	try {
		if (!message || typeof message !== 'object') {
			return res.status(400).json({ error: 'message is required' });
		}

		const dm = await db.getGroupDm(dmId);
		if (!dm) {
			return res.status(404).json({ error: 'DM not found' });
		}
		if (!dm.member.includes(userId)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		let msg;
		try {
			msg = normalizeClientMessage(message, userId);
		} catch (error) {
			return res.status(400).json({ error: error.message || 'Invalid message' });
		}

		if (msg.e2e) {
			const recipients = new Set(
				Object.keys(msg.e2e.ct || {}).map((id) => Number(id)),
			);
			for (const memberId of dm.member) {
				if (!recipients.has(Number(memberId))) {
					return res
						.status(400)
						.json({ error: 'E2E message must be encrypted for all members' });
				}
			}
		}

		const currentAccepted = Array.isArray(dm.accepted)
			? dm.accepted.slice()
			: (Array.isArray(dm.unread?._accepted) ? dm.unread._accepted.slice() : (dm.member || []).slice());
		if (!currentAccepted.includes(userId)) {
			currentAccepted.push(userId);
			await db.updateGroupDm(dmId, { accepted: currentAccepted });
		}

		const sender = await db.getUserById(userId);
		await publishDmMessage(req, dm.member || [], dmId, msg, sender ? serializeDmMember(sender) : null);

		const updated = await db.appendToGroupDm(dmId, msg, userId);
		await publishDmUnreadCounts(
			req,
			(updated.member || []).filter((memberId) => Number(memberId) !== Number(userId)),
			dmId,
		);

		res.status(201).json({
			dm: await serializeGroupDm(db, updated, userId),
			message: msg,
		});
	} catch (err) {
		console.error('[dm] send error:', err);
		res.status(500).json({ error: 'メッセージ送信に失敗しました' });
	}
});

router.post({
	path: '/:dmId/accept',
	summary: 'DMグループ招待の受諾',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const { dmId } = req.params;
	const userId = req.user.id;

	try {
		const dm = await db.getGroupDm(dmId);
		if (!dm) return res.status(404).json({ error: 'DM が見つかりません' });

		if (typeof db.acceptDmInvitation === 'function') {
			await db.acceptDmInvitation(dmId, userId);
		}
		res.json({ success: true });
	} catch (err) {
		console.error('[dm] accept error:', err);
		res.status(500).json({ error: '招待の受諾に失敗しました' });
	}
});

router.post({
	path: '/:dmId/decline',
	summary: 'DMグループ招待の拒否',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const { dmId } = req.params;
	const userId = req.user.id;

	try {
		const dm = await db.getGroupDm(dmId);
		if (!dm) return res.status(404).json({ error: 'DM が見つかりません' });

		if (typeof db.declineDmInvitation === 'function') {
			await db.declineDmInvitation(dmId, userId);
		}
		res.json({ success: true });
	} catch (err) {
		console.error('[dm] decline error:', err);
		res.status(500).json({ error: '招待の拒否に失敗しました' });
	}
});

router.post({
	path: '/:dmId/read',
	summary: 'DMメッセージの既読マーク',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const { dmId } = req.params;
	const userId = req.user.id;

	try {
		const dm = await db.getGroupDm(dmId);
		if (!dm) return res.status(404).json({ error: 'DM が見つかりません' });
		if (!dm.member.includes(userId)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		await db.markGroupDmRead(dmId, userId);
		const otherMembers = (dm.member || []).filter((id) => Number(id) !== Number(userId));
		await publishDmReadEvent(req, otherMembers, dmId, userId);
		await publishDmUnreadCounts(req, [userId], dmId);

		res.json({ success: true });
	} catch (err) {
		console.error('[dm] mark read error:', err);
		res.status(500).json({ error: '既読処理に失敗しました' });
	}
});

router.post({
	path: '/:dmId/leave',
	summary: 'DMグループからの脱退',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const dmId = req.params.dmId;

	try {
		const dm = await db.getGroupDm(dmId);
		if (!dm) {
			return res.status(404).json({ error: 'DM not found' });
		}
		if (!dm.member.includes(userId)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		await db.leaveGroupDm(dmId, userId);
		await publishDmUnreadCounts(req, [userId], dmId);
		res.json({ success: true });
	} catch (err) {
		console.error('[dm] leave error:', err);
		res.status(500).json({ error: 'DM から退出できませんでした' });
	}
});

module.exports = router;
