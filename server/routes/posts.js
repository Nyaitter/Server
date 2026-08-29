const express = require('express');
const PostService = require('../services/PostService');
const { extractPostKeywords } = require('../services/PostKeywordService');
const { extractViewContent } = require('../utils/viewContent');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const config = require('../config');
const { isWithinRange, describeIntegerRange } = require('../utils/settingFormats');
const {
	serializePost,
	serializeReply,
	serializePostsBatch,
	serializePostsByIds,
	serializeNotification,
} = require('../utils/serialize');
const {
	isOwnedAttachmentKey,
	normalizeContentType,
} = require('../adapters/storage/safeStoragePath');
const { getPublicUrl } = require('../utils/nyaitterAddress');
const {
	canViewPost,
	createPostVisibilityContext,
	filterViewablePosts,
	filterDiscoverablePosts,
	normalizeNgWords,
} = require('../utils/postVisibility');
const {
	getDiscoverablePostPage,
} = require('../services/PostDiscoveryQueryService');
const {
	createNotificationIfAllowed,
} = require('../services/NotificationDeliveryService');
const {
	processCreatePostAction,
	processDeletePostAction,
	processEditPostAction,
} = require('../services/PostActionProcessor');
const timelineCacheManager = require('../utils/TimelineCacheManager');
const path = require('path');
const fs = require('fs');
const { isCrawler, generatePostOgpTags, generatePostHtml } = require('../services/OgpService');

const api = require("../utils/ApiRegistry");
const router = api.createRouter({
	tag: "posts",
	basePath: "/posts",
	description: "投稿・タイムライン・リアクション API",
});
const { createRateLimiter } = require('../middleware/rateLimit');
const postWriteLimiter = createRateLimiter(config.rateLimit.postWrite);
const searchLimiter = createRateLimiter(config.rateLimit.profileUpdate ?? config.rateLimit.postWrite);

function getDbAdapter(req) {
	return req.app.locals.dbAdapter;
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
			console.warn('[posts] notification realtime delivery failed:', error.message);
		}
	}

	const pushService = req.app.locals.pushNotificationService;
	if (pushService?.enabled) {
		void pushService.sendNotificationToUser(userId, structuredNotification, {
			publicUrl: getPublicUrl(req),
		}).catch((error) => {
			console.warn('[posts] notification push delivery failed:', error.message);
		});
	}
}

function getStorageAdapter(req) {
	return req.app.locals.storageAdapter;
}

function enqueueGeminiModeration(req, post) {
	const service = req.app.locals.autoModerationService;
	if (!service?.enabled || !post) return;
	try {
		service.enqueue(post);
	} catch (error) {
		// 投稿・編集は永続化済みのため、キュー投入失敗でAPIを失敗させない。
		console.warn('[posts] Gemini moderation enqueue failed:', error.message);
	}
}

function contentLengthError(range) {
	return `content must be ${describeIntegerRange(range)} characters`;
}

function safeParsePostId(idStr) {
	const n = parseInt(idStr, 10);
	return Number.isInteger(n) && n > 0 ? n : null;
}

function getViewerNgWords(req) {
	const ngWordsSetting = req.user?.settings?.ng_words;
	if (!ngWordsSetting) return null;
	const words = normalizeNgWords(ngWordsSetting);
	return words.size > 0 ? words : null;
}

// 軽量なメトリクスAPIは投稿本体を返さないため、可視性検証だけを行う。
async function getViewablePostIds(db, postIds, viewerId = null, knownViewer = null) {
	const uniqueIds = [...new Set((postIds || []).map(Number).filter(Number.isInteger))];
	if (uniqueIds.length === 0) return [];
	const posts = await db.getPostsByIds(uniqueIds);
	const visibilityContext = await createPostVisibilityContext(
		db,
		posts,
		viewerId,
		null,
		knownViewer,
	);
	const viewable = await filterViewablePosts(db, posts, viewerId, visibilityContext);
	const visibleIds = new Set(viewable.map((post) => Number(post.id)));
	return uniqueIds.filter((id) => visibleIds.has(id));
}

async function getDiscoverableModePage(
	db,
	{
		mode,
		tab = 'foryou',
		query = '',
		viewerId = null,
		knownViewer = null,
		limit,
		offset,
		beforeId = null,
		ngWords = null,
	},
) {
	return getDiscoverablePostPage({
		db,
		viewerId,
		knownViewer,
		limit,
		offset,
		beforeId,
		ngWords,
		fetchCandidatePage: async ({ limit: candidateLimit, offset: candidateOffset, beforeId: candidateBeforeId }) => {
			if (mode === 'timeline') {
				return db.getTimelinePostIds({
					tab,
					viewerId,
					limit: candidateLimit,
					offset: candidateOffset,
					beforeId: candidateBeforeId,
				});
			}
			if (mode === 'recommended') {
				return db.getRecommendedPostIds({
					viewerId,
					limit: candidateLimit,
					offset: candidateOffset,
					beforeId: candidateBeforeId,
				});
			}
			if (mode === 'search') {
				return db.searchPostIds(query, candidateLimit, candidateOffset, candidateBeforeId, viewerId);
			}
			throw new Error(`Unsupported discoverable mode: ${mode}`);
		},
	});
}

