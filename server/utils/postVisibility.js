'use strict';

const { normalizeBlockList } = require('./blockList');

function getPostAuthorId(post) {
	const value = post?.userId ?? post?.user_id ?? post?.userid;
	const id = Number(value);
	return Number.isInteger(id) ? id : null;
}

function getReplyToPostId(post) {
	const value = post?.replyTo ?? post?.reply_to ?? post?.reply_id;
	const id = Number(value);
	return Number.isInteger(id) && id > 0 ? id : null;
}

function getPostGroupId(post) {
	const groupId = post?.groupId ?? post?.group_id ?? null;
	return typeof groupId === 'string' && groupId.trim() ? groupId.trim() : null;
}

function normalizeUserId(value) {
	const id = Number(value);
	return Number.isInteger(id) ? id : null;
}

/**
 * 投稿の非公開状態を返す。
 * 投稿自身の lock または投稿者設定 settings.lock のいずれかが有効なら非公開である。
 */
function isPrivatePost(post, author = null) {
	return Boolean(post?.lock || author?.settings?.lock);
}

async function getAuthorsById(db, posts) {
	const ids = [...new Set((posts || [])
		.map(getPostAuthorId)
		.filter((id) => id != null))];
	if (ids.length === 0) return new Map();

	let authors = [];
	if (typeof db.getUsersByIds === 'function') {
		try {
			authors = (await db.getUsersByIds(ids)).filter(Boolean);
		} catch (_) {}
	}

	const byId = new Map(authors.map((author) => [Number(author.id), author]));
	const missingIds = ids.filter((id) => !byId.has(id));
	if (missingIds.length > 0 && typeof db.getUserById === 'function') {
		const completeAuthors = await Promise.all(missingIds.map((id) => db.getUserById(id)));
		for (const author of completeAuthors.filter(Boolean)) byId.set(Number(author.id), author);
	}
	return byId;
}

function normalizeFollowRelationshipSnapshot(value) {
	return {
		followingIds: new Set((value?.followingIds ?? value?.following_ids ?? [])
			.map(normalizeUserId)
			.filter((id) => id != null)),
		followerIds: new Set((value?.followerIds ?? value?.follower_ids ?? [])
			.map(normalizeUserId)
			.filter((id) => id != null)),
	};
}

/**
 * 候補投稿者に限定した閲覧者のフォロー関係を取得する。
 * 実装済みアダプターでは1回のDB操作（D1では1回のWorker往復）で完了する。
 * 旧アダプターには安全な後方互換フォールバックを残す。
 */
async function getFollowRelationshipSnapshot(db, viewerId, authorIds) {
	const normalizedViewerId = normalizeUserId(viewerId);
	const ids = [...new Set((authorIds || [])
		.map(normalizeUserId)
		.filter((id) => id != null && id !== normalizedViewerId))];
	if (normalizedViewerId == null || ids.length === 0) {
		return { followingIds: new Set(), followerIds: new Set() };
	}

	if (typeof db.getFollowRelationshipSnapshot === 'function') {
		try {
			return normalizeFollowRelationshipSnapshot(await db.getFollowRelationshipSnapshot(
				normalizedViewerId,
				ids,
			));
		} catch (error) {
			console.warn('[postVisibility] batch follow relationship fallback:', error.message);
		}
	}

	const followingIds = new Set(
		typeof db.getFollowIds === 'function'
			? (await db.getFollowIds(normalizedViewerId)).map(Number)
			: [],
	);
	const followerIds = new Set();
	if (typeof db.isFollowing === 'function') {
		const reciprocalIds = await Promise.all(ids
			.filter((authorId) => followingIds.has(authorId))
			.map(async (authorId) => (
				await db.isFollowing(authorId, normalizedViewerId) ? authorId : null
			)));
		for (const authorId of reciprocalIds) {
			if (authorId != null) followerIds.add(authorId);
		}
	}
	return { followingIds, followerIds };
}

/**
 * ページに含まれる投稿の可視性判定に必要なデータを一括取得する。
 * ブロックは閲覧者と投稿者の正規化済みblock配列だけで判定し、相互フォローは
 * 候補投稿者に限定した関係スナップショットで判定するため、投稿件数に比例した
 * DB/Worker呼び出しを発生させない。
 */
