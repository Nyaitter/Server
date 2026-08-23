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
				penalty = 60;
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
					const s = keywordProfile.get(String(tag).toLowerCase());
					if (s) keywordScore += s;
				}
				socialScore += Math.min(30, keywordScore * 2);
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