async function getThreadReplyPostIds(db, postId, limit, offset) {
	if (typeof db.getThreadReplyPostIds === 'function') {
		try {
			return await db.getThreadReplyPostIds(postId, limit, offset);
		} catch (error) {
			// 外部D1 Workerなどが段階的に更新される間は、従来の直下返信取得へ安全に後退する。
			console.warn('[posts] nested reply query fallback:', error.message);
		}
	}
	return db.getReplyPostIds(postId, limit, offset);
}

function collectPostContext(posts) {
	const authors = new Map();
	const mentionedIds = new Set();
	const visited = new Set();
	const visit = (post) => {
		if (!post || visited.has(post.id)) return;
		visited.add(post.id);
		if (post.author?.id != null) authors.set(Number(post.author.id), post.author);
		for (const match of String(post.content || '').matchAll(/@(\d+)/g)) {
			mentionedIds.add(Number(match[1]));
		}
		visit(post.reply_to_post);
		visit(post.reposted_post);
	};
	for (const post of posts || []) visit(post);
	return {
		authors,
		mentionedIds: [...mentionedIds].filter((id) => Number.isInteger(id) && id > 0),
	};
}

function decodeBase64File(value) {
	if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
		throw new Error('Invalid base64 file data');
	}
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
		throw new Error('Invalid base64 file data');
	}
	return Buffer.from(value, 'base64');
}

function validateAttachmentReferences(attachments, userId) {
	if (!Array.isArray(attachments)) {
		throw new Error('attachments must be an array');
	}

	for (const attachment of attachments) {
		if (!attachment || typeof attachment !== 'object') {
			throw new Error('Invalid attachment');
		}
		if (attachment.type === 'poll') {
			const options = Array.isArray(attachment.options) ? attachment.options : [];
			if (options.length < 2) {
				throw new Error('投票には最低2つの選択肢が必要です');
			}
			continue;
		}
		if (attachment.data !== undefined) {
			// MIMEタイプはクライアント申告値を保存するだけで、形式による拒否は行わない。
			normalizeContentType(attachment.contentType);
			decodeBase64File(attachment.data);
			continue;
		}
		if (typeof attachment.id !== 'string' || !isOwnedAttachmentKey(attachment.id, userId)) {
			throw new Error('Attachment does not belong to the current user');
		}
		if (attachment.url !== undefined && !isValidAttachmentUrl(attachment.url)) {
			throw new Error('Invalid attachment URL');
		}
	}
}

// javascript: やクレデンシャル付きURL・オープンリダイレクト系の値を拒否する。
function isValidAttachmentUrl(value) {
	if (typeof value !== 'string' || value.length === 0) return true;
	if (value.startsWith('/')) return true;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password;
	} catch (_) {
		return false;
	}
}

function createPostActionContext(req) {
	return {
		db: getDbAdapter(req),
		storage: getStorageAdapter(req),
		realtime: req.app.locals.realtime,
		pushService: req.app.locals.pushNotificationService,
		autoModerationService: req.app.locals.autoModerationService,
		publicUrl: getPublicUrl(req),
		authRequest: {
			user: { ...req.user, visibilityUser: null },
			headers: { cookie: req.headers.cookie || '' },
		},
	};
}

router.post({
	path: '/',
	summary: '新規投稿の作成',
	auth: 'required',
}, requireAuth, postWriteLimiter, (req, res) => {
	const {
		content,
		attachments = [],
		mask,
		lock,
		announcement,
		group_id,
		group_announcement,
		reply_to,
		repost_to,
		reply_control,
		replyControl,
		post_as_user_id,
	} = req.body || {};
	const hasContent = typeof content === 'string' && content.trim().length > 0;
	const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
	const isSimpleRepost = (content === null || content === undefined || content === '') && repost_to;

	if (!hasContent && !hasAttachments && !isSimpleRepost) {
		return res.status(400).json({ error: 'content, attachments, or repost_to is required' });
	}
	if (hasContent && !isWithinRange(content.trim().length, config.limits.postContentLength)) {
		return res.status(400).json({ error: contentLengthError(config.limits.postContentLength) });
	}
	if (!Array.isArray(attachments)) {
		return res.status(400).json({ error: 'attachments must be an array' });
	}

	const queue = req.app.locals.postActionQueue;
	if (!queue) {
		return res.status(503).json({ error: 'Post action queue is unavailable' });
	}

	try {
		const context = createPostActionContext(req);
		const actionId = queue.enqueue('create', () => processCreatePostAction(context, {
			content,
			attachments,
			mask,
			lock,
			announcement: announcement === true,
			groupId: group_id,
			groupAnnouncement: group_announcement === true,
			replyTo: reply_to,
			repostTo: repost_to,
			replyControl: reply_control ?? replyControl,
			postAsUserId: post_as_user_id,
		}));
		return res.status(202).json({ success: true, queued: true, action_id: actionId });
	} catch (error) {
		return res.status(error.statusCode || 503).json({ error: error.message });
	}
});

router.get({
	path: '/',
	summary: '最新投稿一覧の取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);

		try {
						const posts = await db.getRecentPosts(config.limits.timelinePageSize);
				const currentUserId = req.user ? req.user.id : null;
				const knownViewer = req.user?.visibilityUser || null;
				const visibilityContext = await createPostVisibilityContext(
					db,
					posts,
					currentUserId,
					null,
					knownViewer,
				);
				const viewablePosts = await filterViewablePosts(
					db,
					posts,
					currentUserId,
					visibilityContext,
				);
			const discoverablePosts = await filterDiscoverablePosts(
				db,
				viewablePosts,
				currentUserId,
				visibilityContext,
				{ ngWords: getViewerNgWords(req) },
			);

				const enriched = await serializePostsBatch(
					db,
					discoverablePosts,
					currentUserId,
					getPublicUrl(req),
					knownViewer,
					visibilityContext,
				);
			if (!req.user) {
				res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
			}
			res.json({ posts: enriched });

	} catch (err) {
		console.error('[posts] get error:', err);
		res.status(500).json({ error: '投稿の取得に失敗しました' });
	}
});

