const express = require('express');
const { optionalAuth, requireAuth, requireAuthAllowFrozen } = require('../middleware/auth');
const crypto = require('crypto');
const config = require('../config');
const { isWithinRange, describeIntegerRange } = require('../utils/settingFormats');
const {
	serializeUser,
	serializeUserBrief,
	serializePublicProfile,
	serializePostsByIds,
	serializePostsBatch,
	serializeNotification,
} = require('../utils/serialize');
const { getPublicUrl, getUserNyaitterId } = require('../utils/nyaitterAddress');
const {
	createPostVisibilityContext,
	filterViewablePosts,
} = require('../utils/postVisibility');
const { hasBlockRelationship } = require('../utils/blockRelationship');
const { normalizeBlockList } = require('../utils/blockList');
const { isOwnedAttachmentKey, normalizeStorageKey } = require('../adapters/storage/safeStoragePath');
const { ScratchIconService } = require('../services/ScratchIconService');
const { listOwnedImposters } = require('../services/ImposterService');
const {
	createNotificationIfAllowed,
} = require('../services/NotificationDeliveryService');

const api = require("../utils/ApiRegistry");
const router = api.createRouter({
	tag: "users",
	basePath: "/users",
	description: "ユーザー・プロフィール・フォロー API",
});
const { createRateLimiter } = require('../middleware/rateLimit');
const profileUpdateLimiter = createRateLimiter(config.rateLimit.profileUpdate);
const accountOperationLimiter = createRateLimiter(config.rateLimit.profileUpdate);
const searchLimiter = createRateLimiter(config.rateLimit.profileUpdate);
const accountDeletionConfirmations = new Map();
const ACCOUNT_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const MAX_ACCOUNT_CONFIRMATIONS = 1000;

function requireInteractiveSession(req, res, next) {
	if (req.user?.tokenType !== 'session' || !req.user?.sessionTokenHash) {
		return res.status(403).json({ error: 'ログイン済み端末のセッションが必要です。' });
	}
	return next();
}