async function createPostVisibilityContext(
	db,
	posts,
	viewerId = null,
	authorsById = null,
	knownViewer = null,
) {
	const values = (posts || []).filter(Boolean);
	const normalizedViewerId = normalizeUserId(viewerId);
	const resolvedAuthorsById = authorsById || await getAuthorsById(db, values);
	const authorIds = [...new Set(values
		.map(getPostAuthorId)
		.filter((id) => id != null))];
	const canReuseKnownViewer = normalizedViewerId != null
		&& Number(knownViewer?.id) === normalizedViewerId
		&& Object.prototype.hasOwnProperty.call(knownViewer, 'settings')
		&& Object.prototype.hasOwnProperty.call(knownViewer, 'block');

	// 返信先ポストの作者情報を解決
	const replyToPostIds = [...new Set(values
		.map(getReplyToPostId)
		.filter((id) => id != null))];
	const existingPostsById = new Map(values.map((p) => [Number(p.id), p]));
	const missingParentIds = replyToPostIds.filter((id) => !existingPostsById.has(id));

	const hasGroupPosts = values.some((post) => Boolean(getPostGroupId(post)));
	const [viewer, followSnapshot, fetchedParents, activeGroupIds] = await Promise.all([
		canReuseKnownViewer
			? knownViewer
			: normalizedViewerId != null && typeof db.getUserById === 'function'
				? db.getUserById(normalizedViewerId)
				: null,
		getFollowRelationshipSnapshot(db, normalizedViewerId, authorIds),
		missingParentIds.length > 0 && typeof db.getPostsByIds === 'function'
			? db.getPostsByIds(missingParentIds).catch((err) => {
				console.warn('[postVisibility] batch parent posts fallback:', err.message);
				return [];
			})
			: [],
		hasGroupPosts && normalizedViewerId != null && typeof db.getUserGroups === 'function'
			? db.getUserGroups(normalizedViewerId, { status: 'active', limit: 200, offset: 0 })
				.then((groups) => new Set((groups || []).map((group) => String(group.id))))
				.catch((err) => {
					console.warn('[postVisibility] group membership fallback:', err.message);
					return new Set();
				})
			: new Set(),
	]);

	const replyToAuthorIdsByReplyId = new Map();
	for (const post of values) {
		if (post?.id) {
			const authorId = getPostAuthorId(post);
			if (authorId != null) replyToAuthorIdsByReplyId.set(Number(post.id), authorId);
		}
	}
	for (const parent of fetchedParents || []) {
		if (parent?.id) {
			const authorId = getPostAuthorId(parent);
			if (authorId != null) replyToAuthorIdsByReplyId.set(Number(parent.id), authorId);
		}
	}

	return {
		viewerId: normalizedViewerId,
		viewer,
		authorsById: resolvedAuthorsById,
		viewerBlockedIds: new Set(normalizeBlockList(viewer?.block, viewer?.id)),
		followingIds: followSnapshot.followingIds,
		followerIds: followSnapshot.followerIds,
		relationshipAuthorIds: new Set(authorIds.filter((id) => id !== normalizedViewerId)),
		replyToAuthorIdsByReplyId,
		activeGroupIds,
	};
}

/**
 * 既存の可視性コンテキストを、追加の投稿者に必要な関係だけ取得して拡張する。
 * 投稿参照の投稿者が探索結果の候補に含まれていない場合も、公開範囲を緩めずに判定できる。
 */
