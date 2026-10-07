/**
 * Shared in-memory post recommendation scoring utility.
 * Keeps databases focused purely on data delivery while Node.js performs scoring.
 */

function scoreRecommendedPosts(candidatePosts, { viewerId = null, keywordProfile = new Map(), directFollows = new Set(), reactedPostIds = new Set(), limit = 30 } = {}) {
	const normalizedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
	const parsedViewerId = Number(viewerId);
	const validViewerId = Number.isSafeInteger(parsedViewerId) && parsedViewerId > 0 ? parsedViewerId : null;
	const now = Date.now();
	const scored = [];

	for (const post of candidatePosts || []) {
		if (!post) continue;
		const authorId = Number(post.userId ?? post.user_id);
		if (validViewerId != null && authorId === validViewerId) continue;

		const rawCreatedAtMs = new Date(post.createdAt || post.created_at || now).getTime();
		const createdAtMs = Number.isFinite(rawCreatedAtMs) ? rawCreatedAtMs : now;
		const ageHours = Math.max(0, (now - createdAtMs) / (1000 * 3600));
		const timeScore = 72 / (1 + (ageHours / 4.5));

		const lCount = Math.max(0, Number(post.likeCount ?? post.like_count) || 0);
		const sCount = Math.max(0, Number(post.starCount ?? post.star_count) || 0);
		const rCount = Math.max(0, Number(post.repostCount ?? post.repost_count) || 0);
		// Saturating engagement score. The previous coefficients could only approach
		// 16 points even though the intended cap was 22, making reactions too weak.
		const reactionScore = Math.min(22,
			(lCount * 6 / (lCount + 4))
			+ (sCount * 6 / (sCount + 2))
			+ (rCount * 10 / (rCount + 2)));

		let socialScore = 0;
		let penalty = 0;
		if (validViewerId != null) {
			const postId = Number(post.id);
			if (reactedPostIds?.has(postId)) penalty = 35;
			if (directFollows?.has(authorId)) socialScore += 24;

			let tags = post.tags;
			if (typeof tags === 'string') {
				try {
					tags = JSON.parse(tags);
				} catch (_) {
					tags = [];
				}
			}
			if (Array.isArray(tags) && keywordProfile?.size) {
				let keywordScore = 0;
				const seenTags = new Set();
				for (const tag of tags) {
					const normalizedTag = String(tag || '').trim().toLowerCase();
					if (!normalizedTag || seenTags.has(normalizedTag)) continue;
					seenTags.add(normalizedTag);
					const affinity = Math.max(0, Number(keywordProfile.get(normalizedTag)) || 0);
					if (affinity <= 0) continue;
					// words vs tags (複合語・句) で 1:2 の影響力を適応
					const isCompoundTag = normalizedTag.includes('の') || (normalizedTag.length >= 4 && /^[\p{Script=Han}\p{Script=Katakana}a-zA-Z0-9_-]+$/u.test(normalizedTag));
					keywordScore += affinity * (isCompoundTag ? 2 : 1);
				}
				socialScore += Math.min(30, keywordScore);
			}
		}

		const totalScore = Math.max(0, timeScore + reactionScore + socialScore - penalty);
		scored.push({
			id: Number(post.id),
			authorId: Number.isSafeInteger(authorId) ? authorId : null,
			score: totalScore,
			createdAt: createdAtMs,
			post,
		});
	}

	scored.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt || b.id - a.id);
	if (scored.length <= normalizedLimit) return scored;

	// Avoid a single prolific account filling the whole recommendation page.
	// First take at most two posts per author, then backfill by score so sparse
	// communities still receive a full page.
	const selected = [];
	const deferred = [];
	const authorCounts = new Map();
	for (const item of scored) {
		const authorId = item.authorId;
		const authorCount = authorId == null ? 0 : (authorCounts.get(authorId) || 0);
		if (authorId != null && authorCount >= 2) {
			deferred.push(item);
			continue;
		}
		selected.push(item);
		if (authorId != null) authorCounts.set(authorId, authorCount + 1);
		if (selected.length >= normalizedLimit) return selected;
	}
	for (const item of deferred) {
		selected.push(item);
		if (selected.length >= normalizedLimit) break;
	}
	return selected;
}

module.exports = {
	scoreRecommendedPosts,
};