function getAccountConfirmationKey(token) {
	return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function discardExpiredAccountConfirmations(now = Date.now()) {
	for (const [key, value] of accountDeletionConfirmations) {
		if (!value || value.expiresAt <= now) accountDeletionConfirmations.delete(key);
	}
	while (accountDeletionConfirmations.size > MAX_ACCOUNT_CONFIRMATIONS) {
		const oldestKey = accountDeletionConfirmations.keys().next().value;
		if (oldestKey === undefined) break;
		accountDeletionConfirmations.delete(oldestKey);
	}
}

const accountConfirmationPruner = setInterval(discardExpiredAccountConfirmations, 60000);
accountConfirmationPruner.unref();

async function deleteStoredAccountAttachments(storage, keys) {
	if (!storage || !Array.isArray(keys) || keys.length === 0) return;
	try {
		if (typeof storage.deleteMany === 'function') await storage.deleteMany(keys);
		else if (typeof storage.delete === 'function') await Promise.all(keys.map((key) => storage.delete(key)));
	} catch (error) {
		console.warn('[users] account attachment deletion failed:', error.message);
	}
}

async function deleteOwnedImposterAccounts(req, db, storage, parentId) {
	const imposters = await listOwnedImposters(db, parentId);
	for (const imposter of imposters) {
		req.app.locals.realtime?.closeUser?.(imposter.id, 1012, 'Parent account deletion');
		const attachmentKeys = await db.getAccountAttachmentKeys(imposter.id);
		await db.invalidateAllSessions(imposter.id);
		const deleted = await db.deleteAccount(imposter.id);
		if (!deleted) throw new Error(`Imposter account deletion did not complete: ${imposter.id}`);
		await deleteStoredAccountAttachments(storage, attachmentKeys);
	}
}

function buildReassignedAttachmentKey(sourceKey, previousUserId, nextUserId) {
	if (!isOwnedAttachmentKey(sourceKey, previousUserId)) return null;
	const sourcePrefix = `attachments/${Number(previousUserId)}/`;
	if (!sourceKey.startsWith(sourcePrefix)) return null;
	return normalizeStorageKey(`attachments/${Number(nextUserId)}/${sourceKey.slice(sourcePrefix.length)}`);
}

async function migrateReassignedAccountAttachments(db, storage, previousUserId, nextUserId) {
	if (!db || typeof db.getAccountAttachmentKeys !== 'function' || typeof db.rewriteAccountAttachmentKeys !== 'function') {
		throw new Error('Database adapter does not support attachment key rewrite');
	}

	const plannedCopies = [];
	for (const sourceKey of await db.getAccountAttachmentKeys(nextUserId)) {
		let destinationKey;
		try {
			destinationKey = buildReassignedAttachmentKey(sourceKey, previousUserId, nextUserId);
		} catch (_) {
			continue;
		}
		if (destinationKey) plannedCopies.push({ sourceKey, destinationKey });
	}
	if (plannedCopies.length === 0) return 0;
	if (!storage || typeof storage.copy !== 'function') {
		throw new Error('Storage adapter does not support attachment copy');
	}

	const replacements = [];
	for (const { sourceKey, destinationKey } of plannedCopies) {
		const copied = await storage.copy(sourceKey, destinationKey);
		replacements.push({
			sourceKey,
			destinationKey,
			url: copied?.url ?? null,
		});
	}
	await db.rewriteAccountAttachmentKeys(nextUserId, replacements);
	try {
		const sourceKeys = replacements.map((replacement) => replacement.sourceKey);
		if (typeof storage.deleteMany === 'function') await storage.deleteMany(sourceKeys);
		else if (typeof storage.delete === 'function') await Promise.all(sourceKeys.map((sourceKey) => storage.delete(sourceKey)));
	} catch (error) {
		// 参照更新後の旧キー削除に失敗しても、新しい参照と複製済みファイルは維持する。
		console.warn('[users] reassigned account attachment cleanup failed:', error.message);
	}
	return replacements.length;
}

function getDbAdapter(req) {
	return req.app.locals.dbAdapter;
}

function getStorageAdapter(req) {
	return req.app.locals.storageAdapter;
}


function validateProfileText(value, label, range) {
	if (value === undefined) return null;
	if (typeof value !== 'string') return `${label} must be a string`;
	if (!isWithinRange(value.length, range)) {
		return `${label} must be ${describeIntegerRange(range)} characters`;
	}
	return null;
}

function getScratchIconService(req) {
	if (!req.app.locals.scratchIconService) {
		req.app.locals.scratchIconService = new ScratchIconService();
	}
	return req.app.locals.scratchIconService;
}

// アイコン画像を実際に配信しているScratch CDNのみを許可し、任意サイトへの
const ALLOWED_ICON_REDIRECT_HOSTS = new Set([
	'uploads.scratch.mit.edu',
	'cdn2.scratch.mit.edu',
]);

function isAllowedIconRedirectUrl(value) {
	let candidate = String(value || '');
	if (candidate.startsWith('//')) {
		candidate = `https:${candidate}`;
	}
	if (candidate.startsWith('/')) {
		return true;
	}
	try {
		const url = new URL(candidate);
		return url.protocol === 'https:' && ALLOWED_ICON_REDIRECT_HOSTS.has(url.hostname.toLowerCase());
	} catch (_) {
		return false;
	}
}

async function sendScratchFallbackIcon(req, res, scid) {
	let entry;
	try {
		entry = await getScratchIconService(req).getSourceIcon(
			scid,
			getScratchUserIconUrl,
		);
	} catch (error) {
		console.warn(`[users/icon] Scratch icon fetch error for ${scid}:`, error.message);
		return false;
	}
	if (!entry) return false;

	res.setHeader('Cache-Control', 'public, max-age=21600, stale-while-revalidate=86400');
	res.setHeader('Content-Type', entry.contentType);
	res.setHeader('ETag', entry.etag);
	if (req.headers['if-none-match'] === entry.etag) {
		res.status(304).end();
	} else {
		res.send(entry.buffer);
	}
	return true;
}

async function sendStoredIcon(req, res, fileId) {
	const storage = getStorageAdapter(req);
	if (!storage || typeof storage.read !== 'function') return false;
	try {
		const file = await storage.read(fileId);
		const contentType = String(file?.contentType || '').split(';', 1)[0].trim().toLowerCase();
		const buffer = Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.from(file?.buffer || '');
		if (!contentType.startsWith('image/') || buffer.length === 0) return false;
		res.setHeader('Cache-Control', 'public, max-age=21600, stale-while-revalidate=86400');
		res.setHeader('Content-Type', contentType);
		res.send(buffer);
		return true;
	} catch (error) {
		console.warn('[users/icon] stored icon read failed:', error.message);
		return false;
	}
}

async function publishNewNotification(req, userId, notification) {
	const structuredNotification = await serializeNotification(
		getDbAdapter(req),
		notification,
		getPublicUrl(req),
	);
	if (!structuredNotification) return;

	const realtime = req.app.locals.realtime;
	if (realtime) {
		try {
			await realtime.publishNewNotification(userId, structuredNotification, getDbAdapter(req));
		} catch (error) {
			console.warn('[users] notification realtime delivery failed:', error.message);
		}
	}

	const pushService = req.app.locals.pushNotificationService;
	if (pushService?.enabled) {
		void pushService.sendNotificationToUser(userId, structuredNotification, {
			publicUrl: getPublicUrl(req),
		}).catch((error) => {
			console.warn('[users] notification push delivery failed:', error.message);
		});
	}
}

function serializeUserCard(user, publicUrl, { includeSearchExclusion = false } = {}) {
	return {
		...serializeUserBrief(user, publicUrl, { includeSearchExclusion }),
		me: user.me || user.bio || '',
		created_at: user.created_at || user.createdAt || null,
	};
}

function isProfileSectionVisible(user, viewerId, section, viewerUser = null) {
	if (viewerId != null && Number(viewerId) === Number(user?.id)) return true;
	if (viewerId != null && user) {
		const userBlocksViewer = normalizeBlockList(user.block, user.id).includes(Number(viewerId));
		const viewerBlocksUser = viewerUser ? normalizeBlockList(viewerUser.block, viewerUser.id).includes(Number(user.id)) : false;
		if (userBlocksViewer || viewerBlocksUser) return false;
	}
	const settings = user?.settings || {};
	const settingBySection = {
		likes: 'show_like',
		stars: 'show_star',
		following: 'show_follow',
		followers: 'show_follower',
	};
	const setting = settingBySection[section];
	return setting === 'show_follower' ? settings[setting] !== false : Boolean(settings[setting]);
}

function sendPrivateProfileSection(res, section) {
	return res.status(403).json({
		error: 'このプロフィール項目は非公開です',
		visibility: 'private',
		section,
	});
}

async function getScratchUserIconUrl(scid) {
	if (!scid) return 'https://uploads.scratch.mit.edu/get_image/user/0_60x60.png';
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	try {
		const res = await fetch(
			`https://api.scratch.mit.edu/users/${encodeURIComponent(scid)}`,
			{
				headers: { Accept: 'application/json' },
				signal: controller.signal,
			},
		);
		if (res.ok) {
			const data = await res.json();
			if (data && data.profile && data.profile.images) {
				const imgUrl =
					data.profile.images['90x90'] ||
					data.profile.images['60x60'] ||
					data.profile.images['50x50'] ||
					data.profile.images['32x32'];
				if (imgUrl) return imgUrl;
			}
		}
	} catch (err) {
		console.warn(`[users/icon] Scratch API fetch error for ${scid}:`, err.message);
	} finally {
		clearTimeout(timeout);
	}
	return `https://uploads.scratch.mit.edu/get_image/user/${encodeURIComponent(scid)}_60x60.png`;
}

async function handleUserIcon(req, res) {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);
	if (!Number.isInteger(userId) || userId <= 0) {
		return res.redirect(302, '/emoji/neko.svg');
	}

	try {
		const user = await db.getUserById(userId);

		if (user && user.icon_data && user.icon_data.trim() !== '') {
			const iconData = user.icon_data.trim();

			// R2/D1・ローカルストレージに保存されたアイコンはキーだけをDBへ保存する。
			// キーを相対リダイレクトすると現在の /server/api/users/... 配下として解決されるため、
			if (!/^(?:https?:)?\/\//i.test(iconData) && !iconData.startsWith('/')) {
				const storage = getStorageAdapter(req);
				if (storage && typeof storage.getPublicUrl === 'function') {
					try {
						const publicUrl = await storage.getPublicUrl(iconData);
						if (typeof publicUrl === 'string' && publicUrl && isAllowedIconRedirectUrl(publicUrl)) {
							return res.redirect(302, publicUrl);
						}
					} catch (error) {
						console.warn('[users/icon] stored icon URL resolution failed:', error.message);
					}
				}

				// ユーザーファイルの公開URLを設定していない場合でも、Push通知が
				// このAPIを読み込めるよう、保存済み画像を直接返す。
				if (await sendStoredIcon(req, res, iconData)) return;
				return res.redirect(302, '/emoji/neko.svg');
			}

			// 同一オリジン相対パス、または許可済みScratch CDNのURLだけをリダイレクトする。
			// それ以外（プロトコル相対・任意ホストの絶対URL）はフォールバック画像へ倒す。
			if (isAllowedIconRedirectUrl(iconData)) {
				return res.redirect(302, iconData);
			}
			return res.redirect(302, '/emoji/neko.svg');
		}

		if (user && user.scid != null && String(user.scid).trim() !== '') {
			if (await sendScratchFallbackIcon(req, res, String(user.scid).trim())) return;
			res.setHeader('Cache-Control', 'public, max-age=60');
			return res.redirect(302, '/emoji/neko.svg');
		}
	} catch (err) {
		console.error('[users] icon route error:', err);
	}

	return res.redirect(302, '/emoji/neko.svg');
}

