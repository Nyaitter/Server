'use strict';

const { buildAffinityProfile, scoreRecommendedPosts } = require('../utils/recommendation');
const { normalizeBlockList } = require('../utils/blockList');

const DEFAULT_LIMIT = 3;
const MAX_CANDIDATE_POSTS = 8;
const RECOMMENDED_POSTS_PER_USER = 3;
const MUTUAL_FOLLOW_BONUS = 12;

function emptyProfile() {
	return {
		affinities: [],
		follows: [],
		extendedFollows: [],
		reacted: [],
		dislikedPostIds: [],
		dislikedAuthors: [],
		blockedAuthors: [],
	};
}

function normalizeIds(values) {
	return new Set((Array.isArray(values) ? values : [])
		.map(Number)
		.filter((id) => Number.isSafeInteger(id) && id > 0));
}

async function getFallbackUsers(db, limit) {
	if (typeof db.getRecommendedUsers === 'function') {
		const users = await db.getRecommendedUsers(limit, null);
		return (Array.isArray(users) ? users : [])
			.filter((user) => user && !user.shadow && user.auth_provider !== 'imposter')
			.slice(0, limit);
	}
	const users = typeof db.getAllUsers === 'function' ? await db.getAllUsers() : [];
	return (Array.isArray(users) ? users : [])
		.filter((user) => user && !user.shadow && user.auth_provider !== 'imposter')
		.slice()
		.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
		.slice(0, limit);
}

async function getRecommendedUsers(db, viewerId, limit = DEFAULT_LIMIT) {
	const normalizedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 10));
	const parsedViewerId = Number(viewerId);
	if (!Number.isSafeInteger(parsedViewerId) || parsedViewerId <= 0) {
		return getFallbackUsers(db, normalizedLimit);
	}

	const profile = await db.getUserRecommendationProfile(parsedViewerId).catch(() => emptyProfile());
	const following = normalizeIds(profile.follows);
	const dislikedAuthors = normalizeIds(profile.dislikedAuthors);
	const viewerBlocks = normalizeIds(profile.blockedAuthors);
	const recentPosts = await db.getRecentPosts(100);

	const postsByAuthor = new Map();
	for (const post of recentPosts || []) {
		const authorId = Number(post?.userId ?? post?.user_id);
		if (!Number.isSafeInteger(authorId) || authorId <= 0) continue;
		if (authorId === parsedViewerId || following.has(authorId) || dislikedAuthors.has(authorId) || viewerBlocks.has(authorId)) continue;
		if (!postsByAuthor.has(authorId)) postsByAuthor.set(authorId, []);
		postsByAuthor.get(authorId).push(post);
	}
	if (postsByAuthor.size === 0) return [];

	const users = await db.getUsersByIds([...postsByAuthor.keys()]);
	const usersById = new Map((users || []).map((user) => [Number(user.id), user]));
	const candidates = [];
	for (const [authorId, posts] of postsByAuthor.entries()) {
		const user = usersById.get(authorId);
		if (!user || user.shadow || user.auth_provider === 'imposter') continue;
		if (normalizeBlockList(user.block, user.id).includes(parsedViewerId)) continue;
		candidates.push({ user, posts: posts.slice(0, MAX_CANDIDATE_POSTS) });
	}
	if (candidates.length === 0) return [];

	const snapshot = await db.getFollowRelationshipSnapshot(
		parsedViewerId,
		candidates.map((candidate) => Number(candidate.user.id)),
	).catch(() => ({ followingIds: [], followerIds: [] }));
	const snapshotFollowing = normalizeIds(snapshot?.followingIds);
	for (const id of snapshotFollowing) following.add(id);
	const mutualFollowers = normalizeIds(snapshot?.followerIds);
	const visibleCandidates = candidates.filter((candidate) => !following.has(Number(candidate.user.id)));
	if (visibleCandidates.length === 0) return [];
	const keywordProfile = buildAffinityProfile(profile.affinities, { limit: 25 });
	const scoringOptions = {
		viewerId: parsedViewerId,
		keywordProfile,
		directFollows: following,
		extendedFollows: normalizeIds(profile.extendedFollows),
		reactedPostIds: normalizeIds(profile.reacted),
		dislikedPostIds: normalizeIds(profile.dislikedPostIds),
		dislikedAuthors,
		blockedAuthors: viewerBlocks,
		limit: RECOMMENDED_POSTS_PER_USER,
	};

	const ranked = visibleCandidates.map((candidate) => {
		const scoredPosts = scoreRecommendedPosts(candidate.posts, scoringOptions);
		const postScore = scoredPosts.reduce((total, item) => total + item.score, 0);
		const mutualBonus = mutualFollowers.has(Number(candidate.user.id)) ? MUTUAL_FOLLOW_BONUS : 0;
		const latestPostAt = Math.max(0, ...candidate.posts.map((post) => new Date(post.createdAt || post.created_at || 0).getTime() || 0));
		return { user: candidate.user, score: postScore + mutualBonus, latestPostAt };
	});

	ranked.sort((a, b) => b.score - a.score
		|| b.latestPostAt - a.latestPostAt
		|| Number(b.user.id) - Number(a.user.id));

	return ranked.slice(0, normalizedLimit).map((item) => item.user);
}

module.exports = {
	getRecommendedUsers,
};
