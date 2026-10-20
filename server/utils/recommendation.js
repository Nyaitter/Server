/**
 * Shared in-memory post recommendation scoring utility.
 * Keeps databases focused purely on data delivery while Node.js performs scoring.
 *
 * Scoring is intentionally additive but each component is normalized to a bounded
 * range so that no single signal (especially recency) can dominate the feed.
 * Interest affinity is now the largest term, which is what makes the "for you"
 * tab feel closer to what the viewer actually cares about.
 */

// Component ceilings (sum ≈ 147 before penalties).
const RECENCY_MAX = 45;
const RECENCY_HALF_LIFE_HOURS = 18;
const ENGAGEMENT_MAX = 20;
const ENGAGEMENT_SCALE = 8;
const FOLLOW_DIRECT = 22;
const FOLLOW_EXTENDED = 9;
const AFFINITY_MAX = 60;
const AFFINITY_SCALE = 2;
// 減衰後の興味スコアがこの値なら「その語に Fully 関心がある」とみなす基準。
// (スター ±3 / いいね ±1 / 自分の投稿 +1 なので、スター4件程度で到達する強さ)
const AFFINITY_REFERENCE = 12;

// Negative signals.
const REACTED_PENALTY = 25;

// Diversity caps for a single page.
const AUTHOR_CAP = 2;
const TOPIC_CAP = 4;

function parseTags(tags) {
	if (Array.isArray(tags)) return tags;
	if (typeof tags === 'string') {
		try {
			const parsed = JSON.parse(tags);
			return Array.isArray(parsed) ? parsed : [];
		} catch (_) {
			return [];
		}
	}
	return [];
}

/**
 * 「単語」より「複合語・句」を重視する。複合語は具体的な関心を表すため、
 * 単語一致の 2 倍の重みを与える。
 */
function tagWeight(normalizedTag) {
	if (normalizedTag.includes('の')) return 2;
	if (normalizedTag.length >= 4 && /^[\p{Script=Han}\p{Script=Katakana}a-zA-Z0-9_-]+$/u.test(normalizedTag)) {
		return 2;
	}
	return 1;
}

/**
 * 生の興味スコアを絶対基準で 0..1 に詰め、利用量に依存しない重みにする。
 * プロファイル内の最大値で割る方式だと、偶発的な1件のいいねだけでも満点になり、
 * 「興味の薄さ」が反映されずフィード全体がその語に傾く。絶対基準で頭打ちにする。
 */
function normalizeProfile(keywordProfile) {
	const normalized = new Map();
	if (!(keywordProfile instanceof Map) || keywordProfile.size === 0) return normalized;
	for (const [keyword, value] of keywordProfile.entries()) {
		const numeric = Number(value) || 0;
		if (numeric <= 0) continue;
		normalized.set(String(keyword), Math.min(1, numeric / AFFINITY_REFERENCE));
	}
	return normalized;
}