router.get({
	path: '/:userId/icon',
	summary: 'ユーザーアバターアイコン画像の取得',
	auth: 'none',
}, handleUserIcon);

router.get({
	path: '/search',
	summary: 'ユーザー検索',
	auth: 'optional',
}, optionalAuth, searchLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const query = req.query.q || '';
	const requestedLimit = parseInt(req.query.limit, 10);
	const pageSize = config.limits.userSearchPageSize;
	const minimum = pageSize.min === null ? 1 : pageSize.min;
	const maximum = pageSize.max;
	let limit = Number.isInteger(requestedLimit) && requestedLimit > 0
		? requestedLimit
		: config.limits.userSearchDefaultLimit;
	limit = Math.max(limit, minimum);
	if (maximum !== null) limit = Math.min(limit, maximum);
	const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

	if (query.trim().length === 0) {
		return res.json({ users: [] });
	}

	try {
					const users = await db.searchUsers(query, limit, offset);
				res.json({
					users: users.map((user) => serializeUserCard(user, getPublicUrl(req), {
						includeSearchExclusion: Boolean(req.user?.admin),
					})),
					offset,
				});

	} catch (err) {
		console.error('[users] search error:', err);
		res.status(500).json({ error: 'ユーザー検索に失敗しました' });
	}
});