router.get({
	path: '/trending',
	summary: 'トレンド投稿一覧の取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);

		try {
						const posts = await db.getTrendingPosts(limit);
				const currentUserId = req.user ? req.user.id : null;
				const knownViewer = req.user?.visibilityUser || null;
				const visibilityContext = await createPostVisibilityContext(
					db,
					posts,
					currentUserId,
					null,
					knownViewer,
				);
				const viewablePosts = await filterViewablePosts(
					db,
					posts,
					currentUserId,
					visibilityContext,
				);
			const discoverablePosts = await filterDiscoverablePosts(
				db,
				viewablePosts,
				currentUserId,
				visibilityContext,
				{ ngWords: getViewerNgWords(req) },
			);
			const hydrated = await serializePostsBatch(
				db,
				discoverablePosts,
				currentUserId,
				getPublicUrl(req),
				knownViewer,
				visibilityContext,
			);
			if (!req.user) {
				res.set('Cache-Control', 'public, max-age=30, s-maxage=30, stale-while-revalidate=60');
			}
			res.json({ posts: hydrated });

	} catch (err) {
		console.error('[posts] trending error:', err);
		res.status(500).json({ error: 'トレンド取得に失敗しました' });
	}
});

router.get({
	path: '/search',
	summary: '投稿キーワード検索',
	auth: 'optional',
}, optionalAuth, searchLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const q = req.query.q || '';
	const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
	const beforeId = safeParsePostId(req.query.before_id);
	const offset = beforeId == null ? (parseInt(req.query.offset, 10) || 0) : 0;

	if (!q.trim()) {
		return res.json({ posts: [], has_next: false });
	}

		try {
			const currentUserId = req.user ? req.user.id : null;
			const knownViewer = req.user?.visibilityUser || null;
			const {
				posts: discoveredPosts = [],
				visibilityContext,
				has_more,
				next_cursor,
			} = await getDiscoverableModePage(db, {
				mode: 'search',
				query: q,
				viewerId: currentUserId,
				knownViewer,
				limit,
				offset,
				beforeId,
				ngWords: getViewerNgWords(req),
			});
			const posts = await serializePostsBatch(
				db,
				discoveredPosts,
				currentUserId,
				getPublicUrl(req),
				knownViewer,
				visibilityContext,
				);
				const groupPage = currentUserId != null && typeof db.searchGroupPostIds === 'function'
					? await db.searchGroupPostIds(currentUserId, q, { limit, offset, beforeId })
					: { ids: [], has_more: false, next_cursor: null };
				const groupPosts = await serializePostsByIds(
					db,
					groupPage.ids || [],
					currentUserId,
					getPublicUrl(req),
					knownViewer,
				);
				const mergedPosts = [...posts, ...groupPosts]
					.sort((left, right) => new Date(right.created_at || 0).getTime() - new Date(left.created_at || 0).getTime())
					.slice(0, limit);
				res.json({ posts: mergedPosts, has_next: has_more || Boolean(groupPage.has_more), next_cursor: next_cursor || groupPage.next_cursor || null });
		} catch (err) {
			console.error('[posts] search error:', err);
		res.status(500).json({ error: '検索に失敗しました' });
	}
});

router.get({
	path: '/recommended',
	summary: 'おすすめ投稿一覧の取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
	const beforeId = safeParsePostId(req.query.before_id);
	const offset = beforeId == null ? (parseInt(req.query.offset, 10) || 0) : 0;

		try {
			const currentUserId = req.user ? req.user.id : null;
			const knownViewer = req.user?.visibilityUser || null;
			const {
				posts: discoveredPosts = [],
				visibilityContext,
				has_more,
				next_cursor,
			} = await getDiscoverableModePage(db, {
				mode: 'recommended',
				viewerId: currentUserId,
				knownViewer,
				limit,
				offset,
				beforeId,
				ngWords: getViewerNgWords(req),
			});
			const posts = await serializePostsBatch(
				db,
				discoveredPosts,
				currentUserId,
				getPublicUrl(req),
				knownViewer,
				visibilityContext,
			);
			res.json({ posts, has_next: has_more, next_cursor });
	} catch (err) {
		console.error('[posts] recommended error:', err);
		res.status(500).json({ error: 'おすすめ投稿の取得に失敗しました' });
	}
});