async function extendPostVisibilityContext(
	db,
	visibilityContext,
	posts,
	viewerId = null,
	authorsById = null,
	knownViewer = null,
) {
	const normalizedViewerId = normalizeUserId(viewerId);
	if (!visibilityContext || visibilityContext.viewerId !== normalizedViewerId) {
		return createPostVisibilityContext(db, posts, viewerId, authorsById, knownViewer);
	}

	const values = (posts || []).filter(Boolean);
	const resolvedAuthorsById = authorsById || await getAuthorsById(db, values);
	const mergedAuthorsById = new Map(visibilityContext.authorsById || []);
	for (const [authorId, author] of resolvedAuthorsById) {
		mergedAuthorsById.set(Number(authorId), author);
	}

	const authorIds = [...new Set(values
		.map(getPostAuthorId)
		.filter((id) => id != null))];
	const knownRelationshipAuthorIds = new Set(
		[...(visibilityContext.relationshipAuthorIds || [])]
			.map(normalizeUserId)
			.filter((id) => id != null),
	);
	const missingRelationshipAuthorIds = authorIds.filter((authorId) => (
		authorId !== normalizedViewerId && !knownRelationshipAuthorIds.has(authorId)
	));

	// 返信先ポストの作者情報を解決
	const replyToPostIds = [...new Set(values
		.map(getReplyToPostId)
		.filter((id) => id != null))];
	const mergedReplyToAuthorIds = new Map(visibilityContext.replyToAuthorIdsByReplyId || []);
	for (const post of values) {
		if (post?.id) {
			const authorId = getPostAuthorId(post);
			if (authorId != null) mergedReplyToAuthorIds.set(Number(post.id), authorId);
		}
	}
	const missingParentIds = replyToPostIds.filter((id) => !mergedReplyToAuthorIds.has(id));

	const [additionalRelationships, fetchedParents] = await Promise.all([
		getFollowRelationshipSnapshot(
			db,
			normalizedViewerId,
			missingRelationshipAuthorIds,
		),
		missingParentIds.length > 0 && typeof db.getPostsByIds === 'function'
			? db.getPostsByIds(missingParentIds).catch((err) => {
				console.warn('[postVisibility] batch parent posts fallback:', err.message);
				return [];
			})
			: [],
	]);

	for (const authorId of missingRelationshipAuthorIds) knownRelationshipAuthorIds.add(authorId);
	for (const parent of fetchedParents || []) {
		if (parent?.id) {
			const authorId = getPostAuthorId(parent);
			if (authorId != null) mergedReplyToAuthorIds.set(Number(parent.id), authorId);
		}
	}

	const viewer = visibilityContext.viewer || (
		normalizedViewerId != null && Number(knownViewer?.id) === normalizedViewerId
			? knownViewer
			: null
	);
	if (normalizedViewerId != null && !viewer) {
		return createPostVisibilityContext(db, posts, viewerId, mergedAuthorsById, knownViewer);
	}
	return {
		viewerId: normalizedViewerId,
		viewer,
		authorsById: mergedAuthorsById,
		viewerBlockedIds: new Set(
			visibilityContext.viewerBlockedIds || normalizeBlockList(viewer?.block, viewer?.id),
		),
		followingIds: new Set([
			...(visibilityContext.followingIds || []),
			...additionalRelationships.followingIds,
		]),
		followerIds: new Set([
			...(visibilityContext.followerIds || []),
			...additionalRelationships.followerIds,
		]),
		relationshipAuthorIds: knownRelationshipAuthorIds,
		replyToAuthorIdsByReplyId: mergedReplyToAuthorIds,
		activeGroupIds: new Set(visibilityContext.activeGroupIds || []),
	};
}

function hasBlockRelationshipInContext(context, authorId) {
	if (!context || context.viewerId == null || context.viewerId === authorId) return false;
	if (context.viewerBlockedIds?.has(authorId)) return true;
	const author = context.authorsById?.get(authorId) || null;
	return normalizeBlockList(author?.block, author?.id).includes(context.viewerId);
}

function canViewPostWithContext(post, context) {
	if (!post || !context) return false;
	const authorId = getPostAuthorId(post);
	if (authorId == null) return false;
	const author = context.authorsById?.get(authorId) || null;
	const groupId = getPostGroupId(post);

	// グループ投稿は投稿者自身を含め、現在も参加状態がactiveのメンバーだけが閲覧できる。
	// 退出後は過去投稿も閲覧できないというグループ境界を最初に適用する。
	if (groupId) {
		if (context.viewerId == null || !context.activeGroupIds?.has(groupId)) return false;
		// グループ参加者への公開範囲はグループの参加状態で決まる。
		// 通常投稿用のlock設定で参加者を除外しない。
		return !hasBlockRelationshipInContext(context, authorId);
	}
	if (hasBlockRelationshipInContext(context, authorId)) return false;
	if (!isPrivatePost(post, author)) return true;
	if (context.viewerId == null) return false;
	if (context.viewerId === authorId) return true;

	// 返信先ポストがある場合、返信先の作成者は相互フォロー関係でなくても閲覧可能
	const replyToId = getReplyToPostId(post);
	if (replyToId != null) {
		const replyToAuthorId = context.replyToAuthorIdsByReplyId?.get(replyToId)
			?? getPostAuthorId(post.replyToPost ?? post.parent_post ?? post.parentPost);
		if (replyToAuthorId != null && replyToAuthorId === context.viewerId) {
			return true;
		}
	}

	return context.followingIds.has(authorId) && context.followerIds.has(authorId);
}