router.get({
	path: '/recommended',
	summary: 'おすすめユーザー一覧の取得',
	auth: 'optional',
}, optionalAuth, searchLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const viewerId = req.user ? req.user.id : null;

	try {
		let selected;
		if (typeof db.getRecommendedUsers === 'function') {
			selected = await db.getRecommendedUsers(3, viewerId);
		} else {
			const allUsers = db.getAllUsers ? await db.getAllUsers() : [];
			let candidates = allUsers
				.slice(0, 100) // cap before sort to avoid large in-memory operations
				.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
			if (viewerId) {
				candidates = candidates.filter(
					(u) => u.id !== Number(viewerId),
				);
			}
			selected = candidates.slice(0, 3);
		}
		res.json({ users: selected.map((user) => serializeUserCard(user, getPublicUrl(req), {
			includeSearchExclusion: Boolean(req.user?.admin),
		})) });

	} catch (err) {
		console.error('[users] recommended error:', err);
		res.status(500).json({ error: 'おすすめユーザー取得に失敗しました' });
	}
});

router.get({
	path: '/logs',
	summary: 'ログイン履歴・アクセスログの取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);

	if (!req.user.admin) {
		return res.status(403).json({ error: 'Admin access required' });
	}

	const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
	const offset = parseInt(req.query.offset, 10) || 0;

	try {
		const logs = await db.getLogs(limit, offset);
		res.json({ logs });
	} catch (err) {
		console.error('[users] logs error:', err);
		res.status(500).json({ error: 'ログ取得に失敗しました' });
	}
});


router.get({
	path: '/:userId',
	summary: 'ユーザープロフィール詳細の取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		const user = await db.getUserById(userId);
		if (!user) {
			return res.status(404).json({ error: 'User not found' });
		}

			const viewerId = req.user ? req.user.id : null;
			let groups = [];
			let targetGroups = null;
			if (viewerId != null) {
				const [viewerGroups, fetchedTargetGroups] = await Promise.all([
					db.getUserGroups(viewerId, { status: 'active', limit: 200, offset: 0 }),
					db.getUserGroups(userId, { status: 'active', limit: 200, offset: 0 }),
				]);
				targetGroups = fetchedTargetGroups;
				const targetGroupIds = new Set(targetGroups.map((group) => String(group.id)));
				groups = viewerGroups
					.filter((group) => targetGroupIds.has(String(group.id)))
					.map((group) => ({
						id: String(group.id),
						name: group.name || '',
						description: group.description || '',
						icon_data: group.iconData ?? group.icon_data ?? null,
						header_image: group.headerImage ?? group.header_image ?? null,
						visibility: group.visibility || 'open',
						member_count: Math.max(0, Number(group.memberCount ?? group.member_count) || 0),
					}));
			}
			if (targetGroups === null && typeof db.getUserGroups === 'function') {
				targetGroups = await db.getUserGroups(userId, { status: 'active', limit: 200, offset: 0 });
			}
			const profile = await serializePublicProfile(
				db,
				user,
				viewerId,
				getPublicUrl(req),
				req.user?.visibilityUser || null,
				targetGroups,
			);
			res.json({ user: { ...profile, groups } });
	} catch (err) {
		console.error('[users] profile error:', err);
		res.status(500).json({ error: 'プロフィール取得に失敗しました' });
	}
});