function scoreRecommendedPosts(candidatePosts, {
	viewerId = null,
	keywordProfile = new Map(),
	directFollows = new Set(),
	extendedFollows = new Set(),
	reactedPostIds = new Set(),
	dislikedPostIds = new Set(),
	dislikedAuthors = new Set(),
	blockedAuthors = new Set(),
	now = Date.now(),
	limit = 30,
} = {}) {
	const normalizedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
	const parsedViewerId = Number(viewerId);
	const validViewerId = Number.isSafeInteger(parsedViewerId) && parsedViewerId > 0 ? parsedViewerId : null;
	const affinityProfile = normalizeProfile(keywordProfile);
	const scored = [];

	for (const post of candidatePosts || []) {
		if (!post) continue;
		const postId = Number(post.id);
		const authorId = Number(post.userId ?? post.user_id);
		if (validViewerId != null && authorId === validViewerId) continue;
		if (dislikedPostIds?.has(postId)) continue;
		if (blockedAuthors?.has(authorId)) continue;
		// Postgres は候補 SQL で「興味なし」著者を除外するため、採点側も同じく除外しないと
		// D1・インメモリだけが表示されて3アダプタの挙動がずれる。
		if (dislikedAuthors?.has(authorId)) continue;

		const rawCreatedAtMs = new Date(post.createdAt || post.created_at || now).getTime();
		const createdAtMs = Number.isFinite(rawCreatedAtMs) ? rawCreatedAtMs : now;
		const ageHours = Math.max(0, (now - createdAtMs) / (1000 * 3600));
		const recencyScore = RECENCY_MAX * Math.pow(2, -ageHours / RECENCY_HALF_LIFE_HOURS);

		const lCount = Math.max(0, Number(post.likeCount ?? post.like_count) || 0);
		const sCount = Math.max(0, Number(post.starCount ?? post.star_count) || 0);
		const rCount = Math.max(0, Number(post.repostCount ?? post.repost_count) || 0);
		const replyCount = Math.max(0, Number(post.replyCount ?? post.reply_count) || 0);
		const engagementRaw = (lCount * 1) + (sCount * 1.5) + (rCount * 3) + (replyCount * 1.5);
		const engagementScore = ENGAGEMENT_MAX * (1 - Math.exp(-engagementRaw / ENGAGEMENT_SCALE));

		let followScore = 0;
		let affinityScore = 0;
		let penalty = 0;

		if (validViewerId != null) {
			if (directFollows?.has(authorId)) followScore = FOLLOW_DIRECT;
			else if (extendedFollows?.has(authorId)) followScore = FOLLOW_EXTENDED;

			if (reactedPostIds?.has(postId)) penalty += REACTED_PENALTY;

			const tags = parseTags(post.tags);
			if (tags.length > 0 && affinityProfile.size > 0) {
				let matched = 0;
				const seenTags = new Set();
				for (const tag of tags) {
					const normalizedTag = String(tag || '').trim().toLowerCase();
					if (!normalizedTag || seenTags.has(normalizedTag)) continue;
					seenTags.add(normalizedTag);
					const affinity = affinityProfile.get(normalizedTag);
					if (!affinity) continue;
					matched += affinity * tagWeight(normalizedTag);
				}
				if (matched > 0) {
					affinityScore = AFFINITY_MAX * (1 - Math.exp(-matched * AFFINITY_SCALE));
				}
			}
		}

		const totalScore = Math.max(0, recencyScore + engagementScore + followScore + affinityScore - penalty);
		scored.push({
			id: Number.isSafeInteger(postId) ? postId : null,
			authorId: Number.isSafeInteger(authorId) ? authorId : null,
			score: totalScore,
			createdAt: createdAtMs,
			topTag: firstTag(post),
			post,
		});
	}

	// Deterministic ordering: score, then recency, then id. This keeps pagination
	// stable when two posts have the same score.
	scored.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt || (b.id || 0) - (a.id || 0));
	if (scored.length <= normalizedLimit) return scored;

	// Diversity: avoid a single prolific account or a single topic filling the page.
	const selected = [];
	const deferred = [];
	const authorCounts = new Map();
	const topicCounts = new Map();
	for (const item of scored) {
		const authorId = item.authorId;
		const authorCount = authorId == null ? 0 : (authorCounts.get(authorId) || 0);
		const topicCount = item.topTag ? (topicCounts.get(item.topTag) || 0) : 0;
		if ((authorId != null && authorCount >= AUTHOR_CAP) || (item.topTag && topicCount >= TOPIC_CAP)) {
			deferred.push(item);
			continue;
		}
		selected.push(item);
		if (authorId != null) authorCounts.set(authorId, authorCount + 1);
		if (item.topTag) topicCounts.set(item.topTag, topicCount + 1);
		if (selected.length >= normalizedLimit) return selected;
	}
	for (const item of deferred) {
		selected.push(item);
		if (selected.length >= normalizedLimit) break;
	}
	return selected;
}

function firstTag(post) {
	const tags = parseTags(post?.tags);
	for (const tag of tags) {
		const normalized = String(tag || '').trim().toLowerCase();
		if (normalized) return normalized;
	}
	return null;
}

/**
 * 生の興味スコア行を時間減衰（既定 半減期14日）し、減衰後の上位だけを返す。
 * これにより「昔に貯めた興味」が最近の興味を締め出さなくなる。
 */
function buildAffinityProfile(rows, { now = Date.now(), halfLifeDays = 14, limit = 25 } = {}) {
	const map = new Map();
	for (const row of rows || []) {
		const keyword = String(row?.keyword || '').trim().toLowerCase();
		if (!keyword) continue;
		const updatedAt = new Date(row?.updated_at ?? now).getTime();
		const days = Number.isFinite(updatedAt) ? Math.max(0, (now - updatedAt) / 86400000) : 0;
		const score = (Number(row?.score) || 0) * Math.pow(0.5, days / halfLifeDays);
		if (score <= 0) continue;
		map.set(keyword, score);
	}
	return new Map(
		[...map.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, Math.max(1, Number(limit) || 25)),
	);
}

module.exports = {
	scoreRecommendedPosts,
	buildAffinityProfile,
};