/**
 * 投稿の閲覧可否を判定する。
 * 非公開投稿は投稿者本人、返信先の投稿者、または投稿者と相互フォローであるログイン済みユーザーだけが閲覧できる。
 * 未許可時は投稿の存在自体を明かさないため false を返す。
 */
async function canViewPost(
	db,
	post,
	viewerId = null,
	author = null,
	visibilityContext = null,
	knownViewer = null,
) {
	if (!post) return false;
	const authorId = getPostAuthorId(post);
	if (authorId == null) return false;
	if (visibilityContext) return canViewPostWithContext(post, visibilityContext);

	const authorsById = author ? new Map([[authorId, author]]) : null;
	const context = await createPostVisibilityContext(
		db,
		[post],
		viewerId,
		authorsById,
		knownViewer,
	);
	return canViewPostWithContext(post, context);
}

/**
 * 表示不許可の投稿を除外する。呼び出し側の入力順を維持する。
 */
async function filterViewablePosts(db, posts, viewerId = null, visibilityContext = null) {
	const values = (posts || []).filter(Boolean);
	const context = visibilityContext || await createPostVisibilityContext(db, values, viewerId);
	return values.filter((post) => canViewPostWithContext(post, context));
}

/**
 * NGワード一覧を正規化する。改行またはカンマ区切りの文字列またはstring[]を受け取り、
 * 空でない小文字のトリム済みワードのSetを返す。
 */
function normalizeNgWords(value) {
	if (!value) return new Set();
	const raw = Array.isArray(value) ? value : String(value).split(/[\n,]+/);
	return new Set(
		raw.map((w) => String(w).trim().toLowerCase()).filter((w) => w.length > 0),
	);
}

/**
 * ポストの検索対象テキストを返す（content / view_content を結合）。
 */
function getPostSearchText(post) {
	const parts = [
		post?.view_content ?? post?.viewContent ?? '',
		post?.content ?? '',
	].filter(Boolean);
	return parts.join(' ').toLowerCase();
}

/**
 * 検索除外ユーザーの投稿を発見可能な一覧へ載せるか判定する。
 * ngWords が指定されている場合は、ポストのテキスト内にNGワードが含まれていれば除外する。
 */
async function filterDiscoverablePosts(db, posts, viewerId = null, visibilityContext = null, { ngWords = null } = {}) {
	const values = (posts || []).filter(Boolean);
	const context = visibilityContext || await createPostVisibilityContext(db, values, viewerId);
	const activeNgWords = ngWords instanceof Set ? ngWords : normalizeNgWords(ngWords);
	return values.filter((post) => {
		// グループ投稿はグループ専用画面・タブでのみ公開する。
		if (getPostGroupId(post)) return false;
		const authorId = getPostAuthorId(post);
		const author = context.authorsById?.get(authorId) || null;
		if (author?.shadow) {
			if (context.viewerId == null) return false;
			if (context.viewerId !== authorId && !context.followingIds.has(authorId)) return false;
		}
		if (activeNgWords.size > 0) {
			const text = getPostSearchText(post);
			for (const word of activeNgWords) {
				if (text.includes(word)) return false;
			}
		}
		return true;
	});
}

module.exports = {
	canViewPost,
	canViewPostWithContext,
	filterViewablePosts,
	filterDiscoverablePosts,
	normalizeNgWords,
	createPostVisibilityContext,
	extendPostVisibilityContext,
	getFollowRelationshipSnapshot,
	getPostAuthorId,
	getReplyToPostId,
	getPostGroupId,
	getAuthorsById,
	isPrivatePost,
};