router.get({
	path: '/',
	summary: '複数ユーザーIDの一括プロフィール取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const ids = (req.query.ids || '')
		.split(',')
		.map((id) => parseInt(id, 10))
		.filter((id) => Number.isInteger(id) && id >= 0);

	if (ids.length === 0) {
		return res.json({ users: [] });
	}

	try {
					const users = await db.getUsersByIds(ids);
			res.json({ users: users.map((user) => serializeUserCard(user, getPublicUrl(req), {
				includeSearchExclusion: Boolean(req.user?.admin),
			})) });

	} catch (err) {
		console.error('[users] batch error:', err);
		res.status(500).json({ error: 'ユーザー取得に失敗しました' });
	}
});

router.get({
	path: '/:userId/counts',
	summary: 'ユーザーのカウント情報（投稿/メディア/フォロー等）取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		if (req.user?.id && await hasBlockRelationship(db, req.user.id, userId)) {
			return res.json({
				post_count: 0,
				media_count: 0,
				follower_count: 0,
				following_count: 0,
			});
		}
		const [post_count, media_count, follower_count, following_count] =
			await Promise.all([
				db.getPostCount ? db.getPostCount(userId) : 0,
				db.getMediaCount ? db.getMediaCount(userId) : 0,
				db.getFollowerCount ? db.getFollowerCount(userId) : 0,
				db.getFollowingCount ? db.getFollowingCount(userId) : 0,
			]);

		res.json({
			post_count,
			media_count,
			follower_count,
			following_count,
		});
	} catch (err) {
		console.error('[users] counts error:', err);
		res.status(500).json({ error: 'カウント取得に失敗しました' });
	}
});

router.get({
	path: '/:userId/media',
	summary: 'ユーザーの投稿メディア一覧取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);
	const limit = Math.min(parseInt(req.query.limit, 10) || 15, 50);
	const offset = parseInt(req.query.offset, 10) || 0;
	const type = req.query.type;
	if (type && !['image', 'video'].includes(type)) {
		return res.status(400).json({ error: 'Invalid type parameter' });
	}

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		if (req.user?.id && await hasBlockRelationship(db, req.user.id, userId)) {
			return res.json({ media_items: [] });
		}
		const mediaItems = await db.getMediaPosts(userId, limit, offset, type);
		res.json({ media_items: mediaItems });
	} catch (err) {
		console.error('[users] media error:', err);
		res.status(500).json({ error: 'メディア取得に失敗しました' });
	}
});

router.get({
	path: '/:userId/is-lock',
	summary: 'ユーザーの鍵垢状態確認',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		const user = await db.getUserById(userId);
		if (!user) {
			return res.status(404).json({ error: 'User not found' });
		}
		res.json({ lock: !!(user.settings && user.settings.lock) });
	} catch (err) {
		console.error('[users] is-lock error:', err);
		res.status(500).json({ error: '取得に失敗しました' });
	}
});

router.get({
	path: '/:userId/status',
	summary: 'ユーザー関係状態（フォロー/フォロワー/ブロック関係）の取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);

	if (!req.user.admin) {
		return res.status(403).json({ error: 'Admin access required' });
	}

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		const status = await db.getUserStatus(userId);
		if (!status) {
			return res.status(404).json({ error: 'User not found' });
		}
		res.json({ status });
	} catch (err) {
		console.error('[users] status error:', err);
		res.status(500).json({ error: 'ステータス取得に失敗しました' });
	}
});