router.get({
	path: '/page',
	summary: '投稿一覧のページネーション取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const mode = String(req.query.mode || 'timeline');
	if (mode === 'search') {
		let blocked = false;
		searchLimiter(req, res, () => {});
		if (res.headersSent) return;
	}
	const tab = String(req.query.tab || 'foryou');
	const isDiscoverableMode = [
		'timeline',
		'recommended',
		'search',
	].includes(mode);
	const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
	const beforeId = safeParsePostId(req.query.before_id);
	const offset = beforeId == null ? Math.max(parseInt(req.query.offset, 10) || 0, 0) : 0;
	const currentUserId = req.user ? req.user.id : null;
	const knownViewer = req.user?.visibilityUser || null;
	const ngWords = getViewerNgWords(req);

	const ngWordsKey = ngWords ? [...ngWords].sort().join(',') : '';
	const cacheKey = `${mode}:${tab}:${req.query.q || ''}:${currentUserId || 0}:${ngWordsKey}:${limit}:${offset}:${beforeId || 0}`;
	const cachedResult = timelineCacheManager.getIds(cacheKey);

	try {
		let result;
		if (cachedResult) {
			result = cachedResult;
		} else if (isDiscoverableMode) {
			result = await getDiscoverableModePage(db, {
				mode,
				tab,
				query: String(req.query.q || ''),
				viewerId: currentUserId,
				knownViewer,
				limit,
				offset,
				beforeId,
					ngWords,
			});
			if (result?.ids) {
				timelineCacheManager.setIds(cacheKey, result);
			}
		} else if (mode === 'profile') {
			const userId = safeParsePostId(req.query.user_id);
			if (!userId) return res.status(400).json({ error: 'user_id is required' });
			const subType = ['all', 'posts_only', 'replies_only'].includes(req.query.sub_type)
				? req.query.sub_type
				: 'all';
			if (db.getProfilePostIds) {
				result = await db.getProfilePostIds({ userId, subType, limit, offset, beforeId });
			} else {
				const posts = await db.getPostsByUserId(userId, offset + limit + 1, currentUserId);
				const filtered = posts.filter((post) => (
					(beforeId == null || Number(post.id) < beforeId) &&
					(subType === 'posts_only' ? post.replyTo == null
						: subType === 'replies_only' ? post.replyTo != null : true)
				));
				result = {
					ids: filtered.slice(offset, offset + limit).map((post) => post.id),
					has_more: filtered.length > offset + limit,
				};
			}
			const pinId = safeParsePostId(req.query.pin_id);
			if (beforeId == null && offset === 0 && pinId && !result.ids.includes(pinId)) result.ids.push(pinId);
		} else if (mode === 'ids') {
			const ids = String(req.query.ids || '')
				.split(',')
				.map(safeParsePostId)
				.filter(Boolean)
				.slice(offset, offset + limit);
			result = { ids, has_more: false };
		} else {
			return res.status(400).json({ error: 'Unsupported post page mode' });
		}

			const nextCursor = result.next_cursor ?? (
				!result.use_offset_pagination && result.has_more && result.ids?.length > 0
					? result.ids[result.ids.length - 1]
					: null
			);
			const providedPostMap = Array.isArray(result.posts)
				? new Map(result.posts.filter(Boolean).map((post) => [Number(post.id), post]))
				: null;
			// アダプターが候補と同時に返した投稿本体はID順に並べ直す。
			// pin_id等で本体が不足する場合は、従来どおりID取得へ戻す。
			const providedPosts = providedPostMap && Array.isArray(result.ids)
				&& result.ids.every((id) => providedPostMap.has(Number(id)))
				? result.ids.map((id) => providedPostMap.get(Number(id)))
				: null;
			const discoveredPosts = providedPosts;
			const discoveredPostIds = discoveredPosts
				? discoveredPosts.map((post) => Number(post.id))
				: null;
			// serializePostsBatch() は可視性判定まで一括で行う。
			// ここでの事前判定を省くことで、著者・閲覧者・フォロー関係の重複取得を防ぐ。
			const posts = discoveredPosts
				? await serializePostsBatch(
					db,
					discoveredPosts,
					currentUserId,
					getPublicUrl(req),
					knownViewer,
					result.visibilityContext || null,
				)
				: await serializePostsByIds(
					db,
					result.ids || [],
					currentUserId,
					getPublicUrl(req),
					knownViewer,
				);
			const requestedPostCount = discoveredPostIds?.length ?? posts.length;
		const postContext = collectPostContext(posts);
		const authorIds = new Set(postContext.authors.keys());
		const missingMentionIds = postContext.mentionedIds.filter((id) => !authorIds.has(id));
		const mentionUsers = missingMentionIds.length > 0 && db.getUsersByIds
			? await db.getUsersByIds(missingMentionIds)
			: [];
		const contextUsers = [
			...postContext.authors.values(),
			...(mentionUsers || []),
		];
		
		const payload = {
			posts,
			has_more: !!result.has_more,
			next_cursor: nextCursor,
			context: {
				users: (contextUsers || []).map((user) => ({
					id: user.id,
					name: user.name || '',
					scid: user.scid || null,
					icon_data: user.icon_data || null,
					group_badges: user.group_badges || [],
				})),
			},
			meta: {
				mode,
				requested_count: requestedPostCount,
				post_count: posts.length,
				includes_metrics: true,
			},
		};

		res.json(payload);
	} catch (err) {
		console.error('[posts] page error:', err);
		res.status(500).json({ error: '投稿ページの取得に失敗しました' });
	}
});

router.get({
	path: '/ids',
	summary: 'タイムラインの投稿ID一覧取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const tab = req.query.tab || 'foryou';
	const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
	const offset = parseInt(req.query.offset, 10) || 0;
	const currentUserId = req.user ? req.user.id : null;

		try {
			const result = await getDiscoverableModePage(db, {
				mode: 'timeline',
				tab,
				viewerId: currentUserId,
				limit,
				offset,
				ngWords: getViewerNgWords(req),
			});
			res.json({ ids: result.ids, has_more: result.has_more });

	} catch (err) {
		console.error('[posts] ids error:', err);
		res.status(500).json({ error: '投稿IDの取得に失敗しました' });
	}
});

