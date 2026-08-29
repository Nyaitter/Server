/**
 * Shared in-memory post recommendation scoring utility.
 * Keeps databases focused purely on data delivery while Node.js performs scoring.
 */

function scoreRecommendedPosts(candidatePosts, { viewerId = null, keywordProfile = new Map(), directFollows = new Set(), reactedPostIds = new Set(), limit = 30 } = {}) {
	const normalizedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
	const validViewerId = Number.isSafeInteger(Number(viewerId)) && Number(viewerId) > 0 ? Number(viewerId) : null;
	const now = Date.now();

	const eligiblePosts = validViewerId != null
		? (candidatePosts || []).filter((post) => Number(post?.userId ?? post?.user_id) !== validViewerId)
		: (candidatePosts || []);

	const scored = eligiblePosts.map((post) => {
		const createdAtMs = new Date(post.createdAt || post.created_at || now).getTime();
		const ageHours = Math.max(0, (now - createdAtMs) / (1000 * 3600));
		const timeScore = 72 / (1 + (ageHours / 4.5));

		const lCount = Number(post.likeCount ?? post.like_count) || 0;
		const sCount = Number(post.starCount ?? post.star_count) || 0;
		const rCount = Number(post.repostCount ?? post.repost_count) || 0;
		const reactionScore = Math.min(22, (lCount * 2 / (lCount + 4)) + (sCount * 4 / (sCount + 2)) + (rCount * 10 / (rCount + 2)));

		let socialScore = 0;
		let penalty = 0;
		if (validViewerId != null) {
			const postId = Number(post.id);
			if (reactedPostIds && reactedPostIds.has(postId)) {
				penalty = 35;
			}
			const authorId = Number(post.userId ?? post.user_id);
			if (directFollows.has(authorId)) {
				socialScore += 24;
			}
			let tags = post.tags;
			if (typeof tags === 'string') {
				try {
					tags = JSON.parse(tags);
				} catch (_) {
					tags = [];
				}
			}
			if (Array.isArray(tags)) {
				let keywordScore = 0;
				for (const tag of tags) {
					const normalizedTag = String(tag).toLowerCase();
					const s = keywordProfile.get(normalizedTag);
					if (s) {
						// words vs tags (複合語・句) で 1:2 の影響力を適応
						// 「の」を含む句、または長さが4文字以上の複合語は tags (2x)、それ以外は words (1x)
						const isCompoundTag = normalizedTag.includes('の') || (normalizedTag.length >= 4 && /^[\p{Script=Han}\p{Script=Katakana}a-zA-Z0-9_-]+$/u.test(normalizedTag));
						const weight = isCompoundTag ? 2 : 1;
						keywordScore += s * weight;
					}
				}
				socialScore += Math.min(30, keywordScore);
			}
		}

		const totalScore = Math.max(0, timeScore + reactionScore + socialScore - penalty);
		return {
			id: Number(post.id),
			score: totalScore,
			createdAt: createdAtMs,
			post,
		};
	});

	scored.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt || b.id - a.id);
	return scored.slice(0, normalizedLimit);
}

module.exports = {
	scoreRecommendedPosts,
};