router.put({
	path: '/:userId/status',
	summary: 'ユーザー関係状態の更新（ブロック等）',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);

	if (!req.user.admin) {
		return res.status(403).json({ error: 'Admin access required' });
	}

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		const { shadow } = req.body || {};
		const status = await db.setUserStatus(userId, { shadow });
		if (!status) {
			return res.status(404).json({ error: 'User not found' });
		}

		try {
			const LogHubManager = require('../services/managementTool/LogHubManager');
			LogHubManager.appendExternalLog({
				type: 'admin',
				level: 'warn',
				source: 'admin-action',
				message: `[Admin] 管理者 @${req.user.name || req.user.username} (#${req.user.id}) がユーザー #${userId} のステータスを更新 (shadow: ${Boolean(shadow)})`,
				details: { adminUserId: req.user.id, targetUserId: userId, changes: { shadow } },
			});
		} catch (_) {}

		res.json({ success: true, status });
	} catch (err) {
		console.error('[users] set status error:', err);
		res.status(500).json({ error: 'ステータス更新に失敗しました' });
	}
});

router.post({
	path: '/:userId/follow',
	summary: 'ユーザーのフォロー/フォロー解除（トグル）',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const followerId = req.user.id;
	const followingId = parseInt(req.params.userId, 10);

	if (!Number.isInteger(followingId) || followingId <= 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		if (await hasBlockRelationship(db, followerId, followingId)) {
			return res.status(403).json({ error: 'ブロック関係にあるユーザーをフォローすることはできません。' });
		}
		const result = await db.toggleFollow(followerId, followingId);

			if (result.following) {
				const notification = await createNotificationIfAllowed(db, {
					userId: followingId,
					type: 'follow',
					fromUserId: followerId,
					target: { kind: 'user', id: followingId },
				});
				await publishNewNotification(req, followingId, notification);
			}

		const updatedFollows = await db.getFollowIds(followerId);

		res.json({
			success: true,
			following: result.following,
			updated_follows: updatedFollows,
		});
	} catch (err) {
		console.error('[users] follow error:', err);
		res.status(400).json({
			error: err.message || 'フォロー処理に失敗しました',
		});
	}
});

router.get({
	path: '/:userId/:section(likes|stars)',
	summary: 'ユーザーがいいね/スターした投稿一覧取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);
	const section = req.params.section;
	const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
	const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
	if (!Number.isInteger(userId) || userId < 0) return res.status(400).json({ error: 'Invalid user id' });

	try {
		const user = await db.getUserById(userId);
		if (!user) return res.status(404).json({ error: 'User not found' });
		if (!isProfileSectionVisible(user, req.user?.id ?? null, section, req.user?.visibilityUser || req.user)) return sendPrivateProfileSection(res, section);
		const ids = section === 'likes'
			? await db.getLikeIds(userId)
			: await db.getStarIds(userId);
		const orderedIds = Array.isArray(ids) ? ids : [];
		const pageIds = orderedIds.slice(offset, offset + limit);
			const posts = await serializePostsByIds(
				db,
				pageIds,
				req.user?.id ?? null,
				getPublicUrl(req),
				req.user?.visibilityUser || null,
			);
		res.json({
			posts,
			has_more: orderedIds.length > offset + limit,
		});
	} catch (err) {
		console.error(`[users] ${section} error:`, err);
		res.status(500).json({ error: 'プロフィール投稿の取得に失敗しました' });
	}
});

router.get({
	path: '/:userId/followers',
	summary: 'ユーザーのフォロワー一覧取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);
	const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
	const offset = parseInt(req.query.offset, 10) || 0;

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		const target = await db.getUserById(userId);
		if (!target) return res.status(404).json({ error: 'User not found' });
		if (!isProfileSectionVisible(target, req.user?.id ?? null, 'followers', req.user?.visibilityUser || req.user)) return sendPrivateProfileSection(res, 'followers');
		const followers = await db.getFollowers(userId, offset + limit + 1);
		const slice = followers.slice(offset, offset + limit);
		res.json({
			followers: slice.map((u) => serializeUserBrief(u)),
			has_more: followers.length > offset + limit,
		});
	} catch (err) {
		console.error('[users] followers error:', err);
		res.status(500).json({ error: 'フォロワー取得に失敗しました' });
	}
});

router.get({
	path: '/:userId/following',
	summary: 'ユーザーのフォロー中一覧取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);
	const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
	const offset = parseInt(req.query.offset, 10) || 0;

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		const target = await db.getUserById(userId);
		if (!target) return res.status(404).json({ error: 'User not found' });
		if (!isProfileSectionVisible(target, req.user?.id ?? null, 'following', req.user?.visibilityUser || req.user)) return sendPrivateProfileSection(res, 'following');
		const following = await db.getFollowing(userId, offset + limit + 1);
		const slice = following.slice(offset, offset + limit);
		res.json({
			following: slice.map((u) => serializeUserBrief(u)),
			has_more: following.length > offset + limit,
		});
	} catch (err) {
		console.error('[users] following error:', err);
		res.status(500).json({ error: 'フォロー中取得に失敗しました' });
	}
});