router.get({
	path: '/trending-hashtags',
	summary: 'トレンドハッシュタグ・キーワード取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
	const type = String(req.query.type || '').trim().toLowerCase();

	try {
		const result = await db.getTrendingHashtags(limit, { type, detailed: true });
		if (!req.user) {
			res.set('Cache-Control', 'public, max-age=30, s-maxage=30, stale-while-revalidate=60');
		}
		if (Array.isArray(result)) {
			const hashtags = result.filter((item) => String(item.tag_name || '').startsWith('#'));
			const words = result.filter((item) => !String(item.tag_name || '').startsWith('#'));
			res.json({ trends: result, hashtags, tags: words, words });
		} else {
			res.json({
				trends: result.trends || [],
				hashtags: result.hashtags || [],
				tags: result.tags || result.words || [],
				words: result.words || result.tags || [],
			});
		}
	} catch (err) {
		console.error('[posts] trending-hashtags error:', err);
		res.status(500).json({ error: 'トレンドの取得に失敗しました' });
	}
});

router.post({
	path: '/hydrate',
	summary: '投稿IDリストから投稿オブジェクトを一括生成',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const postIds = [...new Set((req.body.post_ids || [])
		.map((id) => parseInt(id, 10))
		.filter((id) => Number.isInteger(id) && id > 0))].slice(0, config.limits.postBatchSize);

	try {
			const currentUserId = req.user ? req.user.id : null;
			const knownViewer = req.user?.visibilityUser || null;
			const posts = await serializePostsByIds(
				db,
				postIds,
				currentUserId,
				getPublicUrl(req),
				knownViewer,
			);
		res.json({ posts });
	} catch (err) {
		console.error('[posts] hydrate error:', err);
		res.status(500).json({ error: '投稿の取得に失敗しました' });
	}
});

router.post({
	path: '/metrics',
	summary: '投稿IDリストのメトリクス一括取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const postIds = [...new Set((req.body.post_ids || [])
		.map((id) => parseInt(id, 10))
		.filter((id) => Number.isInteger(id) && id > 0))].slice(0, config.limits.postBatchSize);

	try {
			const currentUserId = req.user ? req.user.id : null;
			const knownViewer = req.user?.visibilityUser || null;
			const viewableIds = await getViewablePostIds(
				db,
				postIds,
				currentUserId,
				knownViewer,
			);
		const metrics = db.getPostMetricsBatch
			? await db.getPostMetricsBatch(viewableIds, currentUserId)
			: await Promise.all(viewableIds.map(async (postId) => ({
				post_id: postId,
				like_count: db.getLikeCount ? await db.getLikeCount(postId) : 0,
				star_count: db.getStarCount ? await db.getStarCount(postId) : 0,
				reply_count: db.getReplyCount ? await db.getReplyCount(postId) : 0,
				repost_count: db.getRepostCount ? await db.getRepostCount(postId) : 0,
			})));
		res.json({ metrics });
	} catch (err) {
		console.error('[posts] metrics error:', err);
		res.status(500).json({ error: '集計の取得に失敗しました' });
	}
});

router.get({
	path: '/:id/thread',
	summary: '投稿のスレッド階層取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const postId = safeParsePostId(req.params.id);
	if (!postId) return res.status(400).json({ error: 'Invalid post id' });

		try {
			const currentUserId = req.user ? req.user.id : null;
			const knownViewer = req.user?.visibilityUser || null;
			const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
		const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
		const root = await db.getPostById(postId);
		const replyPage = await getThreadReplyPostIds(db, postId, limit, offset);
		const replyPostsById = new Map(
			(await db.getPostsByIds(replyPage.ids)).filter(Boolean).map((post) => [Number(post.id), post]),
		);
		const orderedReplyPosts = replyPage.ids
			.map((id) => replyPostsById.get(Number(id)))
			.filter(Boolean);

		if (!root) {
			// 削除済みの親投稿は返信が存在する場合だけ仮想的に表示する。
			// 参照先を完全に欠くIDや、閲覧者に見えない返信しかないIDを列挙できないようにする。
			const replies = await serializePostsBatch(
				db,
				orderedReplyPosts,
				currentUserId,
				getPublicUrl(req),
				knownViewer,
			);
			if (replies.length === 0) {
				return res.status(404).json({ error: 'Post not found' });
			}
			return res.json({
				post: {
					id: postId,
					unknown: true,
					user: { id: null, name: 'UnknownPost', scid: 'unknown', nyaitter_id: '@unknown' },
					author: { id: null, name: 'UnknownPost', scid: 'unknown', nyaitter_id: '@unknown' },
				},
				replies,
				has_more: replyPage.has_more,
				offset,
				limit,
			});
		}

		// 先祖の解決
		const ancestorPosts = [];
		let currentParentId = root.replyTo ?? root.reply_id ?? root.reply_to;
		const visitedParentIds = new Set([postId]);
		while (currentParentId != null) {
			const numParentId = Number(currentParentId);
			if (!Number.isInteger(numParentId) || numParentId <= 0 || visitedParentIds.has(numParentId)) {
				break;
			}
			visitedParentIds.add(numParentId);
			const parentPost = await db.getPostById(numParentId);
			if (!parentPost) break;
			ancestorPosts.unshift(parentPost); // ルート親から直前親への昇順
			currentParentId = parentPost.replyTo ?? parentPost.reply_id ?? parentPost.reply_to;
		}

		const postsToSerialize = [...ancestorPosts, root, ...orderedReplyPosts];
		const serializedPosts = await serializePostsBatch(
			db,
			postsToSerialize,
			currentUserId,
			getPublicUrl(req),
			knownViewer,
		);
		const serializedAncestors = serializedPosts.slice(0, ancestorPosts.length);
		const mainPost = serializedPosts[ancestorPosts.length] || null;
		const serializedReplies = serializedPosts.slice(ancestorPosts.length + 1);

		if (!mainPost) {
			return res.status(404).json({ error: 'Post not found' });
		}

		res.json({
			post: mainPost,
			ancestors: serializedAncestors,
			replies: serializedReplies,
			has_more: replyPage.has_more,
			offset,
			limit,
		});
	} catch (err) {
		console.error('[posts] thread error:', err);
		res.status(500).json({ error: '投稿スレッドの取得に失敗しました' });
	}
});

