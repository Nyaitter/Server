const {
	createPostVisibilityContext,
	filterDiscoverablePosts,
	filterViewablePosts,
} = require('../utils/postVisibility');
const {
	encodePostCursor,
	decodePostCursor,
} = require('../utils/postCursor');

function normalizePostIds(ids) {
	return [...new Set((ids || []).map(Number).filter(Number.isInteger))];
}

const MAX_CHUNK_ATTEMPTS = 20;

/**
 * 検索・タイムライン・おすすめ等の「発見可能な投稿一覧」を取得する。
 *
 * DBアダプターは投稿候補の並び順だけを返す。閲覧者依存の可視性
 * は、この共通層で一貫して適用する。
 * `offset` は可視な投稿に対するオフセットなので、非表示候補や
 * 表示可能ポストが0件のチャンクをまたいで必要件数に達するまでアダプターへ追加問い合わせを行う。
 */
async function getDiscoverablePostPage({
	db,
	viewerId = null,
	knownViewer = null,
	limit = 30,
	offset = 0,
	beforeId = null,
	cursor = null,
	ngWords = null,
	fetchCandidatePage,
}) {
	if (typeof fetchCandidatePage !== 'function') {
		throw new Error('fetchCandidatePage is required');
	}

	const normalizedLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
	const decodedCursor = typeof cursor === 'string' && cursor.trim() ? decodePostCursor(cursor.trim()) : null;
	const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
		? Number(beforeId)
		: null;
	const normalizedOffset = (normalizedBeforeId == null && !decodedCursor) ? Math.max(Number(offset) || 0, 0) : 0;
	// 通常は表示件数の2倍+番兵だけ取得し、非公開・ブロック等で
	// 足りない場合だけ次のチャンクを追加取得する。
	const candidateLimit = Math.min(100, normalizedLimit * 2 + 1);
	let candidateOffset = 0;
	let candidateBeforeId = decodedCursor ? null : normalizedBeforeId;
	let candidateCursor = decodedCursor;
	let visibleOffset = 0;
	const collectedPosts = [];
	let hasMore = false;
	let requiresOffsetPagination = false;
	let visibilityContext = null;
	let chunkAttempts = 0;

	while (chunkAttempts < MAX_CHUNK_ATTEMPTS) {
		chunkAttempts += 1;
		const candidatePage = await fetchCandidatePage({
			limit: candidateLimit,
			offset: candidateOffset,
			beforeId: candidateBeforeId,
			cursor: candidateCursor ? encodePostCursor(candidateCursor) : null,
			cursorCreatedAt: candidateCursor?.createdAt || null,
			cursorId: candidateCursor?.id || null,
		});
		const candidateIds = normalizePostIds(candidatePage?.ids);
		requiresOffsetPagination ||= candidatePage?.use_offset_pagination === true;
		const reportedNextOffset = Number(candidatePage?.next_offset);
		const nextCandidateOffset =
			Number.isInteger(reportedNextOffset) && reportedNextOffset > candidateOffset
				? reportedNextOffset
				: candidateOffset + (candidateIds.length > 0 ? candidateIds.length : candidateLimit);

		if (candidateIds.length === 0) {
			if (!candidatePage?.has_more) break;
			if (candidateCursor) {
				const nextCursor = typeof candidatePage?.next_cursor === 'string'
					? decodePostCursor(candidatePage.next_cursor)
					: null;
				if (!nextCursor) break;
				candidateCursor = nextCursor;
				continue;
			}
			if (candidateBeforeId != null) {
				const nextCursor = Number(candidatePage?.next_cursor);
				if (Number.isInteger(nextCursor) && nextCursor > 0 && nextCursor < candidateBeforeId) {
					candidateBeforeId = nextCursor;
					continue;
				}
				break;
			}
			if (nextCandidateOffset <= candidateOffset) break;
			candidateOffset = nextCandidateOffset;
			continue;
		}

		let orderedPosts;
		if (Array.isArray(candidatePage?.posts) && candidatePage.posts.length > 0) {
			const candidatePostsMap = new Map(candidatePage.posts.map((p) => [Number(p.id), p]));
			orderedPosts = candidateIds.map((id) => candidatePostsMap.get(id)).filter(Boolean);
		} else {
			const postsById = new Map(
				(await db.getPostsByIds(candidateIds)).filter(Boolean).map((post) => [
					Number(post.id),
					post,
				]),
			);
			orderedPosts = candidateIds
				.map((id) => postsById.get(id))
				.filter(Boolean);
		}

		const candidateVisibilityContext = await createPostVisibilityContext(
			db,
			orderedPosts,
			viewerId,
			null,
			knownViewer,
		);
		if (!visibilityContext) {
			visibilityContext = candidateVisibilityContext;
		} else {
			for (const [authorId, author] of candidateVisibilityContext.authorsById) {
				visibilityContext.authorsById.set(Number(authorId), author);
			}
			for (const authorId of candidateVisibilityContext.relationshipAuthorIds || []) {
				visibilityContext.relationshipAuthorIds.add(authorId);
			}
			for (const authorId of candidateVisibilityContext.followingIds) {
				visibilityContext.followingIds.add(authorId);
			}
			for (const authorId of candidateVisibilityContext.followerIds) {
				visibilityContext.followerIds.add(authorId);
			}
		}

		const viewablePosts = await filterViewablePosts(
			db,
			orderedPosts,
			viewerId,
			candidateVisibilityContext,
		);
		const discoverablePosts = await filterDiscoverablePosts(
			db,
			viewablePosts,
			viewerId,
			candidateVisibilityContext,
			{ ngWords },
		);

		for (const post of discoverablePosts) {
			if (visibleOffset < normalizedOffset) {
				visibleOffset += 1;
				continue;
			}
			collectedPosts.push(post);
			if (collectedPosts.length > normalizedLimit) break;
		}

		if (collectedPosts.length > normalizedLimit) {
			hasMore = true;
			break;
		}

		// チャンク内に表示できるポストがなくなった場合、has_moreがあれば次チャンクから取得を継続
		if (!candidatePage?.has_more) break;

		if (candidateCursor) {
			const nextCursor = typeof candidatePage?.next_cursor === 'string'
				? decodePostCursor(candidatePage.next_cursor)
				: null;
			if (!nextCursor) break;
			candidateCursor = nextCursor;
		} else if (candidateBeforeId != null) {
			const nextCursor = Number(candidatePage?.next_cursor) || candidateIds[candidateIds.length - 1];
			if (!nextCursor || nextCursor >= candidateBeforeId) break;
			candidateBeforeId = nextCursor;
		} else {
			if (nextCandidateOffset <= candidateOffset) break;
			candidateOffset = nextCandidateOffset;
		}
	}

	const posts = collectedPosts.slice(0, normalizedLimit);
	const ids = posts.map((post) => Number(post.id));
	const lastPost = posts.length > 0 ? posts[posts.length - 1] : null;
	const nextCursor = !requiresOffsetPagination && (hasMore || collectedPosts.length > normalizedLimit) && lastPost
		? (encodePostCursor(lastPost) || ids[ids.length - 1])
		: null;
	return {
		ids,
		posts,
		visibilityContext,
		has_more: hasMore || (collectedPosts.length > normalizedLimit),
		use_offset_pagination: requiresOffsetPagination,
		next_cursor: nextCursor,
	};
}

module.exports = {
	getDiscoverablePostPage,
};