router.get({
	path: '/:userId/posts',
	summary: 'ユーザーの投稿一覧取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);
	const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
	const offset = parseInt(req.query.offset, 10) || 0;
	const mode = req.query.mode || 'all';

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		const all = await db.getPostsByUserId(
			userId,
			offset + limit + 1,
			req.user ? req.user.id : null,
		);
			const currentUserId = req.user ? req.user.id : null;
			const knownViewer = req.user?.visibilityUser || null;
			const visibilityContext = await createPostVisibilityContext(
				db,
				all,
				currentUserId,
				null,
				knownViewer,
			);
			let filtered = await filterViewablePosts(db, all, currentUserId, visibilityContext);
		if (mode === 'posts') {
			filtered = filtered.filter((p) => !p.replyTo);
		} else if (mode === 'replies') {
			filtered = filtered.filter((p) => p.replyTo);
		}
		const slice = filtered.slice(offset, offset + limit);
		const has_more = filtered.length > offset + limit;
		res.json({
				posts: await serializePostsBatch(
					db,
					slice,
					currentUserId,
					getPublicUrl(req),
					knownViewer,
					visibilityContext,
				),
			has_more,
		});
	} catch (err) {
		console.error('[users] posts error:', err);
		res.status(500).json({ error: 'ポスト取得に失敗しました' });
	}
});

router.get({
	path: '/:userId/pin',
	summary: 'ユーザーの固定投稿一覧取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		if (req.user?.id && await hasBlockRelationship(db, req.user.id, userId)) {
			return res.json({ pin_id: null });
		}
		const pinId = await db.getPinnedPostId(userId);
		res.json({ pin_id: pinId });
	} catch (err) {
		console.error('[users] pin error:', err);
		res.status(500).json({ error: 'ピン留め取得に失敗しました' });
	}
});

router.post({
	path: '/me/nyaitter-id/reassign',
	summary: 'NyaitterID の再割り当て',
	auth: 'session',
}, requireAuthAllowFrozen, requireInteractiveSession, accountOperationLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	if (req.user.accountOperation) return res.status(409).json({ error: '別のアカウント処理が進行中です。' });
	let started = null;
	let operationUserId = userId;
	try {
		started = await db.beginAccountOperation(userId, 'reassigning');
		if (!started) return res.status(409).json({ error: 'NyaitterIDを再割り当てできません。' });
		req.app.locals.realtime?.closeUser?.(userId, 1012, 'Nyaitter ID reassignment');
					const updated = await db.reassignUserId(userId);
			if (!updated) throw new Error('Nyaitter ID reassignment did not complete');
			const reassignedUserId = Number(updated.id);
			operationUserId = reassignedUserId;
			await migrateReassignedAccountAttachments(
				db,
				getStorageAdapter(req),
				userId,
				reassignedUserId,
			);
			const completedUser = await db.finishAccountOperation(reassignedUserId, 'reassigning') || updated;
			const notification = await db.createNotification({
				userId: reassignedUserId,
				type: 'admin_notice',
				message: `NyaitterIDを${getUserNyaitterId(updated)}へ再割り当てしました。`,
				target: { kind: 'route', value: '#settings' },
			});
			if (notification) await publishNewNotification(req, reassignedUserId, notification);
			return res.json({ user: await serializeUser(db, completedUser, reassignedUserId, getPublicUrl(req)) });

	} catch (error) {
		console.error('[users] NyaitterID reassignment failed:', error);
		if (started) await db.finishAccountOperation(operationUserId, 'reassigning').catch(() => {});
		return res.status(500).json({ error: 'NyaitterIDの再割り当てに失敗しました。' });
	}
});

router.post({
	path: '/me/account/delete/prepare',
	summary: 'アカウント削除の確認トークン発行',
	auth: 'session',
}, requireAuthAllowFrozen, requireInteractiveSession, accountOperationLimiter, (req, res) => {
	if (req.user.accountOperation) return res.status(409).json({ error: '別のアカウント処理が進行中です。' });
	discardExpiredAccountConfirmations();
	const confirmationToken = crypto.randomBytes(32).toString('base64url');
	accountDeletionConfirmations.set(getAccountConfirmationKey(confirmationToken), {
		userId: req.user.id,
		sessionTokenHash: req.user.sessionTokenHash,
		expiresAt: Date.now() + ACCOUNT_CONFIRMATION_TTL_MS,
	});
	return res.json({ confirmation_token: confirmationToken, expires_in_seconds: ACCOUNT_CONFIRMATION_TTL_MS / 1000 });
});