router.get({
	path: '/:id',
	summary: '個別投稿の取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const postId = safeParsePostId(req.params.id);
	const currentUserId = req.user ? req.user.id : null;
	const knownViewer = req.user?.visibilityUser || null;

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const post = await db.getPostById(postId);
		if (!post) {
			return res.status(404).json({ error: 'Post not found' });
		}
		const userAgent = req.headers['user-agent'] || '';
		const isApiRequest = req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/server/api/');

		if (!isApiRequest) {
			if (isCrawler(userAgent)) {
				// Serve OGP HTML for crawlers / embed bots
				const author = await db.getUserById(post.userId ?? post.user_id);
				const publicUrl = getPublicUrl(req);
				const frontendUrl = config.frontendUrl || null;
				const html = generatePostHtml({ post, author, publicUrl, frontendUrl });
				res.setHeader('Content-Type', 'text/html; charset=utf-8');
				return res.send(html);
			} else if (req.accepts(['html', 'json']) === 'html') {
				// Human visitor in web browser: HTTP 302 redirect directly to SPA post hash
				let redirectUrl = '';
				if (config.frontendUrl) {
					redirectUrl = `${config.frontendUrl.replace(/\/+$/, '')}/#post/${post.id}`;
				} else {
					const host = req.get('host') || req.hostname || 'localhost';
					const cleanHost = host.replace(/^(?:link|api)\./i, '');
					const forwardedProto = req.get('x-forwarded-proto') || req.get('x-forwarded-protocol');
					const isLocal = cleanHost.startsWith('localhost') || cleanHost.startsWith('127.0.0.1');
					const proto = (forwardedProto || (isLocal ? 'http' : 'https')).toLowerCase();
					redirectUrl = `${proto}://${cleanHost}/#post/${post.id}`;
				}
				return res.redirect(302, redirectUrl);
			}
		}

		const serializedPost = await serializePost(
			db,
			post,
			currentUserId,
			0,
			getPublicUrl(req),
			knownViewer,
		);
		if (!serializedPost) {
			return res.status(404).json({ error: 'Post not found' });
		}
		res.json({ post: serializedPost });

	} catch (err) {
		console.error('[posts] detail error:', err);
		res.status(500).json({ error: '投稿の取得に失敗しました' });
	}
});

router.get({
	path: '/:id/replies',
	summary: '個別投稿のリプライ一覧取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const postId = safeParsePostId(req.params.id);
	const currentUserId = req.user ? req.user.id : null;
	const knownViewer = req.user?.visibilityUser || null;

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const root = await db.getPostById(postId);
		if (!root) {
			return res.status(404).json({ error: 'Post not found' });
		}
		const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
		const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
		const page = await db.getReplyPostIds(postId, limit, offset);
		const replyPostsById = new Map(
			(await db.getPostsByIds(page.ids)).filter(Boolean).map((post) => [Number(post.id), post]),
		);
		const orderedReplyPosts = page.ids
			.map((id) => replyPostsById.get(Number(id)))
			.filter(Boolean);
		const serializedPosts = await serializePostsBatch(
			db,
			[root, ...orderedReplyPosts],
			currentUserId,
			getPublicUrl(req),
			knownViewer,
		);
		if (!serializedPosts[0]) {
			return res.status(404).json({ error: 'Post not found' });
		}
		res.json({ replies: serializedPosts.slice(1), has_more: page.has_more, offset, limit });
	} catch (err) {
		console.error('[posts] replies error:', err);
		res.status(500).json({ error: 'リプライの取得に失敗しました' });
	}
});

router.post({
	path: '/:id/like',
	summary: '投稿へのいいね',
	auth: 'required',
}, requireAuth, postWriteLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const storage = getStorageAdapter(req);
	const postService = new PostService({ dbAdapter: db, storageAdapter: storage });

	const postId = safeParsePostId(req.params.id);
	const userId = req.user.id;

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const post = await db.getPostById(postId);
		if (!post || !(await canViewPost(db, post, userId, null, null, req.user?.visibilityUser || null))) {
			return res.status(404).json({ error: 'Post not found' });
		}
		const result = await postService.toggleLike(userId, postId);
		timelineCacheManager.updatePostMetrics(postId, {
			like_count: result.count,
			likeCount: result.count,
		});

		if (result.liked) {
			if (post.userId !== userId) {
					const notification = await createNotificationIfAllowed(db, {
						userId: post.userId,
						type: 'like',
						fromUserId: userId,
					target: { kind: 'post', id: postId },
					});
					await publishNewNotification(req, post.userId, notification);
			}
		}

		const updatedLikes = await db.getLikeIds(userId);

		res.json({
			success: true,
			liked: result.liked,
			count: result.count,
			updated_likes: updatedLikes,
		});
	} catch (err) {
		console.error('[posts] like error:', err);
		res.status(500).json({ error: 'いいね処理に失敗しました' });
	}
});

router.post({
	path: '/:id/star',
	summary: '投稿へのスター',
	auth: 'required',
}, requireAuth, postWriteLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const storage = getStorageAdapter(req);
	const postService = new PostService({ dbAdapter: db, storageAdapter: storage });

	const postId = safeParsePostId(req.params.id);
	const userId = req.user.id;

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const post = await db.getPostById(postId);
		if (!post || !(await canViewPost(db, post, userId, null, null, req.user?.visibilityUser || null))) {
			return res.status(404).json({ error: 'Post not found' });
		}
		const result = await postService.toggleStar(userId, postId);
		timelineCacheManager.updatePostMetrics(postId, {
			star_count: result.count,
			starCount: result.count,
		});

		const updatedStars = await db.getStarIds(userId);

		res.json({
			success: true,
			starred: result.starred,
			count: result.count,
			updated_stars: updatedStars,
		});
	} catch (err) {
		console.error('[posts] star error:', err);
		res.status(500).json({ error: 'スター処理に失敗しました' });
	}
});

router.delete({
	path: '/:id',
	summary: '個別投稿の削除',
	auth: 'required',
}, requireAuth, postWriteLimiter, (req, res) => {
	const postId = safeParsePostId(req.params.id);
	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	const queue = req.app.locals.postActionQueue;
	if (!queue) {
		return res.status(503).json({ error: 'Post action queue is unavailable' });
	}
	try {
		const context = createPostActionContext(req);
		const userId = Number(req.user.id);
		const actionId = queue.enqueue('delete', () => processDeletePostAction(
			context,
			{ postId, userId },
		));
		return res.status(202).json({ success: true, queued: true, action_id: actionId });
	} catch (error) {
		return res.status(error.statusCode || 503).json({ error: error.message });
	}
});

router.delete({
	path: '/admin/:id',
	summary: '管理者による投稿削除',
	auth: 'admin',
}, requireAuth, postWriteLimiter, (req, res) => {
	const postId = safeParsePostId(req.params.id);

	if (!req.user.admin) {
		return res.status(403).json({ error: 'Admin access required' });
	}
	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	const queue = req.app.locals.postActionQueue;
	if (!queue) {
		return res.status(503).json({ error: 'Post action queue is unavailable' });
	}
	try {
		const context = createPostActionContext(req);
		const userId = Number(req.user.id);
		const actionId = queue.enqueue('admin-delete', () => processDeletePostAction(
			context,
			{ postId, userId, admin: true },
		));

		try {
			const LogHubManager = require('../services/managementTool/LogHubManager');
			LogHubManager.appendExternalLog({
				type: 'admin',
				level: 'warn',
				source: 'admin-action',
				message: `[Admin] 管理者 @${req.user.name || req.user.username} (#${req.user.id}) がポスト #${postId} を管理者権限で削除`,
				details: { adminUserId: req.user.id, postId, action: 'admin_delete_post' },
			});
		} catch (_) {}

		return res.status(202).json({ success: true, queued: true, action_id: actionId });
	} catch (error) {
		return res.status(error.statusCode || 503).json({ error: error.message });
	}
});

router.get({
	path: '/:id/activity',
	summary: '投稿のアクティビティ情報取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const postId = safeParsePostId(req.params.id);

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const post = await db.getPostById(postId);
		const currentUserId = req.user ? Number(req.user.id) : null;
		if (!post || !(await canViewPost(db, post, currentUserId, null, null, req.user?.visibilityUser || null))) {
			return res.status(404).json({ error: 'Post not found' });
		}

		const isAuthor = Boolean(currentUserId && (Number(post.userId) === currentUserId || req.user?.admin));

		// リポスト数・引用ポスト数
		const reposts = await db.getRepostsOfPost(postId, 100);
		const quotePosts = await db.getQuotesOfPost(postId, 100);

		// いいね数
		let likesCount = undefined;
		if (isAuthor) {
			const likes = await db.getLikesOfPost(postId, 100);
			likesCount = Array.isArray(likes) ? likes.length : 0;
		}

		res.json({
			success: true,
			is_author: isAuthor,
			counts: {
				reposts: Array.isArray(reposts) ? reposts.length : 0,
				quotes: Array.isArray(quotePosts) ? quotePosts.length : 0,
				likes: likesCount,
			},
		});
	} catch (err) {
		console.error('[posts] activity error:', err);
		res.status(500).json({ error: 'ポストアクティビティの取得に失敗しました' });
	}
});

router.get({
	path: '/:id/quotes',
	summary: '投稿の引用ポスト一覧取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const postId = safeParsePostId(req.params.id);
	const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const post = await db.getPostById(postId);
		const currentUserId = req.user ? Number(req.user.id) : null;
		if (!post || !(await canViewPost(db, post, currentUserId, null, null, req.user?.visibilityUser || null))) {
			return res.status(404).json({ error: 'Post not found' });
		}
		const quotePosts = await db.getQuotesOfPost(postId, limit);
		const serializedQuotes = await serializePostsBatch(db, quotePosts, currentUserId, getPublicUrl(req));
		res.json({ quotes: serializedQuotes });
	} catch (err) {
		console.error('[posts] quotes list error:', err);
		res.status(500).json({ error: '引用ポスト一覧の取得に失敗しました' });
	}
});