router.delete({
	path: '/me/account',
	summary: 'アカウントの完全削除',
	auth: 'session',
}, requireAuthAllowFrozen, requireInteractiveSession, accountOperationLimiter, async (req, res) => {
	const confirmationToken = String(req.body?.confirmation_token || '');
	const key = getAccountConfirmationKey(confirmationToken);
	const confirmation = accountDeletionConfirmations.get(key);
	accountDeletionConfirmations.delete(key);
	if (!confirmation || confirmation.expiresAt <= Date.now() || confirmation.userId !== req.user.id || confirmation.sessionTokenHash !== req.user.sessionTokenHash) {
		return res.status(400).json({ error: 'アカウント削除の確認が無効または期限切れです。' });
	}

	const db = getDbAdapter(req);
	const storage = getStorageAdapter(req);
	let started = null;
	try {
		started = await db.beginAccountOperation(req.user.id, 'deleting');
		if (!started) return res.status(409).json({ error: 'アカウント削除を開始できません。' });
		req.app.locals.realtime?.closeUser?.(req.user.id, 1012, 'Account deletion');
		await deleteOwnedImposterAccounts(req, db, storage, req.user.id);
		const attachmentKeys = await db.getAccountAttachmentKeys(req.user.id);
		await db.invalidateAllSessions(req.user.id);
		const deleted = await db.deleteAccount(req.user.id);
		if (!deleted) throw new Error('Account deletion did not complete');
		await deleteStoredAccountAttachments(storage, attachmentKeys);
		res.clearCookie('nyaitter_session');
		res.clearCookie('nyaitter_accounts');
		return res.json({ success: true });
	} catch (error) {
		console.error('[users] account deletion failed:', error);
		if (started) await db.finishAccountOperation(req.user.id, 'deleting').catch(() => {});
		return res.status(500).json({ error: 'アカウント削除に失敗しました。' });
	}
});

router.put({
	path: '/me',
	summary: '自分のプロフィールの更新',
	auth: 'required',
}, requireAuth, profileUpdateLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const { name, me, bio, header_image, icon_data, settings, block } =
		req.body;
	const validationError =
		validateProfileText(name, 'name', config.limits.userNameLength) ||
		validateProfileText(me, 'me', config.limits.profileBioLength) ||
		validateProfileText(bio, 'bio', config.limits.profileBioLength);
	if (validationError) return res.status(400).json({ error: validationError });

	try {
		const updated = await db.updateUserProfile(userId, {
			name,
			me,
			bio,
			header_image,
			icon_data,
			settings,
			block,
		});
		if (!updated) {
			return res.status(404).json({ error: 'User not found' });
		}
		res.json({
			user: await serializeUser(db, updated, userId, getPublicUrl(req)),
		});
	} catch (err) {
		console.error('[users] update profile error:', err);
		res.status(500).json({ error: 'プロフィール更新に失敗しました' });
	}
});

router.put({
	path: '/:userId',
	summary: 'ユーザープロフィールの更新（本人またはインポスター）',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);

	if (!req.user.admin) {
		return res.status(403).json({ error: 'Admin access required' });
	}

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	const { verify, freeze, admin } = req.body || {};

	try {
		const updated = await db.updateUserProfile(userId, {
			verify,
			freeze,
			admin,
		});
		if (!updated) {
			return res.status(404).json({ error: 'User not found' });
		}

		try {
			const LogHubManager = require('../services/managementTool/LogHubManager');
			LogHubManager.appendExternalLog({
				type: 'admin',
				level: 'warn',
				source: 'admin-action',
				message: `[Admin] 管理者 @${req.user.name || req.user.username} (#${req.user.id}) がユーザー #${userId} を更新 (freeze: ${Boolean(freeze)}, verify: ${Boolean(verify)}, admin: ${Boolean(admin)})`,
				details: { adminUserId: req.user.id, targetUserId: userId, changes: { verify, freeze, admin } },
			});
		} catch (_) {}

		res.json({
			user: await serializeUser(db, updated, req.user.id, getPublicUrl(req)),
		});
	} catch (err) {
		console.error('[users] admin update error:', err);
		res.status(500).json({ error: 'ユーザー更新に失敗しました' });
	}
});

module.exports = router;