router.get({
	path: '/:id/reposts',
	summary: '投稿のリポスト一覧取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const postId = safeParsePostId(req.params.id);
	const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const post = await db.getPostById(postId);
		const currentUserId = req.user ? Number(req.user.id) : null;
		if (!post || !(await canViewPost(db, post, currentUserId, null, null, req.user?.visibilityUser || null))) {
			return res.status(404).json({ error: 'Post not found' });
		}
		const reposts = await db.getRepostsOfPost(postId, limit);
		res.json({ reposts });
	} catch (err) {
		console.error('[posts] reposts list error:', err);
		res.status(500).json({ error: 'リポスト一覧の取得に失敗しました' });
	}
});

router.get({
	path: '/:id/likes',
	summary: '投稿にいいねしたユーザー一覧取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const postId = safeParsePostId(req.params.id);
	const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const post = await db.getPostById(postId);
		const currentUserId = req.user ? Number(req.user.id) : null;
		if (!post || !(await canViewPost(db, post, currentUserId, null, null, req.user?.visibilityUser || null))) {
			return res.status(404).json({ error: 'Post not found' });
		}
		const isAuthor = Boolean(currentUserId && (Number(post.userId) === currentUserId || req.user?.admin));
		if (!isAuthor) {
			return res.status(403).json({ error: 'いいね一覧の閲覧権限がありません' });
		}
		const likes = await db.getLikesOfPost(postId, limit);
		res.json({ likes });
	} catch (err) {
		console.error('[posts] likes list error:', err);
		res.status(500).json({ error: 'いいね一覧の取得に失敗しました' });
	}
});

router.post({
	path: '/:id/repost',
	summary: '投稿のリポスト実行',
	auth: 'required',
}, requireAuth, postWriteLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const postId = safeParsePostId(req.params.id);
	const userId = req.user.id;

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const original = await db.getPostById(postId);
		if (!original || !(await canViewPost(db, original, userId, null, null, req.user?.visibilityUser || null))) {
			return res.status(404).json({ error: 'Post not found' });
		}
		const repost = await db.repostPost(userId, postId);
		res.status(201).json({
			success: true,
			post: await serializePost(db, repost, userId, 0, getPublicUrl(req)),
		});
	} catch (err) {
		console.error('[posts] repost error:', err);
		res.status(400).json({ error: err.message || 'リポストに失敗しました' });
	}
});

router.post({
	path: '/:id/pin',
	summary: 'プロフィールの固定投稿ピン留め',
	auth: 'required',
}, requireAuth, postWriteLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const postId = safeParsePostId(req.params.id);
	const userId = req.user.id;

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const result = await db.togglePin(userId, postId);
		const pinId = result.pinned ? postId : null;
		res.json({ success: true, pinned: result.pinned, pin_id: pinId });
	} catch (err) {
		console.error('[posts] pin error:', err);
		res.status(400).json({ error: err.message || 'ピン留め処理に失敗しました' });
	}
});

router.post({
	path: '/:id/dislike',
	summary: '投稿への低評価',
	auth: 'required',
}, requireAuth, postWriteLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const postId = safeParsePostId(req.params.id);
	const userId = req.user.id;

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		if (typeof db.dislikePost === 'function') {
			await db.dislikePost(userId, postId);
		}
		res.json({ success: true, message: '関連性が低いと評価しました' });
	} catch (err) {
		console.error('[posts] dislike error:', err);
		res.status(500).json({ error: '処理に失敗しました' });
	}
});

router.put({
	path: '/:id',
	summary: '個別投稿の編集・更新',
	auth: 'required',
}, requireAuth, postWriteLimiter, (req, res) => {
	const postId = safeParsePostId(req.params.id);
	const userId = req.user.id;

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	const { content, attachments, mask, lock, reply_control, replyControl } = req.body || {};

	if (typeof content !== 'string' || content.trim().length === 0) {
		return res.status(400).json({ error: 'content is required' });
	}
	if (!isWithinRange(content.trim().length, config.limits.postContentLength)) {
		return res.status(400).json({ error: contentLengthError(config.limits.postContentLength) });
	}
	if (attachments !== undefined) {
		try {
			validateAttachmentReferences(attachments, userId);
		} catch (error) {
			return res.status(400).json({ error: error.message || 'Invalid attachments' });
		}
	}

	const rawReplyControl = reply_control ?? replyControl;
	const normalizedReplyControl = rawReplyControl !== undefined
		? (['everyone', 'following', 'mentioned', 'following_or_mentioned', 'mentioned_only'].includes(rawReplyControl)
			? (rawReplyControl === 'following_or_mentioned' ? 'following' : (rawReplyControl === 'mentioned_only' ? 'mentioned' : rawReplyControl))
			: 'everyone')
		: undefined;

	const queue = req.app.locals.postActionQueue;
	if (!queue) {
		return res.status(503).json({ error: 'Post action queue is unavailable' });
	}

	try {
		const context = createPostActionContext(req);
		const actionId = queue.enqueue('edit', () => processEditPostAction(context, {
			postId,
			userId,
			content,
			attachments,
			mask,
			lock,
			replyControl: normalizedReplyControl,
		}));
		return res.status(202).json({ success: true, queued: true, action_id: actionId });
	} catch (error) {
		return res.status(error.statusCode || 503).json({ error: error.message });
	}
});

module.exports = router;
