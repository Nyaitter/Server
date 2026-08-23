const DatabaseAdapter = require('./DatabaseAdapter');
const config = require('../../config');
const crypto = require('crypto');
const {
	formatNyaitterId,
} = require('../../utils/nyaitterAddress');
const { normalizeTarget } = require('../../utils/notification');
const { normalizeBlockList } = require('../../utils/blockList');
const {
	createAttachmentReplacementMap,
	rewriteAttachmentReferences,
} = require('../../utils/attachmentKeys');
const { scoreRecommendedPosts } = require('../../utils/recommendation');

class InMemoryAdapter extends DatabaseAdapter {
	constructor() {
		super();
		this.users = new Map(); // id -> user
		this.scidToId = new Map(); // scid -> id
					this.sessions = new Map(); // token -> { userId, expiresAt, ... }
			this.trustedLoginIps = new Map(); // `${userId}:${ipHash}` -> trust record
			this.loginApprovals = new Map(); // approvalId -> pending login approval
			this.botTokens = new Map(); // tokenId -> { userId, tokenHash, name, ... }
		this.posts = new Map();
		this.groups = new Map(); // groupId -> group
		this.groupRoles = new Map(); // roleId -> role
		this.groupRoleIdsByGroup = new Map(); // groupId -> Set(roleId)
		this.groupMemberships = new Map(); // `${groupId}:${userId}` -> membership
		this.groupMemberIdsByGroup = new Map(); // groupId -> Set(userId)
		this.groupIdsByUser = new Map(); // userId -> Set(groupId)
		this.groupInvites = new Map(); // inviteId -> invite
		this.groupJoinRequests = new Map(); // requestId -> request
		// 投稿読み取りを投稿総数に比例させないための補助インデックス。
		this.postIdsNewest = []; // newest -> oldest
		this.postIdsByUser = new Map(); // userId -> newest -> oldest post IDs
			this.replyIdsByParent = new Map(); // parent post ID -> newest -> oldest reply IDs
			this.replyCountByParent = new Map(); // post ID -> direct/indirect descendant reply count
		this.likeCountByPost = new Map();
		this.starCountByPost = new Map();
		this.repostCountByPost = new Map();
					this.likes = new Map(); // `${userId}:${postId}` -> true
			this.stars = new Map();
			this.likedPostIdsByUser = new Map(); // userId -> Set(postId)
						this.starredPostIdsByUser = new Map(); // userId -> Set(postId)
			this.userKeywordAffinityByUser = new Map(); // userId -> Map(keyword -> score)



		this.dmChannels = new Map(); // channelId -> { id, participants, messages, ... }
		this.groupDms = new Map(); // dmId -> { id, title, member, host_id, time, post, unread }
		this.groupDmIdsByMember = new Map(); // userId -> Set(dmId)
		this.groupDmUnreadTotalByMember = new Map(); // userId -> unread total
					this.dmE2EKeys = new Map(); // userId -> { public_key, created_at, updated_at }

		this.follows = new Map(); // `${followerId}:${followingId}` -> true
		this.followingIdsByUser = new Map(); // followerId -> Set(followingId)
		this.followerIdsByUser = new Map(); // followingId -> Set(followerId)
			this.notifications = new Map(); // userId -> [notification]
			this.notificationsById = new Map(); // notificationId -> notification
			this.unreadNotificationCounts = new Map(); // userId -> unread count
			this.moderationReports = new Map(); // reportId -> report record
			this.nextModerationReportId = 1;
			this.pushSubscriptions = new Map(); // userId -> Map(endpoint -> subscription)
		this.reposts = new Map(); // `${userId}:${postId}` -> true
		this.pinnedPosts = new Map(); // `${userId}:${postId}` -> true
		this.nextPostId = 1;
		this.nextNotificationId = 1;
		this.nextDmId = 1;
		this.logs = []; // { scratch_id, nyaitter_id, masked_ip_uuid, log_time }

		this.externalAuthToId = new Map(); // `${provider}:${external_id}` -> id
		this.userAuthProviders = new Map(); // id -> { id, userId, provider, providerUserId, providerProfile, createdAt }
		this.authProviderLookup = new Map(); // `${provider}:${providerUserId}` -> providerRecordId
		this.nextAuthProviderId = 1;

		this.authorizedApps = new Map(); // id -> record
		this.authorizedAppLookup = new Map(); // `${userId}:${appId}:${appTokenHash}` -> id
		this.authorizedAppByAccessTokenId = new Map(); // accessTokenId -> id
		this.nextAuthorizedAppId = 1;
	}

	async exportDataSnapshot() {
		const { createSnapshot } = require('../../services/DataMigrationService');
		const rows = {
			users: [...this.users.values()],
			sessions: [...this.sessions.values()],
			trusted_login_ips: [...this.trustedLoginIps.values()],
			login_approvals: [...this.loginApprovals.values()],
			bot_tokens: [...this.botTokens.values()],
							posts: [...this.posts.values()],
				groups: [...this.groups.values()],
				group_roles: [...this.groupRoles.values()],
				group_memberships: [...this.groupMemberships.values()],
				group_invites: [...this.groupInvites.values()],
				group_join_requests: [...this.groupJoinRequests.values()],

			likes: [...this.likes.entries()].map(([key, created_at]) => {
				const [user_id, post_id] = key.split(':').map(Number);
				return { user_id, post_id, created_at };
			}),
			stars: [...this.stars.entries()].map(([key, created_at]) => {
				const [user_id, post_id] = key.split(':').map(Number);
				return { user_id, post_id, created_at };
			}),
			reposts: [...this.reposts.entries()].map(([key, created_at]) => {
				const [user_id, post_id] = key.split(':').map(Number);
				return { user_id, post_id, created_at };
			}),
			pinned_posts: [...this.pinnedPosts.entries()].map(([key, created_at]) => {
				const [user_id, post_id] = key.split(':').map(Number);
				return { user_id, post_id, created_at };
			}),
			follows: [...this.follows.entries()].map(([key, created_at]) => {
				const [follower_id, following_id] = key.split(':').map(Number);
				return { follower_id, following_id, created_at };
			}),
			dm_channels: [...this.dmChannels.values()].map((channel) => ({
				id: channel.id,
				participants: channel.participants,
				created_at: channel.createdAt,
			})),
			dm_messages: [...this.dmChannels.values()].flatMap((channel) => (channel.messages || []).map((message) => ({
				id: message.id,
				channel_id: channel.id,
				sender_id: message.senderId,
				content: message.content,
				sent_at: message.sentAt,
				read_at: message.readAt,
			}))),
			group_dms: [...this.groupDms.values()],
							dm_e2e_keys: [...this.dmE2EKeys.entries()].map(([user_id, record]) => ({
					user_id,
					public_key: record.public_key,
					created_at: record.created_at,
					updated_at: record.updated_at,
				})),

			notifications: [...this.notificationsById.values()],
			push_subscriptions: [...this.pushSubscriptions.entries()].flatMap(([user_id, subscriptions]) => (
				[...subscriptions.values()].map((subscription) => ({ user_id, ...subscription }))
			)),
				moderation_reports: [...this.moderationReports.values()],
				logs: this.logs,
				user_keyword_affinities: [...this.userKeywordAffinityByUser.entries()].flatMap(([user_id, affinities]) => (
					[...affinities.entries()].map(([keyword, score]) => ({
						user_id,
						keyword,
						score,
						updated_at: new Date().toISOString(),
					}))
				)),
		};
		return createSnapshot('memory', rows);
	}

	async importDataSnapshot(snapshot, { replace = false } = {}) {
		if (replace !== true) throw new Error('Destination replacement requires replace=true');
		const { normalizeSnapshot } = require('../../services/DataMigrationService');
		const data = normalizeSnapshot(snapshot);
		const empty = new InMemoryAdapter();
		Object.assign(this, empty);

		for (const row of data.tables.users) {
			const user = {
				...row,
				me: row.bio,
				createdAt: row.created_at ? new Date(row.created_at) : new Date(),
			};
			this.users.set(user.id, user);
			if (user.scid) this.scidToId.set(user.scid, user.id);
			if (user.auth_provider && user.external_id != null) {
				this.externalAuthToId.set(`${String(user.auth_provider).toLowerCase()}:${String(user.external_id)}`, user.id);
			}
		}
		for (const row of data.tables.sessions) {
			if (!row.token) continue;
			this.sessions.set(row.token, {
				id: row.session_id,
				session_id: row.session_id,
				token: row.token,
				userId: row.user_id,
				user_id: row.user_id,
				ipHash: row.ip_hash,
				ipMasked: row.ip_masked,
				userAgent: row.user_agent,
				expiresAt: row.expires_at,
				createdAt: row.created_at,
			});
		}
		for (const row of data.tables.trusted_login_ips) {
			this.trustedLoginIps.set(`${row.user_id}:${row.ip_hash}`, {
				userId: row.user_id, ipHash: row.ip_hash, ipMasked: row.ip_masked,
				createdAt: row.created_at, lastUsedAt: row.last_used_at,
			});
		}
		for (const row of data.tables.login_approvals) {
			this.loginApprovals.set(row.id, {
				id: row.id, userId: row.user_id, ipHash: row.ip_hash, ipMasked: row.ip_masked,
				userAgent: row.user_agent, pollTokenHash: row.poll_token_hash, status: row.status,
				createdAt: row.created_at, expiresAt: row.expires_at, decidedAt: row.decided_at, consumedAt: row.consumed_at,
			});
		}
		for (const row of data.tables.bot_tokens) {
			this.botTokens.set(row.token_id, {
				tokenId: row.token_id, tokenHash: row.token_hash, userId: row.user_id,
				name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at,
			});
		}
		for (const row of [...data.tables.posts].sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))) {
			const post = {
				id: row.id, userId: row.user_id, content: row.content,
				tags: Array.isArray(row.tags) ? row.tags : [],
				tagsGeneratedAt: row.tags_generated_at ?? row.tagsGeneratedAt ?? null, attachments: row.attachments,
									mask: row.mask, lock: row.lock, announcement: row.announcement,
					groupId: row.group_id ?? row.groupId ?? null,
					groupAnnouncement: Boolean(row.group_announcement ?? row.groupAnnouncement),
					replyTo: row.reply_to, repostTo: row.repost_to, createdAt: row.created_at,

			};
			this.posts.set(post.id, post);
			this._addPostIndexes(post);
			this.nextPostId = Math.max(this.nextPostId, Number(post.id) + 1);
		}
			for (const row of data.tables.groups || []) {
				this.groups.set(String(row.id), {
					id: String(row.id), ownerId: Number(row.owner_id), name: row.name || '', description: row.description || '',
					iconData: row.icon_data ?? null, headerImage: row.header_image ?? null, visibility: row.visibility || 'open',
					deletedAt: row.deleted_at ?? null, createdAt: row.created_at ?? new Date().toISOString(), updatedAt: row.updated_at ?? new Date().toISOString(),
				});
			}
			for (const row of data.tables.group_roles || []) {
				const role = { id: String(row.id), groupId: String(row.group_id), name: row.name || '',
					permissions: Array.isArray(row.permissions) ? row.permissions.map(String) : [], isSystem: Boolean(row.is_system),
					sortOrder: Number(row.sort_order) || 0, createdAt: row.created_at ?? new Date().toISOString(), updatedAt: row.updated_at ?? new Date().toISOString() };
				this.groupRoles.set(role.id, role);
				if (!this.groupRoleIdsByGroup.has(role.groupId)) this.groupRoleIdsByGroup.set(role.groupId, new Set());
				this.groupRoleIdsByGroup.get(role.groupId).add(role.id);
			}
			for (const row of data.tables.group_memberships || []) {
				const membership = { groupId: String(row.group_id), userId: Number(row.user_id), roleId: row.role_id ?? null,
					status: row.status || 'active', joinedAt: row.joined_at ?? null, updatedAt: row.updated_at ?? new Date().toISOString() };
				const key = `${membership.groupId}:${membership.userId}`;
				this.groupMemberships.set(key, membership);
				if (!this.groupMemberIdsByGroup.has(membership.groupId)) this.groupMemberIdsByGroup.set(membership.groupId, new Set());
				if (!this.groupIdsByUser.has(membership.userId)) this.groupIdsByUser.set(membership.userId, new Set());
				this.groupMemberIdsByGroup.get(membership.groupId).add(membership.userId);
				this.groupIdsByUser.get(membership.userId).add(membership.groupId);
			}
			for (const row of data.tables.group_invites || []) this.groupInvites.set(String(row.id), {
				id: String(row.id), groupId: String(row.group_id), inviterId: Number(row.inviter_id), inviteeId: Number(row.invitee_id),
				status: row.status || 'pending', createdAt: row.created_at ?? new Date().toISOString(), respondedAt: row.responded_at ?? null,
			});
			for (const row of data.tables.group_join_requests || []) this.groupJoinRequests.set(String(row.id), {
				id: String(row.id), groupId: String(row.group_id), userId: Number(row.user_id), status: row.status || 'pending',
				reviewedBy: row.reviewed_by ?? null, createdAt: row.created_at ?? new Date().toISOString(), reviewedAt: row.reviewed_at ?? null,
			});
			for (const row of data.tables.follows) {
			const key = `${row.follower_id}:${row.following_id}`;
			this.follows.set(key, row.created_at);
			if (!this.followingIdsByUser.has(row.follower_id)) this.followingIdsByUser.set(row.follower_id, new Set());
			if (!this.followerIdsByUser.has(row.following_id)) this.followerIdsByUser.set(row.following_id, new Set());
			this.followingIdsByUser.get(row.follower_id).add(row.following_id);
			this.followerIdsByUser.get(row.following_id).add(row.follower_id);
		}
		for (const [table, target, countMap, userIndex] of [
			['likes', this.likes, this.likeCountByPost, this.likedPostIdsByUser],
			['stars', this.stars, this.starCountByPost, this.starredPostIdsByUser],
		]) {
			for (const row of data.tables[table]) {
				const key = `${row.user_id}:${row.post_id}`;
				target.set(key, row.created_at);
				countMap.set(row.post_id, (countMap.get(row.post_id) || 0) + 1);
				this._updateUserReactionIndex(userIndex, row.user_id, row.post_id, true);
			}
		}
			for (const row of data.tables.user_keyword_affinities || []) {
				const userId = Number(row.user_id);
				const keyword = String(row.keyword || '').trim().toLowerCase();
				const score = Math.max(0, Number(row.score) || 0);
				if (!keyword || score <= 0) continue;
				if (!this.userKeywordAffinityByUser.has(userId)) this.userKeywordAffinityByUser.set(userId, new Map());
				this.userKeywordAffinityByUser.get(userId).set(keyword, score);
			}
			for (const [table, target, countMap] of [
				['reposts', this.reposts, this.repostCountByPost],
			['pinned_posts', this.pinnedPosts, null],
		]) {
			for (const row of data.tables[table]) {
				target.set(`${row.user_id}:${row.post_id}`, row.created_at);
				if (countMap) countMap.set(row.post_id, (countMap.get(row.post_id) || 0) + 1);
			}
		}
		for (const row of data.tables.dm_channels) {
			this.dmChannels.set(row.id, {
				id: row.id, participants: row.participants, messages: [], createdAt: row.created_at,
				unreadCounts: Object.fromEntries(row.participants.map((userId) => [userId, 0])),
			});
		}
		for (const row of [...data.tables.dm_messages].sort((left, right) => String(left.sent_at).localeCompare(String(right.sent_at)))) {
			const channel = this.dmChannels.get(row.channel_id);
			if (!channel) continue;
			channel.messages.push({ id: row.id, channelId: row.channel_id, senderId: row.sender_id, content: row.content, sentAt: row.sent_at, readAt: row.read_at });
			this.nextDmId = Math.max(this.nextDmId, Number(row.id) + 1);
			if (!row.read_at) {
				for (const userId of channel.participants) {
					if (userId !== row.sender_id) channel.unreadCounts[userId] = (channel.unreadCounts[userId] || 0) + 1;
				}
			}
		}
		for (const row of data.tables.group_dms) {
			const dm = { ...row, host_id: row.host_id, member: row.member, post: row.post, unread: row.unread, time: row.time };
			this.groupDms.set(dm.id, dm);
			this._addGroupDmMemberIndexes(dm);
		}
					for (const row of data.tables.dm_e2e_keys) {
				this.dmE2EKeys.set(row.user_id, {
					public_key: row.public_key,
					created_at: row.created_at,
					updated_at: row.updated_at,
				});
			}

		for (const row of data.tables.notifications) {
			const notification = {
				id: row.id, userId: row.user_id, type: row.type, fromUserId: row.from_user_id,
				postId: row.post_id, target: row.target, message: row.message, read: row.read,
				clicked: row.clicked, createdAt: row.created_at,
			};
			this.notificationsById.set(notification.id, notification);
			if (!this.notifications.has(notification.userId)) this.notifications.set(notification.userId, []);
			this.notifications.get(notification.userId).push(notification);
			if (!notification.read) this.unreadNotificationCounts.set(notification.userId, (this.unreadNotificationCounts.get(notification.userId) || 0) + 1);
			this.nextNotificationId = Math.max(this.nextNotificationId, Number(notification.id) + 1);
		}
		for (const row of data.tables.push_subscriptions) {
			if (!this.pushSubscriptions.has(row.user_id)) this.pushSubscriptions.set(row.user_id, new Map());
			this.pushSubscriptions.get(row.user_id).set(row.endpoint, { ...row });
		}
		for (const row of data.tables.moderation_reports) {
			const report = {
				id: row.id, reporterUserId: row.reporter_user_id, targetKind: row.target_kind, targetId: row.target_id,
				description: row.description, targetSnapshot: row.target_snapshot, assignmentType: row.assignment_type,
				status: row.status, assignedAdminId: row.assigned_admin_id, assignedAt: row.assigned_at,
				excludedAdminIds: row.excluded_admin_ids, resolution: row.resolution, createdAt: row.created_at, resolvedAt: row.resolved_at,
			};
			this.moderationReports.set(report.id, report);
			this.nextModerationReportId = Math.max(this.nextModerationReportId, Number(report.id) + 1);
		}
		this.logs = data.tables.logs.map((row) => ({
			id: row.id, scratch_id: row.scratch_id, nyaitter_id: row.nyaitter_id,
			masked_ip_uuid: row.masked_ip_uuid, log_time: row.log_time,
		}));
		return Object.fromEntries(Object.entries(data.tables).map(([table, rows]) => [table, rows.length]));
	}

		_updateReplyCountsForAncestors(parentPostId, delta) {
			let currentId = Number(parentPostId);
			const visited = new Set();
			while (Number.isInteger(currentId) && !visited.has(currentId)) {
				visited.add(currentId);
				const nextCount = Math.max(0, (this.replyCountByParent.get(currentId) || 0) + delta);
				if (nextCount === 0) this.replyCountByParent.delete(currentId);
				else this.replyCountByParent.set(currentId, nextCount);
				const currentPost = this.posts.get(currentId);
				currentId = currentPost?.replyTo != null ? Number(currentPost.replyTo) : NaN;
			}
		}

		_addPostIndexes(post) {
			if (!post || !Number.isInteger(Number(post.id))) return;
		const postId = Number(post.id);
		const userId = Number(post.userId);
		this.postIdsNewest.unshift(postId);
		if (!this.postIdsByUser.has(userId)) this.postIdsByUser.set(userId, []);
		this.postIdsByUser.get(userId).unshift(postId);
		if (post.replyTo != null) {
			const parentId = Number(post.replyTo);
			if (!this.replyIdsByParent.has(parentId)) this.replyIdsByParent.set(parentId, []);
				this.replyIdsByParent.get(parentId).unshift(postId);
				this._updateReplyCountsForAncestors(parentId, 1);
		}
		this.likeCountByPost.set(postId, this.likeCountByPost.get(postId) || 0);
		this.starCountByPost.set(postId, this.starCountByPost.get(postId) || 0);
		this.repostCountByPost.set(postId, this.repostCountByPost.get(postId) || 0);
	}

	_removePostIndexes(post) {
		if (!post || !Number.isInteger(Number(post.id))) return;
		const postId = Number(post.id);
		const removeId = (items) => {
			const index = items ? items.indexOf(postId) : -1;
			if (index >= 0) items.splice(index, 1);
		};
		removeId(this.postIdsNewest);
		removeId(this.postIdsByUser.get(Number(post.userId)));
		if (post.replyTo != null) {
			const parentId = Number(post.replyTo);
			const replies = this.replyIdsByParent.get(parentId);
			removeId(replies);
				this._updateReplyCountsForAncestors(parentId, -1);
				if (!replies || replies.length === 0) this.replyIdsByParent.delete(parentId);
		}
		this.likeCountByPost.delete(postId);
		this.starCountByPost.delete(postId);
		this.repostCountByPost.delete(postId);
	}

	_addGroupDmMemberIndexes(dm) {
		for (const memberId of dm.member || []) {
			const normalizedMemberId = Number(memberId);
			if (!this.groupDmIdsByMember.has(normalizedMemberId)) this.groupDmIdsByMember.set(normalizedMemberId, new Set());
			this.groupDmIdsByMember.get(normalizedMemberId).add(dm.id);
			const unread = Number(dm.unread?.[normalizedMemberId] || 0);
			if (unread > 0) {
				this.groupDmUnreadTotalByMember.set(normalizedMemberId, (this.groupDmUnreadTotalByMember.get(normalizedMemberId) || 0) + unread);
			}
		}
	}

	_removeGroupDmMemberIndexes(dm) {
		for (const memberId of dm.member || []) {
			const normalizedMemberId = Number(memberId);
			const ids = this.groupDmIdsByMember.get(normalizedMemberId);
			if (ids) {
				ids.delete(dm.id);
				if (ids.size === 0) this.groupDmIdsByMember.delete(normalizedMemberId);
			}
			const unread = Number(dm.unread?.[normalizedMemberId] || 0);
			if (unread > 0) {
				const nextTotal = Math.max(0, (this.groupDmUnreadTotalByMember.get(normalizedMemberId) || 0) - unread);
				if (nextTotal === 0) this.groupDmUnreadTotalByMember.delete(normalizedMemberId);
				else this.groupDmUnreadTotalByMember.set(normalizedMemberId, nextTotal);
			}
		}
	}

			_updateUserReactionIndex(index, userId, postId, active) {
			const normalizedUserId = Number(userId);
			const normalizedPostId = Number(postId);
			if (active) {
				if (!index.has(normalizedUserId)) index.set(normalizedUserId, new Set());
				index.get(normalizedUserId).add(normalizedPostId);
				return;
			}
			const postIds = index.get(normalizedUserId);
			if (!postIds) return;
			postIds.delete(normalizedPostId);
			if (postIds.size === 0) index.delete(normalizedUserId);
		}

			_adjustUserKeywordAffinitiesForTags(userId, tags, delta) {
				const keywords = Array.isArray(tags) ? tags : [];
				if (!Number.isFinite(Number(delta)) || keywords.length === 0) return;
				const normalizedUserId = Number(userId);
				if (!this.userKeywordAffinityByUser.has(normalizedUserId)) {
					this.userKeywordAffinityByUser.set(normalizedUserId, new Map());
				}
				const affinities = this.userKeywordAffinityByUser.get(normalizedUserId);
				for (const keyword of keywords) {
					const normalizedKeyword = String(keyword || '').trim().toLowerCase();
					if (!normalizedKeyword) continue;
					const nextScore = Math.max(0, (affinities.get(normalizedKeyword) || 0) + Number(delta));
					if (nextScore === 0) affinities.delete(normalizedKeyword);
					else affinities.set(normalizedKeyword, nextScore);
				}
				if (affinities.size === 0) this.userKeywordAffinityByUser.delete(normalizedUserId);
			}

			_adjustUserKeywordAffinities(userId, postId, delta) {
				const post = this.posts.get(Number(postId));
				this._adjustUserKeywordAffinitiesForTags(userId, post?.tags, delta);
			}

			_updateFollowIndexes(followerId, followingId, following) {

		const follower = Number(followerId);
		const followingUser = Number(followingId);
		if (following) {
			if (!this.followingIdsByUser.has(follower)) this.followingIdsByUser.set(follower, new Set());
			if (!this.followerIdsByUser.has(followingUser)) this.followerIdsByUser.set(followingUser, new Set());
			this.followingIdsByUser.get(follower).add(followingUser);
			this.followerIdsByUser.get(followingUser).add(follower);
			return;
		}
		const followingIds = this.followingIdsByUser.get(follower);
		if (followingIds) {
			followingIds.delete(followingUser);
			if (followingIds.size === 0) this.followingIdsByUser.delete(follower);
		}
		const followerIds = this.followerIdsByUser.get(followingUser);
		if (followerIds) {
			followerIds.delete(follower);
			if (followerIds.size === 0) this.followerIdsByUser.delete(followingUser);
		}
	}

	async connect() {
		console.log('[InMemoryAdapter] メモリDBを初期化しました');
	}

	async disconnect() {}

	_normalizeUserBlockList(user) {
		if (!user) return null;
		user.block = normalizeBlockList(user.block, user.id);
		return user;
	}

	async getUserByScid(scid) {
		const id = this.scidToId.get(scid);
		return id !== undefined
			? this._normalizeUserBlockList(this.users.get(id))
			: null;
	}

	async getUserById(id) {
		return this._normalizeUserBlockList(this.users.get(id));
	}

	async getUserByExternalId(authProvider, externalId) {
		if (!authProvider || externalId == null) return null;
		const key = `${String(authProvider).toLowerCase()}:${String(externalId)}`;
		const id = this.externalAuthToId.get(key);
		return id !== undefined
			? this._normalizeUserBlockList(this.users.get(id))
			: null;
	}

	async getUserAuthProviders(userId) {
		const targetId = Number(userId);
		const user = this.users.get(targetId);
		if (!user) return [];

		const records = [];
		for (const record of this.userAuthProviders.values()) {
			if (record.userId === targetId) {
				records.push({ ...record });
			}
		}

		const hasScratch = records.some((r) => String(r.provider).toLowerCase() === 'scratch');
		if (!hasScratch && user.scid) {
			records.unshift({
				id: 0,
				userId: targetId,
				provider: 'scratch',
				providerUserId: user.scid,
				providerProfile: { username: user.scid },
				isPrimary: records.length === 0,
				createdAt: user.createdAt || new Date(),
			});
		} else if (records.length === 0 && user.auth_provider && user.external_id) {
			records.push({
				id: 0,
				userId: targetId,
				provider: user.auth_provider,
				providerUserId: user.external_id,
				providerProfile: user.external_profile || {},
				isPrimary: true,
				createdAt: user.createdAt || new Date(),
			});
		}

		return records;
	}

	async findUserByAuthProvider(provider, providerUserId) {
		if (!provider || providerUserId == null) return null;
		const normProvider = String(provider).toLowerCase();
		const normUserId = String(providerUserId).trim();
		const key = `${normProvider}:${normUserId.toLowerCase()}`;

		const recordId = this.authProviderLookup.get(key);
		if (recordId !== undefined) {
			const record = this.userAuthProviders.get(recordId);
			if (record) {
				const user = this.users.get(record.userId);
				if (user) return this._normalizeUserBlockList(user);
			}
		}

		if (normProvider === 'scratch' || normProvider === 'local') {
			const userByScid = await this.getUserByScid(normUserId);
			if (userByScid) return userByScid;
		}

		const userByExt = await this.getUserByExternalId(normProvider, normUserId);
		if (userByExt) return userByExt;

		return null;
	}

	async linkAuthProvider(userId, provider, providerUserId, providerProfile = {}) {
		const targetId = Number(userId);
		const user = this.users.get(targetId);
		if (!user) throw new Error('ユーザーが見つかりません。');

		const normProvider = String(provider).toLowerCase();
		const normUserId = String(providerUserId).trim();
		const key = `${normProvider}:${normUserId.toLowerCase()}`;

		const existingUser = await this.findUserByAuthProvider(normProvider, normUserId);
		if (existingUser && existingUser.id !== targetId) {
			const err = new Error('この認証情報は既に他のアカウントに紐付けられています。');
			err.status = 409;
			err.code = 'auth_provider_already_linked';
			throw err;
		}

		// If already linked to this exact user, return existing record
		const existingRecordId = this.authProviderLookup.get(key);
		if (existingRecordId !== undefined) {
			return this.userAuthProviders.get(existingRecordId);
		}

		const id = this.nextAuthProviderId++;
		const record = {
			id,
			userId: targetId,
			provider: normProvider,
			providerUserId: normUserId,
			providerProfile: providerProfile || {},
			createdAt: new Date(),
		};

		this.userAuthProviders.set(id, record);
		this.authProviderLookup.set(key, id);
		this.externalAuthToId.set(key, targetId);

		if (normProvider === 'scratch' && !user.scid) {
			user.scid = normUserId;
			this.scidToId.set(normUserId, targetId);
		}

		return record;
	}

	async unlinkAuthProvider(userId, provider, providerUserId = null) {
		const targetId = Number(userId);
		const user = this.users.get(targetId);
		if (!user) throw new Error('ユーザーが見つかりません。');

		const normProvider = String(provider).toLowerCase();
		const linkedProviders = await this.getUserAuthProviders(targetId);

		if (linkedProviders.length <= 1) {
			const err = new Error('最後のログイン方法を解除することはできません。アカウントには最低1つのログイン方法が必要です。');
			err.status = 400;
			err.code = 'cannot_unlink_last_provider';
			throw err;
		}

		let deleted = false;
		for (const [id, record] of this.userAuthProviders.entries()) {
			if (record.userId === targetId && record.provider === normProvider) {
				if (providerUserId == null || String(record.providerUserId).toLowerCase() === String(providerUserId).toLowerCase()) {
					const key = `${record.provider}:${String(record.providerUserId).toLowerCase()}`;
					this.userAuthProviders.delete(id);
					this.authProviderLookup.delete(key);
					this.externalAuthToId.delete(key);
					deleted = true;
				}
			}
		}

		if (normProvider === 'scratch' && user.scid) {
			this.scidToId.delete(user.scid);
			user.scid = null;
			deleted = true;
		}

		return { success: true, deleted };
	}

	_withUserDefaults(user) {
		const normalized = {
			me: '',
			icon_data: null,
			header_image: null,
			block: [],
			notice: [],
			notification_unread_count: 0,
			admin: false,
			verify: false,
			freeze: null,
			shadow: false,
			lock: false,
			account_operation: null,
			...(user || {}),
		};
		normalized.block = normalizeBlockList(normalized.block, normalized.id);

		return normalized;
	}

	async createUser(userData) {
		const id = this._allocateUserId();
		const handle = formatNyaitterId(id);

		const adminScids = (process.env.ADMIN_SCIDS || '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);

		const user = this._withUserDefaults({
			id,
			name: userData.name || userData.scid || userData.handle || handle,
			me: userData.me || userData.bio || '',
			bio: userData.bio || userData.me || '',
			icon_data: userData.icon_data || null,
			header_image: userData.header_image || null,
			scid: userData.scid || null,
			handle: userData.handle || handle,
			auth_provider: userData.auth_provider || 'local',
			provider_domain: userData.provider_domain || null,
			external_id: userData.external_id != null ? String(userData.external_id) : null,
			external_profile: userData.external_profile || null,
			uuid: userData.uuid || null,
			settings: userData.settings || {},
			admin: userData.admin || (userData.scid && adminScids.includes(userData.scid)),
			created_at: new Date(),
		});

		this.users.set(id, user);
		if (user.scid) this.scidToId.set(user.scid, id);
		if (user.auth_provider && user.external_id != null) {
			const key = `${String(user.auth_provider).toLowerCase()}:${String(user.external_id)}`;
			this.externalAuthToId.set(key, id);
		}

		return user;
	}

	
	_allocateUserId() {
		let digits = 4;
		while (this.users.size >= 10 ** digits) digits += 1;
		const upperBound = 10 ** digits;
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const id = crypto.randomInt(0, upperBound);
			if (!this.users.has(id)) return id;
		}
		for (let id = 0; id < upperBound; id += 1) {
			if (!this.users.has(id)) return id;
		}
		digits += 1;
		return crypto.randomInt(0, 10 ** digits);
	}

	
	async searchUsers(query, limit = 20, offset = 0) {
		if (!query || query.trim().length === 0) {
			return [];
		}

		const q = query.toLowerCase();
		const safeLimit = Math.max(Number(limit) || 0, 0);
		const safeOffset = Math.max(Number(offset) || 0, 0);
		const results = [];

		for (const user of this.users.values()) {
			const nyaitterId = formatNyaitterId(
				user.auth_provider === 'nyaitter' && user.external_id != null
					? user.external_id
					: user.id,
			).toLowerCase();
			const scid = String(user.scid || '').toLowerCase();
			const name = String(user.name || '').toLowerCase();
			const profile = String(user.me || '').toLowerCase();
			if (
				nyaitterId.includes(q.replace(/^#/, '#')) ||
				scid.includes(q) ||
				name.includes(q) ||
				profile.includes(q)
			) {
				results.push(this._normalizeUserBlockList(user));
			}
		}

		return results
			.sort((left, right) => Number(left.id) - Number(right.id))
			.slice(safeOffset, safeOffset + safeLimit);
	}

	
	async getUsersByIds(userIds) {
		const results = [];
		for (const id of userIds) {
			const user = this._normalizeUserBlockList(this.users.get(id));
			if (user) {
				results.push(user);
			}
		}
		return results;
	}

	
	async getAllUsers() {
		return Array.from(this.users.values()).map((user) =>
			this._normalizeUserBlockList(user),
		);
	}

	async createSession(userId, meta = {}) {
		const token = typeof meta.token === 'string' && meta.token
			? meta.token
			: crypto.randomBytes(config.auth.sessionTokenBytes).toString('hex');
		const msPerDay = 1000 * 60 * 60 * 24;
		const expiresAt = new Date(Date.now() + msPerDay * config.auth.sessionExpiryDays);
		const session = {
			id: crypto.randomBytes(16).toString('base64url'),
			token,
			userId: Number(userId),
			expiresAt,
			createdAt: new Date(),
			ipHash: meta.ipHash || null,
			ipMasked: meta.ipMasked || '不明なIPアドレス',
			userAgent: meta.userAgent || '不明な端末',
		};
		this.sessions.set(token, session);
		return { ...session };
	}

	async getSessionByToken(token) {
		const session = this.sessions.get(token);
		if (!session) return null;
		if (session.expiresAt < new Date()) {
			this.sessions.delete(token);
			return null;
		}
		return { ...session };
	}

	async invalidateSession(token) {
		return this.sessions.delete(token);
	}

	async getUserSessions(userId) {
		const now = new Date();
		const result = [];
		for (const [token, session] of this.sessions.entries()) {
			if (session.expiresAt <= now) {
				this.sessions.delete(token);
				continue;
			}
			if (Number(session.userId) === Number(userId)) result.push({ ...session, token });
		}
		return result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
	}

	async invalidateAllSessions(userId) {
		let count = 0;
		for (const [token, session] of this.sessions.entries()) {
			if (Number(session.userId) === Number(userId)) {
				this.sessions.delete(token);
				count++;
			}
		}
		return count;
	}

	_trustedLoginIpKey(userId, ipHash) {
		return `${Number(userId)}:${String(ipHash)}`;
	}

	async trustLoginIp(userId, { ipHash, ipMasked }) {
		if (!ipHash) throw new Error('ipHash is required');
		const key = this._trustedLoginIpKey(userId, ipHash);
		const existing = this.trustedLoginIps.get(key);
		const now = new Date();
		const trusted = {
			userId: Number(userId),
			ipHash: String(ipHash),
			ipMasked: ipMasked || existing?.ipMasked || '不明なIPアドレス',
			createdAt: existing?.createdAt || now,
			lastUsedAt: now,
		};
		this.trustedLoginIps.set(key, trusted);
		return { ...trusted };
	}

	async getTrustedLoginIp(userId, ipHash) {
		const trusted = this.trustedLoginIps.get(this._trustedLoginIpKey(userId, ipHash));
		return trusted ? { ...trusted } : null;
	}

	async countTrustedLoginIps(userId) {
		let count = 0;
		for (const trusted of this.trustedLoginIps.values()) {
			if (Number(trusted.userId) === Number(userId)) count++;
		}
		return count;
	}

	async revokeTrustedLoginIp(userId, ipHash) {
		return this.trustedLoginIps.delete(this._trustedLoginIpKey(userId, ipHash));
	}

	async invalidateSessionsByIp(userId, ipHash) {
		let count = 0;
		for (const [token, session] of this.sessions.entries()) {
			if (Number(session.userId) === Number(userId) && session.ipHash === ipHash) {
				this.sessions.delete(token);
				count++;
			}
		}
		return count;
	}

	async createLoginApproval(approvalData) {
		const id = crypto.randomBytes(18).toString('base64url');
		const approval = {
			id,
			userId: Number(approvalData.userId),
			ipHash: String(approvalData.ipHash),
			ipMasked: approvalData.ipMasked || '不明なIPアドレス',
			userAgent: approvalData.userAgent || '不明な端末',
			pollTokenHash: String(approvalData.pollTokenHash),
			status: 'pending',
			createdAt: new Date(),
			expiresAt: new Date(approvalData.expiresAt),
			decidedAt: null,
			consumedAt: null,
		};
		this.loginApprovals.set(id, approval);
		return { ...approval };
	}

	async getLoginApproval(id) {
		const approval = this.loginApprovals.get(String(id));
		if (!approval) return null;
		if (approval.status === 'pending' && approval.expiresAt <= new Date()) approval.status = 'expired';
		return { ...approval };
	}

	async getLoginApprovalByPollToken(id, pollTokenHash) {
		const approval = await this.getLoginApproval(id);
		if (!approval || approval.pollTokenHash !== String(pollTokenHash)) return null;
		return approval;
	}

	async decideLoginApproval(userId, id, decision) {
		const approval = await this.getLoginApproval(id);
		if (!approval || Number(approval.userId) !== Number(userId)) return null;
		if (approval.status !== 'pending') return { ...approval };
		const stored = this.loginApprovals.get(String(id));
		stored.status = (decision === 'approve' || decision === 'approved') ? 'approved' : 'denied';
		stored.decidedAt = new Date();
		return { ...stored };
	}

	async consumeLoginApproval(id, pollTokenHash) {
		const approval = await this.getLoginApprovalByPollToken(id, pollTokenHash);
		if (!approval || approval.status !== 'approved') return null;
		const stored = this.loginApprovals.get(approval.id);
		stored.status = 'consumed';
		stored.consumedAt = new Date();
		return { ...stored };
	}

	async createBotToken(userId, tokenId, tokenHash, name) {
		const record = {
			tokenId,
			userId,
			tokenHash,
			name,
			createdAt: new Date(),
			lastUsedAt: null,
		};
		this.botTokens.set(tokenId, record);
		return record;
	}

	async getBotTokenById(tokenId) {
		return this.botTokens.get(tokenId) || null;
	}

	async getUserBotTokens(userId) {
		const result = [];
		for (const record of this.botTokens.values()) {
			if (record.userId === userId) {
				result.push({
					tokenId: record.tokenId,
					name: record.name,
					createdAt: record.createdAt,
					lastUsedAt: record.lastUsedAt,
				});
			}
		}
		return result;
	}

	async revokeBotToken(userId, tokenId) {
		const record = this.botTokens.get(tokenId);
		if (record && record.userId === userId) {
			this.botTokens.delete(tokenId);
			return true;
		}
		return false;
	}

	async updateBotTokenLastUsed(tokenId) {
		const record = this.botTokens.get(tokenId);
		if (record) {
			record.lastUsedAt = new Date();
		}
	}

	// ==================== Authorized Apps (NyaitterAuth) ====================

	async createAuthorizedApp(userId, appId, appTokenHash, appName, appIconUrl, scopes, accessTokenId = null, accessTokenHash = null) {
		const key = `${userId}:${appId}:${appTokenHash}`;
		const existingId = this.authorizedAppLookup.get(key);
		const id = existingId || this.nextAuthorizedAppId++;
		const now = new Date();
		const record = {
			id,
			userId: Number(userId),
			appId: String(appId),
			appTokenHash: String(appTokenHash),
			appName: String(appName),
			appIconUrl: appIconUrl ? String(appIconUrl) : null,
			scopes: Array.isArray(scopes) ? [...scopes] : [],
			accessTokenId: accessTokenId ? String(accessTokenId) : null,
			accessTokenHash: accessTokenHash ? String(accessTokenHash) : null,
			createdAt: existingId ? this.authorizedApps.get(existingId)?.createdAt || now : now,
			updatedAt: now,
			lastUsedAt: null,
		};
		if (existingId) {
			const prev = this.authorizedApps.get(existingId);
			if (prev?.accessTokenId && prev.accessTokenId !== accessTokenId) {
				this.authorizedAppByAccessTokenId.delete(prev.accessTokenId);
			}
		}
		this.authorizedApps.set(id, record);
		this.authorizedAppLookup.set(key, id);
		if (accessTokenId) {
			this.authorizedAppByAccessTokenId.set(accessTokenId, id);
		}
		return { ...record };
	}

	async getAuthorizedAppByUserAndAppToken(userId, appId, appTokenHash) {
		const key = `${userId}:${appId}:${appTokenHash}`;
		const id = this.authorizedAppLookup.get(key);
		if (!id) return null;
		const record = this.authorizedApps.get(id);
		return record ? { ...record } : null;
	}

	async getAuthorizedAppByAccessTokenId(accessTokenId) {
		if (!accessTokenId) return null;
		const id = this.authorizedAppByAccessTokenId.get(accessTokenId);
		if (!id) return null;
		const record = this.authorizedApps.get(id);
		return record ? { ...record } : null;
	}

	async getUserAuthorizedApps(userId) {
		const targetUserId = Number(userId);
		const results = [];
		for (const record of this.authorizedApps.values()) {
			if (record.userId === targetUserId) {
				results.push({ ...record });
			}
		}
		results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
		return results;
	}

	async getAuthorizedAppById(id, userId = null) {
		const numericId = Number(id);
		const record = this.authorizedApps.get(numericId);
		if (!record) return null;
		if (userId !== null && record.userId !== Number(userId)) return null;
		return { ...record };
	}

	async updateAuthorizedAppScopes(id, userId, scopes, accessTokenId = null, accessTokenHash = null) {
		const numericId = Number(id);
		const record = this.authorizedApps.get(numericId);
		if (!record || (userId !== null && record.userId !== Number(userId))) return null;
		if (record.accessTokenId && record.accessTokenId !== accessTokenId) {
			this.authorizedAppByAccessTokenId.delete(record.accessTokenId);
		}
		record.scopes = Array.isArray(scopes) ? [...scopes] : [];
		record.accessTokenId = accessTokenId ? String(accessTokenId) : null;
		record.accessTokenHash = accessTokenHash ? String(accessTokenHash) : null;
		record.updatedAt = new Date();
		if (accessTokenId) {
			this.authorizedAppByAccessTokenId.set(accessTokenId, numericId);
		}
		return { ...record };
	}

	async updateAuthorizedAppLastUsed(id) {
		const numericId = Number(id);
		const record = this.authorizedApps.get(numericId);
		if (record) {
			record.lastUsedAt = new Date();
		}
		return true;
	}

	async deleteAuthorizedApp(id, userId = null) {
		const numericId = Number(id);
		const record = this.authorizedApps.get(numericId);
		if (!record || (userId !== null && record.userId !== Number(userId))) return false;
		this.authorizedApps.delete(numericId);
		this.authorizedAppLookup.delete(`${record.userId}:${record.appId}:${record.appTokenHash}`);
		if (record.accessTokenId) {
			this.authorizedAppByAccessTokenId.delete(record.accessTokenId);
		}
		return true;
	}

	// ==================== Groups ====================

	_groupMemberKey(groupId, userId) {
		return `${String(groupId)}:${Number(userId)}`;
	}

	_groupMemberCount(groupId) {
		const userIds = this.groupMemberIdsByGroup.get(String(groupId)) || new Set();
		let count = 0;
		for (const userId of userIds) {
			if (this.groupMemberships.get(this._groupMemberKey(groupId, userId))?.status === 'active') count += 1;
		}
		return count;
	}

	_cloneGroup(group) {
		if (!group) return null;
		return {
			id: group.id, ownerId: group.ownerId, owner_id: group.ownerId, name: group.name,
			description: group.description, iconData: group.iconData, icon_data: group.iconData,
			headerImage: group.headerImage, header_image: group.headerImage, visibility: group.visibility,
			memberCount: this._groupMemberCount(group.id), member_count: this._groupMemberCount(group.id),
			deletedAt: group.deletedAt, deleted_at: group.deletedAt, createdAt: group.createdAt, created_at: group.createdAt,
			updatedAt: group.updatedAt, updated_at: group.updatedAt,
		};
	}

	_cloneGroupRole(role) {
		if (!role) return null;
		return { id: role.id, groupId: role.groupId, group_id: role.groupId, name: role.name,
			permissions: [...role.permissions], isSystem: role.isSystem, is_system: role.isSystem,
			sortOrder: role.sortOrder, sort_order: role.sortOrder, createdAt: role.createdAt, created_at: role.createdAt,
			updatedAt: role.updatedAt, updated_at: role.updatedAt };
	}

	_cloneGroupMembership(membership) {
		if (!membership) return null;
		return { groupId: membership.groupId, group_id: membership.groupId, userId: membership.userId, user_id: membership.userId,
			roleId: membership.roleId, role_id: membership.roleId, status: membership.status,
			joinedAt: membership.joinedAt, joined_at: membership.joinedAt, updatedAt: membership.updatedAt, updated_at: membership.updatedAt };
	}

	_cloneGroupInvite(invite) {
		if (!invite) return null;
		return { id: invite.id, groupId: invite.groupId, group_id: invite.groupId, inviterId: invite.inviterId, inviter_id: invite.inviterId,
			inviteeId: invite.inviteeId, invitee_id: invite.inviteeId, status: invite.status,
			createdAt: invite.createdAt, created_at: invite.createdAt, respondedAt: invite.respondedAt, responded_at: invite.respondedAt };
	}

	_cloneGroupJoinRequest(request) {
		if (!request) return null;
		return { id: request.id, groupId: request.groupId, group_id: request.groupId, userId: request.userId, user_id: request.userId,
			status: request.status, reviewedBy: request.reviewedBy, reviewed_by: request.reviewedBy,
			createdAt: request.createdAt, created_at: request.createdAt, reviewedAt: request.reviewedAt, reviewed_at: request.reviewedAt };
	}

	async createGroup(groupData) {
		const now = groupData.createdAt || new Date().toISOString();
		const group = { id: String(groupData.id || Date.now()), ownerId: Number(groupData.ownerId ?? groupData.owner_id), name: String(groupData.name || ''),
			description: String(groupData.description || ''), iconData: groupData.iconData ?? groupData.icon_data ?? null, headerImage: groupData.headerImage ?? groupData.header_image ?? null,
			visibility: String(groupData.visibility || 'open'), deletedAt: null, createdAt: now, updatedAt: now };
		this.groups.set(group.id, group);
		return this._cloneGroup(group);
	}

	async getGroupById(groupId) {
		const group = this.groups.get(String(groupId));
		return group && !group.deletedAt ? this._cloneGroup(group) : null;
	}

	async updateGroup(groupId, fields) {
		const group = this.groups.get(String(groupId));
		if (!group || group.deletedAt) return null;
		if (fields.name !== undefined) group.name = String(fields.name);
		if (fields.description !== undefined) group.description = String(fields.description);
		if (fields.iconData !== undefined || fields.icon_data !== undefined) group.iconData = fields.iconData ?? fields.icon_data ?? null;
		if (fields.headerImage !== undefined || fields.header_image !== undefined) group.headerImage = fields.headerImage ?? fields.header_image ?? null;
		if (fields.visibility !== undefined) group.visibility = String(fields.visibility);
		group.updatedAt = new Date().toISOString();
		return this._cloneGroup(group);
	}

	async deleteGroup(groupId) {
		const normalizedGroupId = String(groupId);
		const group = this.groups.get(normalizedGroupId);
		if (!group || group.deletedAt) return null;
		for (const post of [...this.posts.values()]) {
			if (String(post.groupId ?? post.group_id ?? '') === normalizedGroupId) {
				await this.adminDeletePost(post.id);
			}
		}
		group.deletedAt = new Date().toISOString();
		group.updatedAt = group.deletedAt;
		return this._cloneGroup(group);
	}

	async transferGroupOwnership(groupId, newOwnerId) {
		const group = this.groups.get(String(groupId));
		if (!group || group.deletedAt) return null;
		group.ownerId = Number(newOwnerId);
		group.updatedAt = new Date().toISOString();
		return this._cloneGroup(group);
	}

	async getGroupsByVisibility({ query = '', visibility = ['open', 'open_invite'], limit = 20, offset = 0 } = {}) {
		const allowed = new Set((Array.isArray(visibility) ? visibility : [visibility]).map(String));
		const q = String(query || '').trim().toLowerCase();
		return [...this.groups.values()]
			.filter((group) => !group.deletedAt && allowed.has(group.visibility))
			.filter((group) => !q || group.name.toLowerCase().includes(q) || group.description.toLowerCase().includes(q))
			.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id))
			.slice(Math.max(0, Number(offset) || 0), Math.max(0, Number(offset) || 0) + Math.max(1, Math.min(Number(limit) || 20, 100)))
			.map((group) => this._cloneGroup(group));
	}

	async getUserGroups(userId, { status = 'active', limit = 100, offset = 0 } = {}) {
		const ids = this.groupIdsByUser.get(Number(userId)) || new Set();
		const start = Math.max(0, Number(offset) || 0);
		const end = start + Math.max(1, Math.min(Number(limit) || 100, 200));
		return [...ids]
			.map((id) => ({ group: this.groups.get(id), membership: this.groupMemberships.get(this._groupMemberKey(id, userId)) }))
			.filter(({ group, membership }) => group && !group.deletedAt && membership?.status === status)
			.sort((a, b) => String(b.membership.joinedAt || '').localeCompare(String(a.membership.joinedAt || '')))
			.slice(start, end)
			.map(({ group, membership }) => ({ ...this._cloneGroup(group), membership: this._cloneGroupMembership(membership) }));
	}

	async getUsersGroupBadgesBatch(userIds) {
		const result = new Map();
		const ids = [...new Set((userIds || []).map(Number).filter(Number.isInteger))];
		for (const userId of ids) {
			const groupIds = this.groupIdsByUser.get(userId) || new Set();
			const activeGroupsWithIcons = [...groupIds]
				.map((id) => ({
					group: this.groups.get(id),
					membership: this.groupMemberships.get(this._groupMemberKey(id, userId)),
				}))
				.filter(({ group, membership }) => group && !group.deletedAt && membership?.status === 'active' && Boolean(group.iconData) && (group.visibility === 'open' || group.visibility === 'open_invite'))
				.sort((a, b) => String(b.membership.joinedAt || '').localeCompare(String(a.membership.joinedAt || '')))
				.slice(0, 3)
				.map(({ group }) => ({
					id: String(group.id),
					name: String(group.name || ''),
					icon_data: group.iconData,
				}));
			result.set(userId, activeGroupsWithIcons);
		}
		return result;
	}

	async getUserBootstrapData(userId, notificationLimit = 200) {
		const targetId = Number(userId);
		const [follow, like, star, pin, notifs, unreadCount, groupBadgesMap] = await Promise.all([
			this.getFollowIds(targetId),
			this.getLikeIds(targetId),
			this.getStarIds(targetId),
			this.getPinnedPostId(targetId),
			this.getNotifications(targetId, notificationLimit),
			this.getUnreadNotificationCount(targetId),
			this.getUsersGroupBadgesBatch([targetId]),
		]);
		const groupBadges = groupBadgesMap.get(targetId) || [];
		const fromUserIds = [...new Set((notifs || []).map((n) => Number(n.fromUserId || n.from_user_id)).filter(Number.isInteger))];
		const targetPostIds = [...new Set((notifs || []).map((n) => (n.target?.kind === 'post' ? Number(n.target.id) : null)).filter((id) => Number.isInteger(id) && id > 0))];
		const [notificationUsers, notificationPosts] = await Promise.all([
			this.getUsersByIds(fromUserIds),
			this.getPostsByIds(targetPostIds),
		]);
		return {
			follow,
			like,
			star,
			pin,
			unreadCount,
			group_badges: groupBadges,
			notifications: notifs,
			notificationUsers,
			notificationPosts,
		};
	}

	async createGroupRole(roleData) {
		const now = roleData.createdAt || new Date().toISOString();
		const role = { id: String(roleData.id), groupId: String(roleData.groupId), name: String(roleData.name || ''),
			permissions: Array.isArray(roleData.permissions) ? [...new Set(roleData.permissions.map(String))] : [],
			isSystem: Boolean(roleData.isSystem), sortOrder: Number(roleData.sortOrder) || 0, createdAt: now, updatedAt: now };
		this.groupRoles.set(role.id, role);
		if (!this.groupRoleIdsByGroup.has(role.groupId)) this.groupRoleIdsByGroup.set(role.groupId, new Set());
		this.groupRoleIdsByGroup.get(role.groupId).add(role.id);
		return this._cloneGroupRole(role);
	}

	async getGroupRoles(groupId) {
		return [...(this.groupRoleIdsByGroup.get(String(groupId)) || new Set())]
			.map((id) => this.groupRoles.get(id)).filter(Boolean)
			.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
			.map((role) => this._cloneGroupRole(role));
	}

	async updateGroupRole(roleId, fields) {
		const role = this.groupRoles.get(String(roleId));
		if (!role) return null;
		if (fields.name !== undefined) role.name = String(fields.name);
		if (fields.permissions !== undefined) role.permissions = Array.isArray(fields.permissions) ? [...new Set(fields.permissions.map(String))] : [];
		if (fields.sortOrder !== undefined || fields.sort_order !== undefined) role.sortOrder = Number(fields.sortOrder ?? fields.sort_order) || 0;
		role.updatedAt = new Date().toISOString();
		return this._cloneGroupRole(role);
	}

	async deleteGroupRole(roleId) {
		const role = this.groupRoles.get(String(roleId));
		if (!role) return null;
		this.groupRoles.delete(role.id);
		this.groupRoleIdsByGroup.get(role.groupId)?.delete(role.id);
		for (const membership of this.groupMemberships.values()) if (membership.roleId === role.id) membership.roleId = null;
		return this._cloneGroupRole(role);
	}

	async getGroupMembership(groupId, userId) {
		return this._cloneGroupMembership(this.groupMemberships.get(this._groupMemberKey(groupId, userId)) || null);
	}

	async getGroupMemberships(groupId, { status = null, limit = 100, offset = 0 } = {}) {
		const userIds = this.groupMemberIdsByGroup.get(String(groupId)) || new Set();
		const start = Math.max(0, Number(offset) || 0);
		const end = start + Math.max(1, Math.min(Number(limit) || 100, 200));
		return [...userIds].map((id) => this.groupMemberships.get(this._groupMemberKey(groupId, id))).filter(Boolean)
			.filter((membership) => !status || membership.status === status)
			.sort((a, b) => String(a.joinedAt || '').localeCompare(String(b.joinedAt || '')) || a.userId - b.userId)
			.slice(start, end).map((membership) => this._cloneGroupMembership(membership));
	}

	async createGroupMembership(membershipData) {
		const key = this._groupMemberKey(membershipData.groupId, membershipData.userId);
		const membership = { groupId: String(membershipData.groupId), userId: Number(membershipData.userId), roleId: membershipData.roleId ?? null,
			status: String(membershipData.status || 'active'), joinedAt: membershipData.joinedAt ?? null, updatedAt: membershipData.updatedAt || new Date().toISOString() };
		this.groupMemberships.set(key, membership);
		if (!this.groupMemberIdsByGroup.has(membership.groupId)) this.groupMemberIdsByGroup.set(membership.groupId, new Set());
		if (!this.groupIdsByUser.has(membership.userId)) this.groupIdsByUser.set(membership.userId, new Set());
		this.groupMemberIdsByGroup.get(membership.groupId).add(membership.userId);
		this.groupIdsByUser.get(membership.userId).add(membership.groupId);
		return this._cloneGroupMembership(membership);
	}

	async updateGroupMembership(groupId, userId, fields) {
		const membership = this.groupMemberships.get(this._groupMemberKey(groupId, userId));
		if (!membership) return null;
		if (fields.roleId !== undefined || fields.role_id !== undefined) membership.roleId = fields.roleId ?? fields.role_id ?? null;
		if (fields.status !== undefined) membership.status = String(fields.status);
		if (fields.joinedAt !== undefined || fields.joined_at !== undefined) membership.joinedAt = fields.joinedAt ?? fields.joined_at ?? null;
		membership.updatedAt = new Date().toISOString();
		return this._cloneGroupMembership(membership);
	}

	async createGroupInvite(inviteData) {
		const invite = { id: String(inviteData.id), groupId: String(inviteData.groupId), inviterId: Number(inviteData.inviterId),
			inviteeId: Number(inviteData.inviteeId), status: String(inviteData.status || 'pending'),
			createdAt: inviteData.createdAt || new Date().toISOString(), respondedAt: null };
		this.groupInvites.set(invite.id, invite);
		return this._cloneGroupInvite(invite);
	}

	async getGroupInvite(inviteId) { return this._cloneGroupInvite(this.groupInvites.get(String(inviteId)) || null); }

	async getGroupInvites({ groupId = null, inviteeId = null, status = null, limit = 100, offset = 0 } = {}) {
		if (groupId == null && inviteeId == null) return [];
		const start = Math.max(0, Number(offset) || 0);
		const end = start + Math.max(1, Math.min(Number(limit) || 100, 200));
		return [...this.groupInvites.values()].filter((invite) =>
			(groupId == null || invite.groupId === String(groupId)) && (inviteeId == null || invite.inviteeId === Number(inviteeId)) && (!status || invite.status === status)
		).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(start, end).map((invite) => this._cloneGroupInvite(invite));
	}

	async updateGroupInvite(inviteId, fields) {
		const invite = this.groupInvites.get(String(inviteId));
		if (!invite) return null;
		if (fields.status !== undefined) invite.status = String(fields.status);
		if (fields.respondedAt !== undefined || fields.responded_at !== undefined) invite.respondedAt = fields.respondedAt ?? fields.responded_at ?? null;
		else if (fields.status && fields.status !== 'pending') invite.respondedAt = new Date().toISOString();
		return this._cloneGroupInvite(invite);
	}

	async createGroupJoinRequest(requestData) {
		const request = { id: String(requestData.id), groupId: String(requestData.groupId), userId: Number(requestData.userId),
			status: String(requestData.status || 'pending'), reviewedBy: null, createdAt: requestData.createdAt || new Date().toISOString(), reviewedAt: null };
		this.groupJoinRequests.set(request.id, request);
		return this._cloneGroupJoinRequest(request);
	}

	async getGroupJoinRequest(requestId) { return this._cloneGroupJoinRequest(this.groupJoinRequests.get(String(requestId)) || null); }

	async getGroupJoinRequests({ groupId = null, userId = null, status = null, limit = 100, offset = 0 } = {}) {
		if (groupId == null && userId == null) return [];
		const start = Math.max(0, Number(offset) || 0);
		const end = start + Math.max(1, Math.min(Number(limit) || 100, 200));
		return [...this.groupJoinRequests.values()].filter((request) =>
			(groupId == null || request.groupId === String(groupId)) && (userId == null || request.userId === Number(userId)) && (!status || request.status === status)
		).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(start, end).map((request) => this._cloneGroupJoinRequest(request));
	}

	async updateGroupJoinRequest(requestId, fields) {
		const request = this.groupJoinRequests.get(String(requestId));
		if (!request) return null;
		if (fields.status !== undefined) request.status = String(fields.status);
		if (fields.reviewedBy !== undefined || fields.reviewed_by !== undefined) request.reviewedBy = fields.reviewedBy ?? fields.reviewed_by ?? null;
		if (fields.reviewedAt !== undefined || fields.reviewed_at !== undefined) request.reviewedAt = fields.reviewedAt ?? fields.reviewed_at ?? null;
		else if (fields.status && fields.status !== 'pending') request.reviewedAt = new Date().toISOString();
		return this._cloneGroupJoinRequest(request);
	}

	_groupPostResult(posts, limit, offset, beforeId) {
		const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
		const filtered = posts.filter((post) => !beforeId || Number(post.id) < Number(beforeId))
			.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || Number(b.id) - Number(a.id));
		const useOffset = !beforeId;
		const visible = useOffset ? filtered.slice(Math.max(0, Number(offset) || 0), Math.max(0, Number(offset) || 0) + safeLimit + 1) : filtered.slice(0, safeLimit + 1);
		const ids = visible.slice(0, safeLimit).map((post) => Number(post.id));
		return { ids, has_more: visible.length > safeLimit, next_cursor: visible.length > safeLimit ? ids.at(-1) || null : null };
	}

	async getGroupPostIds(groupId, { limit = 30, offset = 0, beforeId = null, authorId = null, subType = 'posts_only' } = {}) {
		const normalizedAuthorId = authorId == null || authorId === ''
			? null
			: (Number.isInteger(Number(authorId)) && Number(authorId) >= 0 ? Number(authorId) : null);
		const replyOnly = subType === 'replies_only';
		return this._groupPostResult([...this.posts.values()].filter((post) => post.groupId === String(groupId)
			&& (replyOnly ? post.replyTo != null : post.replyTo == null)
			&& (normalizedAuthorId == null || Number(post.userId) === normalizedAuthorId)), limit, offset, beforeId);
	}

	async getGroupAnnouncementPostIds(groupId, { limit = 30, offset = 0, beforeId = null } = {}) {
		return this._groupPostResult([...this.posts.values()].filter((post) => post.groupId === String(groupId) && post.groupAnnouncement), limit, offset, beforeId);
	}

	async searchGroupPostIds(userId, query, { limit = 30, offset = 0, beforeId = null } = {}) {
		const q = String(query || '').trim().toLowerCase();
		if (!q) return { ids: [], has_more: false, next_cursor: null };
		const activeGroupIds = new Set((this.groupIdsByUser.get(Number(userId)) || new Set()).values());
		const posts = [...this.posts.values()].filter((post) => post.groupId && activeGroupIds.has(post.groupId) &&
			this.groupMemberships.get(this._groupMemberKey(post.groupId, userId))?.status === 'active' && String(post.content || '').toLowerCase().includes(q));
		return this._groupPostResult(posts, limit, offset, beforeId);
	}

	async createPost(postData) {
		const id = this.nextPostId++;
		const post = {
			id,
			userId: postData.userId,
				content: postData.content,
				tags: Array.isArray(postData.tags) ? [...new Set(postData.tags.map((tag) => String(tag || '').trim().toLowerCase()).filter(Boolean))].slice(0, 5) : [],
				tagsGeneratedAt: postData.tagsGeneratedAt || null,
				attachments: postData.attachments || null,
			mask: !!postData.mask,
			lock: !!postData.lock,
			announcement: !!postData.announcement,
			groupId: postData.groupId ?? postData.group_id ?? null,
			group_id: postData.groupId ?? postData.group_id ?? null,
			groupAnnouncement: !!(postData.groupAnnouncement ?? postData.group_announcement),
			group_announcement: !!(postData.groupAnnouncement ?? postData.group_announcement),
			replyTo: postData.replyTo || null,
			repostTo: postData.repostTo || null,
			createdAt: new Date(),
		};
		this.posts.set(id, post);
		this._addPostIndexes(post);
		this._adjustUserKeywordAffinitiesForTags(post.userId, post.tags, 1);
		return post;
	}

			async getPostById(id) {
			return this.posts.get(id) || null;
		}

		async getPostsByIds(postIds) {
			const uniqueIds = [...new Set((postIds || []).map(Number).filter(Number.isInteger))];
			return uniqueIds
				.map((id) => this.posts.get(id))
				.filter(Boolean);
		}

		async getPostReferencesByIds(postIds, maxDepth = 2) {
			const ids = [...new Set((postIds || []).map(Number).filter(Number.isInteger))];
			const normalizedMaxDepth = Math.min(4, Math.max(0, Number(maxDepth) || 0));
			if (ids.length === 0) return [];

			const result = new Map();
			let currentIds = ids;
			for (let depth = 0; depth <= normalizedMaxDepth && currentIds.length > 0; depth += 1) {
				const nextIds = [];
				for (const id of currentIds) {
					const post = this.posts.get(id);
					if (post) {
						result.set(id, post);
						if (post.replyTo != null && !result.has(Number(post.replyTo))) {
							nextIds.push(Number(post.replyTo));
						}
						if (post.repostTo != null && !result.has(Number(post.repostTo))) {
							nextIds.push(Number(post.repostTo));
						}
					}
				}
				currentIds = [...new Set(nextIds)];
			}
			return Array.from(result.values());
		}

		async auditAndHealPostCounters(postId) {
			const id = Number(postId);
			const post = this.posts.get(id);
			if (!post) return null;

			let likes = 0;
			for (const key of this.likes.keys()) {
				if (Number(key.split(':')[1]) === id) likes += 1;
			}
			let stars = 0;
			for (const key of this.stars.keys()) {
				if (Number(key.split(':')[1]) === id) stars += 1;
			}
			let reposts = 0;
			for (const candidate of this.posts.values()) {
				if (Number(candidate.repostTo) === id) reposts += 1;
			}
			let replies = 0;
			for (const candidate of this.posts.values()) {
				if (Number(candidate.replyTo) === id) replies += 1;
			}

			this.likeCountByPost.set(id, likes);
			this.starCountByPost.set(id, stars);
			this.repostCountByPost.set(id, reposts);
			this.replyCountByParent.set(id, replies);

			post.likeCount = likes;
			post.starCount = stars;
			post.repostCount = reposts;
			post.replyCount = replies;
			return post;
		}

		async auditAndHealUserCounters(userId) {
			const id = Number(userId);
			const user = this.users.get(id);
			if (!user) return null;

			const followers = this.followerIdsByUser.get(id)?.size || 0;
			const followings = this.followingIdsByUser.get(id)?.size || 0;
			let posts = 0;
			for (const candidate of this.posts.values()) {
				if (Number(candidate.userId) === id && !candidate.repostTo) posts += 1;
			}

			return {
				userId: id,
				followerCount: followers,
				followingCount: followings,
				postCount: posts,
			};
		}

		async getPostMetricsBatch(postIds, currentUserId = null) {
			const ids = [...new Set((postIds || []).map(Number).filter(Number.isInteger))];
			return ids.map((id) => ({
				post_id: id,
				like_count: this.likeCountByPost.get(id) || 0,
				star_count: this.starCountByPost.get(id) || 0,
				reply_count: this.replyCountByParent.get(id) || 0,
				repost_count: this.repostCountByPost.get(id) || 0,
				liked_by_me: currentUserId != null && this.likes.has(`${Number(currentUserId)}:${id}`),
				starred_by_me: currentUserId != null && this.stars.has(`${Number(currentUserId)}:${id}`),
			}));
		}

		async updatePost(postId, fields) {

		const post = this.posts.get(postId);
		if (!post) return null;
		const previousTags = Array.isArray(post.tags) ? [...post.tags] : [];
			if (fields.content !== undefined) post.content = fields.content;
			if (fields.tags !== undefined) post.tags = Array.isArray(fields.tags) ? [...new Set(fields.tags.map((tag) => String(tag || '').trim().toLowerCase()).filter(Boolean))].slice(0, 5) : [];
			if (fields.tagsGeneratedAt !== undefined) post.tagsGeneratedAt = fields.tagsGeneratedAt || null;
			if (fields.attachments !== undefined) post.attachments = fields.attachments;
					if (fields.mask !== undefined) post.mask = !!fields.mask;
			if (fields.lock !== undefined) post.lock = !!fields.lock;
			if (fields.tags !== undefined) {
				this._adjustUserKeywordAffinitiesForTags(post.userId, previousTags, -1);
				this._adjustUserKeywordAffinitiesForTags(post.userId, post.tags, 1);
			}
			return post;

	}

	
		async getPostDetail(id, currentUserId = null) {
		const postId = Number(id);
		const post = this.posts.get(postId);
		if (!post) return null;

		// このアダプターでは関連データがすべてMap索引にあるため、非同期メソッドを
		// 経由せず直接参照して、不要なPromise生成を避ける。
		const author = this.users.get(Number(post.userId)) || null;
		const likeCount = this.likeCountByPost.get(postId) || 0;
		const starCount = this.starCountByPost.get(postId) || 0;
		const viewerId = currentUserId == null ? null : Number(currentUserId);
		const likedByMe = viewerId != null && this.likes.has(`${viewerId}:${postId}`);
		const starredByMe = viewerId != null && this.stars.has(`${viewerId}:${postId}`);
		let parentPost = null;
		if (post.replyTo) {
			const parent = this.posts.get(Number(post.replyTo));
			if (parent) {
				const parentAuthor = this.users.get(Number(parent.userId)) || null;
				parentPost = {
					id: parent.id,
					content: parent.content?.substring(
						0,
						config.limits.parentPostPreviewLength,
					),
					author: parentAuthor
						? { id: parentAuthor.id, name: parentAuthor.name }
						: null,
				};
			}
		}

		return {
			...post,
			author: author
				? {
						id: author.id,
						name: author.name,
						scid: author.scid,
					}
				: null,
			like_count: likeCount,
			liked_by_me: likedByMe,
			star_count: starCount,
			starred_by_me: starredByMe,
			parent_post: parentPost,
		};
	}

	
	async getRecentPosts(limit = config.limits.timelinePageSize) {
		const normalizedLimit = Math.max(0, Number(limit) || 0);
		const posts = [];
		for (const id of this.postIdsNewest) {
			const post = this.posts.get(id);
			if (!post || post.groupId || post.group_id || post.replyTo != null) continue;
			posts.push(post);
			if (posts.length >= normalizedLimit) break;
		}
		return posts;
	}

	
		async getPostsByUserId(userId, limit = config.limits.timelinePageSize, _currentUserId = null) {
			const ids = this.postIdsByUser.get(Number(userId)) || [];
			return ids
				.map((id) => this.posts.get(id))
				.filter((post) => post && !post.groupId && !post.group_id)
				.slice(0, Math.max(0, Number(limit) || 0));
		}

	async toggleLike(userId, postId) {
		const key = `${userId}:${postId}`;
		const currentlyLiked = this.likes.has(key);

		const currentCount = this.likeCountByPost.get(postId) || 0;
			if (currentlyLiked) {
				this.likes.delete(key);
				this._updateUserReactionIndex(this.likedPostIdsByUser, userId, postId, false);
				this.likeCountByPost.set(postId, Math.max(0, currentCount - 1));
				this._adjustUserKeywordAffinities(userId, postId, -1);
							} else {
					this.likes.set(key, new Date().toISOString());
					this._updateUserReactionIndex(this.likedPostIdsByUser, userId, postId, true);

					this.likeCountByPost.set(postId, currentCount + 1);
					this._adjustUserKeywordAffinities(userId, postId, 1);
				}

		const count = this.likeCountByPost.get(postId) || 0;

		return {
			liked: !currentlyLiked,
			count,
		};
	}

	getLikeCountForPost(postId) {
		return this.likeCountByPost.get(Number(postId)) || 0;
	}

	async getLikeCount(postId) {
		return this.getLikeCountForPost(postId);
	}

	async hasUserLikedPost(userId, postId) {
		return this.likes.has(`${userId}:${postId}`);
	}

	async toggleStar(userId, postId) {
		const key = `${userId}:${postId}`;
		const currentlyStarred = this.stars.has(key);

		const currentCount = this.starCountByPost.get(postId) || 0;
			if (currentlyStarred) {
				this.stars.delete(key);
				this._updateUserReactionIndex(this.starredPostIdsByUser, userId, postId, false);
				this.starCountByPost.set(postId, Math.max(0, currentCount - 1));
				this._adjustUserKeywordAffinities(userId, postId, -3);
							} else {
					this.stars.set(key, new Date().toISOString());
					this._updateUserReactionIndex(this.starredPostIdsByUser, userId, postId, true);

					this.starCountByPost.set(postId, currentCount + 1);
					this._adjustUserKeywordAffinities(userId, postId, 3);
				}

		const count = this.starCountByPost.get(postId) || 0;

		return {
			starred: !currentlyStarred,
			count,
		};
	}

	getStarCountForPost(postId) {
		return this.starCountByPost.get(Number(postId)) || 0;
	}

	async getStarCount(postId) {
		return this.getStarCountForPost(postId);
	}

	async hasUserStarredPost(userId, postId) {
		return this.stars.has(`${userId}:${postId}`);
	}

	
	async getDmList(userId) {
		// 簡易実装：uniqueChannelId に userId が含まれるチャネルをすべて返す
		const channels = Array.from(this.dmChannels.values())
			.filter((ch) => ch.participants.includes(userId))
			.map((ch) => {
				const otherUserId = ch.participants.find((id) => id !== userId);
				const otherUser = otherUserId
					? this.getUserById(otherUserId)
					: null;

				const lastMsg = ch.messages[ch.messages.length - 1] || null;

				return {
					id: ch.id,
					participants: ch.participants,
					other_user: otherUser
						? {
								id: otherUser.id,
								name: otherUser.name,
								scid: otherUser.scid,
							}
						: null,
					last_message: lastMsg
						? {
								id: lastMsg.id,
								content: lastMsg.content,
								sender_id: lastMsg.senderId,
								sent_at: lastMsg.sentAt,
							}
						: null,
					unread_count: ch.unreadCounts?.[userId] || 0,
				};
			});

		return channels;
	}

	
	async getOrCreateDmChannel(userId1, userId2) {
		const [user1, user2] =
			userId1 < userId2 ? [userId1, userId2] : [userId2, userId1];
		const channelId = `${user1}:${user2}`;

		if (!this.dmChannels.has(channelId)) {
			this.dmChannels.set(channelId, {
				id: channelId,
				participants: [user1, user2],
				messages: [],
				createdAt: new Date(),
				unreadCounts: { [user1]: 0, [user2]: 0 },
			});
		}

		return this.dmChannels.get(channelId);
	}

	
	async getDmMessages(channelId, limit = 50, offset = 0) {
		const channel = this.dmChannels.get(channelId);
		if (!channel) return [];

		const allMessages = channel.messages.slice().reverse();
		return allMessages.slice(offset, offset + limit).reverse();
	}

	
	async sendDmMessage(channelId, senderId, content) {
		const channel = this.dmChannels.get(channelId);
		if (!channel) throw new Error('Channel not found');

		const message = {
			id: Date.now() + Math.random(),
			channelId,
			senderId,
			content,
			sentAt: new Date(),
			readAt: null,
		};

		channel.messages.push(message);

		for (const participantId of channel.participants) {
			if (participantId !== senderId) {
				channel.unreadCounts[participantId] =
					(channel.unreadCounts[participantId] || 0) + 1;
			}
		}

		return message;
	}

	
	async markDmMessagesAsRead(channelId, userId) {
		const channel = this.dmChannels.get(channelId);
		if (!channel) throw new Error('Channel not found');

		channel.unreadCounts[userId] = 0;

		for (const msg of channel.messages) {
			if (msg.senderId !== userId && !msg.readAt) {
				msg.readAt = new Date();
			}
		}
	}

	
	async getUnreadDmCount(userId) {
		let total = 0;
		for (const channel of this.dmChannels.values()) {
			if (channel.participants.includes(userId)) {
				total += channel.unreadCounts[userId] || 0;
			}
		}
		return total;
	}

	_serializeGroupDm(dm, userId) {
		return {
			id: dm.id,
			title: dm.title || '',
			member: dm.member.slice(),
			accepted: Array.isArray(dm.accepted) ? dm.accepted.slice() : dm.member.slice(),
			host_id: dm.host_id,
			time: dm.time,
			post: dm.post ? dm.post.slice() : [],
			unread: dm.unread ? { ...dm.unread } : {},
			unread_count: (dm.unread && dm.unread[userId]) || 0,
		};
	}

	async getGroupDmsForUser(userId) {
		const dmIds = this.groupDmIdsByMember.get(Number(userId)) || new Set();
		const result = [...dmIds]
			.map((dmId) => this.groupDms.get(dmId))
			.filter(Boolean)
			.map((dm) => this._serializeGroupDm(dm, userId));
		result.sort((a, b) => new Date(b.time) - new Date(a.time));
		return result;
	}

		async getGroupDm(dmId) {
			return this.groupDms.get(dmId)
				|| this.groupDms.get(Number(dmId))
				|| null;
		}

	async createGroupDm(dmData) {
		const id = this.nextDmId++;
		const dm = {
			id,
			host_id: dmData.hostId,
			member: dmData.member.slice(),
			accepted: Array.isArray(dmData.accepted) ? dmData.accepted.slice() : dmData.member.slice(),
			title: dmData.title || '',
			time: new Date().toISOString(),
			post: [],
			unread: dmData.unread && typeof dmData.unread === 'object' ? { ...dmData.unread } : {},
		};
		this.groupDms.set(id, dm);
		this._addGroupDmMemberIndexes(dm);
		return this._serializeGroupDm(dm, dmData.hostId);
	}

	async updateGroupDm(dmId, updates) {
		const dm = this.groupDms.get(Number(dmId));
		if (!dm) return null;

		if (updates.title !== undefined) dm.title = updates.title;
		if (updates.member !== undefined) {
			this._removeGroupDmMemberIndexes(dm);
			const memberSet = new Set(updates.member.map(Number).filter(Number.isInteger));
			dm.member = Array.from(memberSet);
			this._addGroupDmMemberIndexes(dm);
		}
		if (updates.accepted !== undefined) {
			dm.accepted = Array.from(new Set(updates.accepted.map(Number).filter(Number.isInteger)));
		}
		if (updates.host_id !== undefined && updates.host_id !== null) {
			dm.host_id = updates.host_id;
		}
		if (updates.post !== undefined) dm.post = updates.post.slice();
		if (updates.time !== undefined) dm.time = updates.time;

		return this._serializeGroupDm(dm, dm.host_id);
	}

	async appendToGroupDm(dmId, message, senderId = null) {
		const dm = this.groupDms.get(Number(dmId));
		if (!dm) return null;

		dm.post = dm.post || [];
		dm.post.push(message);
		dm.time = message.time || new Date().toISOString();

		if (senderId !== null) {
			dm.unread = dm.unread || {};
			for (const memberId of dm.member) {
				if (memberId !== senderId) {
					dm.unread[memberId] = (dm.unread[memberId] || 0) + 1;
					this.groupDmUnreadTotalByMember.set(memberId, (this.groupDmUnreadTotalByMember.get(memberId) || 0) + 1);
				}
			}
		}

		return this._serializeGroupDm(dm, senderId);
	}

	async markGroupDmRead(dmId, userId) {
		const dm = this.groupDms.get(Number(dmId));
		if (!dm) return;
		dm.unread = dm.unread || {};
		const previous = Number(dm.unread[userId] || 0);
		dm.unread[userId] = 0;
		if (previous > 0) {
			const nextTotal = Math.max(0, (this.groupDmUnreadTotalByMember.get(Number(userId)) || 0) - previous);
			if (nextTotal === 0) this.groupDmUnreadTotalByMember.delete(Number(userId));
			else this.groupDmUnreadTotalByMember.set(Number(userId), nextTotal);
		}
	}

	async getGroupDmUnreadCounts(userId) {
		const dmIds = this.groupDmIdsByMember.get(Number(userId)) || new Set();
		return [...dmIds].map((dmId) => {
			const dm = this.groupDms.get(dmId);
			return { dm_id: dmId, unread_count: Number(dm?.unread?.[userId] || 0) };
		});
	}

	async getGroupDmUnreadTotal(userId) {
		return this.groupDmUnreadTotalByMember.get(Number(userId)) || 0;
	}

	async deleteGroupDm(dmId) {
		const normalizedDmId = Number(dmId);
		const dm = this.groupDms.get(normalizedDmId);
		if (!dm) return false;
		this._removeGroupDmMemberIndexes(dm);
		return this.groupDms.delete(normalizedDmId);
	}

	async leaveGroupDm(dmId, userId) {
		const dm = this.groupDms.get(Number(dmId));
		if (!dm) return false;
		this._removeGroupDmMemberIndexes(dm);
		dm.member = dm.member.filter((id) => id !== userId);
		if (dm.unread) delete dm.unread[userId];
		this._addGroupDmMemberIndexes(dm);
		return true;
	}

	async findGroupDmByMembers(memberIds) {
		const target = memberIds.slice().sort((a, b) => a - b);
		for (const dm of this.groupDms.values()) {
			const current = dm.member.slice().sort((a, b) => a - b);
			if (
				current.length === target.length &&
				current.every((id, i) => id === target[i])
			) {
				return dm;
			}
		}
		return null;
	}

	async getDmPublicKeys(userIds) {
		const ids = Array.from(
			new Set((userIds || []).map(Number).filter((id) => Number.isInteger(id) && id >= 0)),
		);
		return ids
			.filter((id) => this.dmE2EKeys.has(id))
			.map((id) => ({ user_id: id, public_key: this.dmE2EKeys.get(id).public_key }));
	}

	async setDmPublicKey(userId, publicKey) {
		const id = Number(userId);
		const existing = this.dmE2EKeys.get(id);
		const now = new Date().toISOString();
		this.dmE2EKeys.set(id, {
			public_key: String(publicKey),
			created_at: existing?.created_at || now,
			updated_at: now,
		});
	}

	async toggleFollow(followerId, followingId) {
		if (followerId === followingId) {
			throw new Error('Cannot follow yourself');
		}

		const key = `${followerId}:${followingId}`;
		const currentlyFollowing = this.follows.has(key);

		if (currentlyFollowing) {
			this.follows.delete(key);
			this._updateFollowIndexes(followerId, followingId, false);
					} else {
				this.follows.set(key, new Date().toISOString());
				this._updateFollowIndexes(followerId, followingId, true);

		}

		return {
			following: !currentlyFollowing,
		};
	}

	async isFollowing(followerId, followingId) {
		return this.follows.has(`${followerId}:${followingId}`);
	}

	async getFollowing(userId, limit = config.limits.followingPageSize) {
		const ids = this.followingIdsByUser.get(Number(userId)) || new Set();
		return [...ids]
			.slice(0, Math.max(0, Number(limit) || 0))
			.map((followingId) => this.users.get(followingId))
			.filter(Boolean);
	}

	async getFollowers(userId, limit = config.limits.followingPageSize) {
		const ids = this.followerIdsByUser.get(Number(userId)) || new Set();
		return [...ids]
			.slice(0, Math.max(0, Number(limit) || 0))
			.map((followerId) => this.users.get(followerId))
			.filter(Boolean);
	}

	async deletePost(postId, userId) {
		const post = this.posts.get(postId);
		if (!post || post.userId !== userId) {
			return false;
		}

		this.posts.delete(postId);
		this._removePostIndexes(post);
		if (post.repostTo != null) {
			const repostKey = `${post.userId}:${post.repostTo}`;
			if (this.reposts.delete(repostKey)) {
				const originalId = Number(post.repostTo);
				this.repostCountByPost.set(originalId, Math.max(0, (this.repostCountByPost.get(originalId) || 1) - 1));
			}
		}

			for (const key of Array.from(this.likes.keys())) {
				if (key.endsWith(`:${postId}`)) {
					const [reactionUserId] = key.split(':').map(Number);
					this.likes.delete(key);
					this._updateUserReactionIndex(this.likedPostIdsByUser, reactionUserId, postId, false);
				}
			}
			for (const key of Array.from(this.stars.keys())) {
				if (key.endsWith(`:${postId}`)) {
					const [reactionUserId] = key.split(':').map(Number);
					this.stars.delete(key);
					this._updateUserReactionIndex(this.starredPostIdsByUser, reactionUserId, postId, false);
				}
			}
		for (const key of Array.from(this.reposts.keys())) {
			if (key.endsWith(`:${postId}`)) {
				this.reposts.delete(key);
			}
		}
		for (const key of Array.from(this.pinnedPosts.keys())) {
			if (key.endsWith(`:${postId}`)) {
				this.pinnedPosts.delete(key);
			}
		}

		return true;
	}

	async adminDeletePost(postId) {
		const post = this.posts.get(postId);
		if (!post) return false;

		this.posts.delete(postId);
		this._removePostIndexes(post);
		if (post.repostTo != null) {
			const repostKey = `${post.userId}:${post.repostTo}`;
			if (this.reposts.delete(repostKey)) {
				const originalId = Number(post.repostTo);
				this.repostCountByPost.set(originalId, Math.max(0, (this.repostCountByPost.get(originalId) || 1) - 1));
			}
		}

			for (const key of Array.from(this.likes.keys())) {
				if (key.endsWith(`:${postId}`)) {
					const [reactionUserId] = key.split(':').map(Number);
					this.likes.delete(key);
					this._updateUserReactionIndex(this.likedPostIdsByUser, reactionUserId, postId, false);
				}
			}
			for (const key of Array.from(this.stars.keys())) {
				if (key.endsWith(`:${postId}`)) {
					const [reactionUserId] = key.split(':').map(Number);
					this.stars.delete(key);
					this._updateUserReactionIndex(this.starredPostIdsByUser, reactionUserId, postId, false);
				}
			}
		for (const key of Array.from(this.reposts.keys())) {
			if (key.endsWith(`:${postId}`)) this.reposts.delete(key);
		}
		for (const key of Array.from(this.pinnedPosts.keys())) {
			if (key.endsWith(`:${postId}`)) this.pinnedPosts.delete(key);
		}

		// Note: Attachment cleanup should be handled at route level with storageAdapter

		return true;
	}

	async togglePin(userId, postId) {
		const post = this.posts.get(postId);
		if (!post || post.userId !== userId) {
			throw new Error('Cannot pin a post you do not own');
		}

		const key = `${userId}:${postId}`;
		const currentlyPinned = this.pinnedPosts.has(key);

		if (currentlyPinned) {
			this.pinnedPosts.delete(key);
			} else {
				this.pinnedPosts.set(key, new Date().toISOString());
			}

		return {
			pinned: !currentlyPinned,
		};
	}

	async getPinnedPosts(userId) {
		const result = [];
		for (const key of this.pinnedPosts.keys()) {
			const [uId, postId] = key.split(':').map(Number);
			if (uId === userId) {
				const post = this.posts.get(postId);
				if (post) {
					result.push(post);
				}
			}
		}
		return result;
	}

	async repostPost(userId, postId) {
		const originalPost = this.posts.get(postId);
		if (!originalPost) {
			throw new Error('Post not found');
		}

		const key = `${userId}:${postId}`;
		if (this.reposts.has(key)) {
			throw new Error('Already reposted');
		}

			this.reposts.set(key, new Date().toISOString());
			this.repostCountByPost.set(postId, (this.repostCountByPost.get(postId) || 0) + 1);

		const repostId = this.nextPostId++;
		const repost = {
			id: repostId,
			userId,
			content: null,
			attachments: null,
			mask: originalPost.mask,
			lock: !!originalPost.lock,
			repostTo: postId,
			createdAt: new Date(),
		};
		this.posts.set(repostId, repost);
		this._addPostIndexes(repost);

		return repost;
	}

	async getReposts(userId) {
		const result = [];
		for (const key of this.reposts.keys()) {
			const [uId, postId] = key.split(':').map(Number);
			if (uId === userId) {
				const post = this.posts.get(postId);
				if (post) {
					result.push({
						id: post.id,
						content: post.content,
						repostOf: postId,
						createdAt: post.createdAt,
					});
				}
			}
		}
		return result;
	}

	async getRepostsOfPost(postId, limit = 50) {
		const result = [];
		for (const key of this.reposts.keys()) {
			const [uId, pId] = key.split(':').map(Number);
			if (pId === postId) {
				const user = this.users.get(uId);
				if (user) {
					result.push({
						userId: uId,
						name: user.name,
						handle: user.handle,
					});
					if (result.length >= limit) break;
				}
			}
		}
		return result;
	}

	getRepostCountForPost(postId) {
		return this.repostCountByPost.get(Number(postId)) || 0;
	}

	async getRepostCount(postId) {
		return this.getRepostCountForPost(postId);
	}

		async createNotification(notificationData) {
			const id = this.nextNotificationId++;
			const userId = Number(notificationData.userId);
			const notification = {
				id,
				userId,
				type: notificationData.type,
				fromUserId: notificationData.fromUserId ?? null,
				target: normalizeTarget(notificationData.target, {
					postId: notificationData.postId,
					open: notificationData.open,
				}),
				read: false,
				clicked: false,
				message: typeof notificationData.message === 'string' ? notificationData.message : null,
				createdAt: new Date(),
			};

			if (!this.notifications.has(userId)) this.notifications.set(userId, []);
			this.notifications.get(userId).push(notification);
			this.notificationsById.set(id, notification);
			this.unreadNotificationCounts.set(
				userId,
				(this.unreadNotificationCounts.get(userId) || 0) + 1,
			);
			return notification;
		}

		async getNotifications(userId, limit = 50, offset = 0) {
			const notifications = this.notifications.get(Number(userId)) || [];
			// 追加順が古い→新しいなので、配列の複製・全件ソートを避けて後方から切り出す。
			const start = Math.max(0, notifications.length - Math.max(0, Number(offset) || 0) - Math.max(0, Number(limit) || 0));
			const end = Math.max(0, notifications.length - Math.max(0, Number(offset) || 0));
			return notifications.slice(start, end).reverse();
		}

		async getNotificationById(notificationId) {
			return this.notificationsById.get(Number(notificationId)) || null;
		}

		async markNotificationAsRead(notificationId) {
			const notification = this.notificationsById.get(Number(notificationId));
			if (!notification || notification.read) return;
			notification.read = true;
			const userId = Number(notification.userId);
			this.unreadNotificationCounts.set(
				userId,
				Math.max(0, (this.unreadNotificationCounts.get(userId) || 0) - 1),
			);
		}

		async markNotificationAsClicked(notificationId) {
			const notification = this.notificationsById.get(Number(notificationId));
			if (notification) notification.clicked = true;
		}

		async deleteNotification(notificationId) {
			const notification = this.notificationsById.get(Number(notificationId));
			if (!notification) return false;
			const userId = Number(notification.userId);
			const notifications = this.notifications.get(userId) || [];
			const index = notifications.indexOf(notification);
			if (index >= 0) notifications.splice(index, 1);
			if (notifications.length === 0) this.notifications.delete(userId);
			this.notificationsById.delete(Number(notificationId));
			if (!notification.read) {
				this.unreadNotificationCounts.set(
					userId,
					Math.max(0, (this.unreadNotificationCounts.get(userId) || 0) - 1),
				);
			}
			return true;
		}

		async markAllNotificationsAsRead(userId) {
			const normalizedUserId = Number(userId);
			const notifications = this.notifications.get(normalizedUserId) || [];
			for (const notification of notifications) notification.read = true;
			this.unreadNotificationCounts.set(normalizedUserId, 0);
		}

		async markAllNotificationsAsClicked(userId) {
			const normalizedUserId = Number(userId);
			const notifications = this.notifications.get(normalizedUserId) || [];
			for (const notification of notifications) {
				notification.read = true;
				notification.clicked = true;
			}
			this.unreadNotificationCounts.set(normalizedUserId, 0);
		}

		async getUnreadNotificationCount(userId) {
			return this.unreadNotificationCounts.get(Number(userId)) || 0;
		}

		_copyModerationReport(report) {
			if (!report) return null;
			return {
				...report,
				targetSnapshot: JSON.parse(JSON.stringify(report.targetSnapshot || {})),
				excludedAdminIds: [...(report.excludedAdminIds || [])],
				resolution: report.resolution == null
					? null
					: JSON.parse(JSON.stringify(report.resolution)),
			};
		}

		async createModerationReport(reportData) {
			const now = reportData.createdAt ? new Date(reportData.createdAt) : new Date();
			const report = {
				id: this.nextModerationReportId++,
				reporterUserId: Number(reportData.reporterUserId),
				targetKind: String(reportData.targetKind),
				targetId: String(reportData.targetId),
				description: String(reportData.description || ''),
				targetSnapshot: JSON.parse(JSON.stringify(reportData.targetSnapshot || {})),
				assignmentType: ['freeze_appeal', 'verification_application'].includes(reportData.assignmentType)
					? reportData.assignmentType
					: 'report',
				status: 'pending',
				assignedAdminId: null,
				assignedAt: null,
				excludedAdminIds: [],
				resolution: null,
				createdAt: now,
				resolvedAt: null,
			};
			this.moderationReports.set(report.id, report);
			return this._copyModerationReport(report);
		}

		async getOpenModerationAppealByUserId(userId) {
			const appeal = [...this.moderationReports.values()]
				.filter((report) => Number(report.reporterUserId) === Number(userId))
				.filter((report) => report.assignmentType === 'freeze_appeal' && report.status !== 'resolved')
				.sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))[0];
			return this._copyModerationReport(appeal);
		}

		async getOpenModerationVerificationByUserId(userId) {
			const request = [...this.moderationReports.values()]
				.filter((report) => Number(report.reporterUserId) === Number(userId))
				.filter((report) => report.assignmentType === 'verification_application' && report.status !== 'resolved')
				.sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))[0];
			return this._copyModerationReport(request);
		}

		async getModerationReportById(reportId) {
			return this._copyModerationReport(this.moderationReports.get(Number(reportId)));
		}

		async listModerationReportsForAdmin(adminId, options = {}) {
			const status = options.status || 'assigned';
			const limit = Math.max(1, Math.min(Number(options.limit) || 50, 100));
			const offset = Math.max(0, Number(options.offset) || 0);
			return [...this.moderationReports.values()]
				.filter((report) => Number(report.assignedAdminId) === Number(adminId))
				.filter((report) => !status || report.status === status)
				.sort((left, right) => new Date(right.assignedAt || right.createdAt) - new Date(left.assignedAt || left.createdAt))
				.slice(offset, offset + limit)
				.map((report) => this._copyModerationReport(report));
		}

		async getModerationAdminWorkloads(excludedAdminIds = []) {
			const excluded = new Set((excludedAdminIds || []).map(Number));
			return [...this.users.values()]
				.filter((user) => Boolean(user.admin) && !user.freeze && !excluded.has(Number(user.id)))
				.map((user) => ({
					adminId: Number(user.id),
					activeCount: [...this.moderationReports.values()].filter((report) => (
						report.status === 'assigned' && Number(report.assignedAdminId) === Number(user.id)
					)).length,
				}));
		}

		async assignModerationReport(reportId, assignment = {}) {
			const report = this.moderationReports.get(Number(reportId));
			if (!report || report.status === 'resolved') return null;
			if (
				assignment.expectedAdminId !== undefined &&
				Number(report.assignedAdminId) !== Number(assignment.expectedAdminId)
			) return null;
			report.status = 'assigned';
			report.assignedAdminId = Number(assignment.adminId);
			report.assignedAt = assignment.assignedAt
				? new Date(assignment.assignedAt)
				: new Date();
			report.excludedAdminIds = [...new Set((assignment.excludedAdminIds || report.excludedAdminIds || [])
				.map(Number)
				.filter(Number.isInteger))];
			return this._copyModerationReport(report);
		}

		async getOverdueModerationReports(cutoff) {
			const deadline = new Date(cutoff);
			return [...this.moderationReports.values()]
				.filter((report) => report.status === 'assigned' && report.assignedAt && new Date(report.assignedAt) <= deadline)
				.map((report) => this._copyModerationReport(report));
		}

		async getUnassignedModerationReports(limit = 100) {
			return [...this.moderationReports.values()]
				.filter((report) => report.status === 'pending')
				.sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt))
				.slice(0, Math.max(1, Math.min(Number(limit) || 100, 100)))
				.map((report) => this._copyModerationReport(report));
		}

		async resolveModerationReport(reportId, adminId, resolution) {
			const report = this.moderationReports.get(Number(reportId));
			if (
				!report || report.status !== 'assigned' ||
				Number(report.assignedAdminId) !== Number(adminId)
			) return null;
			report.status = 'resolved';
			report.resolution = JSON.parse(JSON.stringify(resolution || {}));
			report.resolvedAt = new Date();
			return this._copyModerationReport(report);
		}

		async deleteModerationReport(reportId) {
			return this.moderationReports.delete(Number(reportId));
		}

		async upsertPushSubscription(userId, subscription) {
		const normalizedUserId = Number(userId);
		if (!this.users.has(normalizedUserId)) return null;
		if (!this.pushSubscriptions.has(normalizedUserId)) {
			this.pushSubscriptions.set(normalizedUserId, new Map());
		}

		const now = new Date().toISOString();
		const subscriptions = this.pushSubscriptions.get(normalizedUserId);
		const existing = subscriptions.get(subscription.endpoint);
		const record = {
			user_id: normalizedUserId,
			endpoint: subscription.endpoint,
			expiration_time: subscription.expirationTime ?? null,
			p256dh: subscription.keys.p256dh,
			auth: subscription.keys.auth,
			session_token: subscription.sessionToken || existing?.session_token || null,
			created_at: existing?.created_at || now,
			updated_at: now,
		};
		subscriptions.set(record.endpoint, record);
		return { ...record };
	}

	async getPushSubscriptions(userId) {
		const subscriptions = this.pushSubscriptions.get(Number(userId));
		if (!subscriptions) return [];
		return [...subscriptions.values()].map((subscription) => ({
			endpoint: subscription.endpoint,
			expirationTime: subscription.expiration_time,
			keys: { p256dh: subscription.p256dh, auth: subscription.auth },
			sessionToken: subscription.session_token || null,
		}));
	}

	async deletePushSubscription(userId, endpoint) {
		const normalizedUserId = Number(userId);
		const subscriptions = this.pushSubscriptions.get(normalizedUserId);
		if (!subscriptions) return false;
		const deleted = subscriptions.delete(endpoint);
		if (subscriptions.size === 0) this.pushSubscriptions.delete(normalizedUserId);
		return deleted;
	}

	async searchPosts(query, limit = 20) {
		const result = await this.searchPostIds(query, limit, 0);
		return result.ids.map((id) => this.posts.get(id)).filter(Boolean);
	}

	async getTrendingPosts(limit = 20) {
		const normalizedLimit = Math.max(1, Number(limit) || 20);
		const candidates = [];
		let scanned = 0;
		const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;

		for (const postId of this.postIdsNewest) {
			scanned += 1;
			if (scanned > 500) break;
			const post = this.posts.get(postId);
			if (!post || post.groupId || post.group_id || post.replyTo != null) continue;
			if (post.createdAt && new Date(post.createdAt).getTime() < cutoff) continue;

			const score = (this.likeCountByPost.get(postId) || 0)
				+ (this.starCountByPost.get(postId) || 0) * 2
				+ (this.repostCountByPost.get(postId) || 0) * 3;
			candidates.push({ post, score });
		}

		candidates.sort((a, b) => b.score - a.score || b.post.id - a.post.id);
		return candidates.slice(0, normalizedLimit).map((item) => item.post);
	}

	async updateUserProfile(userId, profileData) {
		const user = this.users.get(userId);
		if (!user) return null;

		const allowed = [
			'name',
			'me',
			'bio',
			'header_image',
			'icon_data',
			'settings',
			'block',
			'verify',
			'freeze',
			'shadow',
			'lock',
			'admin',
		];
		for (const key of allowed) {
			if (profileData[key] !== undefined) {
				user[key] =
					key === 'block'
						? normalizeBlockList(profileData[key], userId)
						: profileData[key];
			}
		}

		return this._normalizeUserBlockList(user);
	}

		async getLikeIds(userId) {
			return [...(this.likedPostIdsByUser.get(Number(userId)) || [])];
		}

		async getStarIds(userId) {
			return [...(this.starredPostIdsByUser.get(Number(userId)) || [])];
		}

		async getFollowIds(userId) {
			return [...(this.followingIdsByUser.get(Number(userId)) || [])];
		}

	async getFollowRelationshipSnapshot(userId, candidateUserIds) {
		const normalizedUserId = Number(userId);
		const candidates = [...new Set((candidateUserIds || [])
			.map(Number)
			.filter((id) => Number.isInteger(id) && id !== normalizedUserId))];
		const followingIds = [];
		const followerIds = [];
		for (const candidateId of candidates) {
			if (this.follows.has(`${normalizedUserId}:${candidateId}`)) followingIds.push(candidateId);
			if (this.follows.has(`${candidateId}:${normalizedUserId}`)) followerIds.push(candidateId);
		}
		return { followingIds, followerIds };
	}

	async getPinnedPostId(userId) {
		for (const key of this.pinnedPosts.keys()) {
			const [uId, postId] = key.split(':').map(Number);
			if (uId === userId) return postId;
		}
		return null;
	}

		async getFollowingCount(userId) {
			return (this.followingIdsByUser.get(Number(userId)) || new Set()).size;
		}

		async getFollowerCount(userId) {
			return (this.followerIdsByUser.get(Number(userId)) || new Set()).size;
		}

		async getPostCount(userId) {
			return (this.postIdsByUser.get(Number(userId)) || []).length;
		}

	async getRanking(type, limit = 50) {
		const fieldByType = {
			followers: 'follower_count',
			posts: 'post_count',
			likes: 'like_count',
			stars: 'star_count',
		};
		const metricField = fieldByType[type];
		if (!metricField) throw new Error('Invalid ranking type');

		const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
		const reactionMap = new Map();
		if (type === 'likes' || type === 'stars') {
			const reactions = type === 'likes' ? this.likes : this.stars;
			for (const key of reactions.keys()) {
				const [, postId] = key.split(':').map(Number);
				const authorId = this.posts.get(postId)?.userId;
				if (authorId != null) {
					const normAuthor = Number(authorId);
					reactionMap.set(normAuthor, (reactionMap.get(normAuthor) || 0) + 1);
				}
			}
		}

		const rows = [];
		for (const user of this.users.values()) {
			const uid = Number(user.id);
			let value = 0;
			if (type === 'followers') value = (this.followerIdsByUser.get(uid) || new Set()).size;
			else if (type === 'posts') value = (this.postIdsByUser.get(uid) || []).length;
			else value = reactionMap.get(uid) || 0;

			rows.push({
				user_id: uid,
				name: user.name,
				scid: user.scid,
				icon_data: user.icon_data,
				[metricField]: value,
			});
		}

		return rows
			.sort((a, b) => b[metricField] - a[metricField] || a.user_id - b.user_id)
			.slice(0, safeLimit);
	}

	async getUserRanking(type, userId) {
		const fieldByType = {
			followers: 'follower_count',
			posts: 'post_count',
			likes: 'like_count',
			stars: 'star_count',
		};
		const metricField = fieldByType[type];
		if (!metricField) throw new Error('Invalid ranking type');

		const targetId = Number(userId);
		if (!this.users.has(targetId)) {
			return { rank: null, [metricField]: 0 };
		}

		const reactionMap = new Map();
		if (type === 'likes' || type === 'stars') {
			const reactions = type === 'likes' ? this.likes : this.stars;
			for (const key of reactions.keys()) {
				const [, postId] = key.split(':').map(Number);
				const authorId = this.posts.get(postId)?.userId;
				if (authorId != null) {
					const normAuthor = Number(authorId);
					reactionMap.set(normAuthor, (reactionMap.get(normAuthor) || 0) + 1);
				}
			}
		}

		let myValue = 0;
		if (type === 'followers') myValue = (this.followerIdsByUser.get(targetId) || new Set()).size;
		else if (type === 'posts') myValue = (this.postIdsByUser.get(targetId) || []).length;
		else myValue = reactionMap.get(targetId) || 0;

		let higherCount = 0;
		for (const user of this.users.values()) {
			const uid = Number(user.id);
			if (uid === targetId) continue;
			let userValue = 0;
			if (type === 'followers') userValue = (this.followerIdsByUser.get(uid) || new Set()).size;
			else if (type === 'posts') userValue = (this.postIdsByUser.get(uid) || []).length;
			else userValue = reactionMap.get(uid) || 0;

			if (userValue > myValue || (userValue === myValue && uid < targetId)) {
				higherCount += 1;
			}
		}

		return {
			rank: higherCount + 1,
			[metricField]: myValue,
		};
	}

	async getMediaCount(userId) {
		const postIds = this.postIdsByUser.get(Number(userId)) || [];
		let count = 0;
		for (const postId of postIds) {
			const post = this.posts.get(postId);
			if (Array.isArray(post?.attachments) && post.attachments.length > 0) count++;
		}
		return count;
	}

	
	async getMediaPosts(userId, limit = 15, offset = 0) {
		const userPosts = (this.postIdsByUser.get(Number(userId)) || [])
			.map((postId) => this.posts.get(postId))
			.filter(Boolean);

		const items = [];
		for (const post of userPosts) {
			if (!Array.isArray(post.attachments)) continue;
			for (const att of post.attachments) {
				items.push({
					post_id: post.id,
					file_id: att.id,
					file_type: att.type || 'file',
					type: att.type || 'file',
				});
			}
		}
		return items.slice(offset, offset + limit);
	}

	async getReplyCount(postId) {
		return this.replyCountByParent.get(Number(postId)) || 0;
	}

		async getReplyPostIds(parentPostId, limit = 50, offset = 0) {
				const normalizedLimit = Math.max(1, Number(limit) || 50);
				const normalizedOffset = Math.max(0, Number(offset) || 0);
				const replyIds = this.replyIdsByParent.get(Number(parentPostId)) || [];
				const window = replyIds.slice(normalizedOffset, normalizedOffset + normalizedLimit + 1);
				return { ids: window.slice(0, normalizedLimit), has_more: window.length > normalizedLimit };
			}

			async getThreadReplyPostIds(parentPostId, limit = 50, offset = 0) {
				const normalizedLimit = Math.max(1, Number(limit) || 50);
				const normalizedOffset = Math.max(0, Number(offset) || 0);
				const ids = [];
				const visited = new Set();
				const visit = (parentId) => {
					for (const childId of this.replyIdsByParent.get(Number(parentId)) || []) {
						const normalizedChildId = Number(childId);
						if (!Number.isInteger(normalizedChildId) || visited.has(normalizedChildId)) continue;
						visited.add(normalizedChildId);
						ids.push(normalizedChildId);
						visit(normalizedChildId);
					}
				};
				visit(parentPostId);
				const window = ids.slice(normalizedOffset, normalizedOffset + normalizedLimit + 1);
				return { ids: window.slice(0, normalizedLimit), has_more: window.length > normalizedLimit };
			}

		
			async getProfilePostIds({ userId, subType = 'all', limit = 30, offset = 0, beforeId = null } = {}) {
			const normalizedLimit = Math.max(1, Number(limit) || 30);
			const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
				? Number(beforeId)
				: null;
			const normalizedOffset = normalizedBeforeId == null ? Math.max(0, Number(offset) || 0) : 0;
			const sourceIds = this.postIdsByUser.get(Number(userId)) || [];
			const matched = sourceIds.filter((id) => {
				const post = this.posts.get(id);
				if (!post || post.groupId || post.group_id || (normalizedBeforeId != null && Number(id) >= normalizedBeforeId)) return false;
				return subType === 'all' || (subType === 'posts_only' ? post.replyTo == null : post.replyTo != null);
			});
			const window = matched.slice(normalizedOffset, normalizedOffset + normalizedLimit + 1);
			const ids = window.slice(0, normalizedLimit);
			return {
				ids,
				has_more: window.length > normalizedLimit,
				next_cursor: window.length > normalizedLimit && ids.length > 0 ? ids[ids.length - 1] : null,
			};
		}

		async getTimelinePostIds({ tab = 'foryou', followIds = [], viewerId = null, limit = 30, offset = 0, beforeId = null } = {}) {
			const normalizedLimit = Math.max(1, Number(limit) || 30);
			const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
				? Number(beforeId)
				: null;
			const normalizedOffset = normalizedBeforeId == null ? Math.max(0, Number(offset) || 0) : 0;
			const followSet = tab === 'following'
				? (viewerId != null && this.followingsByUser
					? new Set([...(this.followingsByUser.get(Number(viewerId)) || new Set()), Number(viewerId)])
					: new Set((followIds || []).map(Number)))
				: null;
			const matched = [];
			for (const id of this.postIdsNewest) {
				const post = this.posts.get(id);
				if (!post || post.groupId || post.group_id || post.replyTo != null || (normalizedBeforeId != null && Number(id) >= normalizedBeforeId)) continue;
				const matches = tab === 'following'
					? followSet.has(Number(post.userId))
					: tab === 'announce'
						? post.announcement === true
						: true;
				if (!matches) continue;
				matched.push(id);
				if (matched.length >= normalizedOffset + normalizedLimit + 1) break;
			}
			const window = matched.slice(normalizedOffset, normalizedOffset + normalizedLimit + 1);
			const ids = window.slice(0, normalizedLimit);
			return {
				ids,
				has_more: window.length > normalizedLimit,
				next_cursor: window.length > normalizedLimit && ids.length > 0 ? ids[ids.length - 1] : null,
			};
		}

		async getRecommendedPostIds({ viewerId = null, limit = 30, offset = 0, beforeId = null } = {}) {
			const normalizedLimit = Math.max(1, Number(limit) || 30);
			const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
				? Number(beforeId)
				: null;
			const normalizedOffset = normalizedBeforeId == null ? Math.max(0, Number(offset) || 0) : 0;
			const scoringBlockSize = Math.max(240, normalizedLimit * 8);
			const normalizedViewerId = Number.isInteger(Number(viewerId)) ? Number(viewerId) : null;
			const directFollowIds = normalizedViewerId == null
				? new Set()
				: new Set(this.followingIdsByUser.get(normalizedViewerId) || []);
			const secondDegreeFollowIds = new Set();
			for (const followedUserId of directFollowIds) {
				for (const candidateUserId of this.followingIdsByUser.get(followedUserId) || []) {
					if (candidateUserId !== normalizedViewerId && !directFollowIds.has(candidateUserId)) {
						secondDegreeFollowIds.add(candidateUserId);
					}
				}
			}

			const candidateSource = [];
			for (const id of this.postIdsNewest) {
				const post = this.posts.get(id);
				if (!post || post.groupId || post.group_id || post.replyTo != null || (normalizedBeforeId != null && Number(id) >= normalizedBeforeId)) continue;
				candidateSource.push(post);
				if (candidateSource.length >= normalizedOffset + scoringBlockSize + 1) break;
			}
			const blockWithSentinel = candidateSource.slice(
				normalizedOffset,
				normalizedOffset + scoringBlockSize + 1,
			);
			const candidates = blockWithSentinel.slice(0, scoringBlockSize);
			const keywordAffinities = normalizedViewerId == null
				? new Map()
				: (this.userKeywordAffinityByUser.get(normalizedViewerId) || new Map());

			const scored = scoreRecommendedPosts(candidates, {
				viewerId: normalizedViewerId,
				keywordProfile: keywordAffinities,
				directFollows: directFollowIds,
				limit: normalizedLimit,
			});

			return {
				ids: scored.map((s) => s.id),
				has_more: blockWithSentinel.length > scoringBlockSize,
				next_cursor: null,
				next_offset: normalizedOffset + Math.min(blockWithSentinel.length, scoringBlockSize),
				use_offset_pagination: true,
			};
		}

		async searchPostIds(query, limit = 30, offset = 0, beforeId = null) {
			if (!query || query.trim().length === 0) return { ids: [], has_more: false, next_cursor: null };
			const q = query.toLowerCase().trim();
			const normalizedLimit = Math.max(1, Number(limit) || 30);
			const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
				? Number(beforeId)
				: null;
			const normalizedOffset = normalizedBeforeId == null ? Math.max(0, Number(offset) || 0) : 0;
			const matched = [];
			for (const id of this.postIdsNewest) {
				const post = this.posts.get(id);
				if (!post || post.groupId || post.group_id || (normalizedBeforeId != null && Number(id) >= normalizedBeforeId)) continue;
				if (!(post.content || '').toLowerCase().includes(q)) continue;
				matched.push(id);
				if (matched.length >= normalizedOffset + normalizedLimit + 1) break;
			}
			const window = matched.slice(normalizedOffset, normalizedOffset + normalizedLimit + 1);
			const ids = window.slice(0, normalizedLimit);
			return {
				ids,
				has_more: window.length > normalizedLimit,
				next_cursor: window.length > normalizedLimit && ids.length > 0 ? ids[ids.length - 1] : null,
			};
		}

	async getTrendingHashtags(limit = 10, options = {}) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
		const hashtagCounts = new Map();
		const tagCounts = new Map();
		const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;

		for (const post of this.posts.values()) {
			if (post.groupId || post.group_id) continue;
			const createdAtTime = new Date(post.createdAt || post.created_at || 0).getTime();
			if (createdAtTime && createdAtTime < threeDaysAgo) continue;

			const content = post.content || '';
			const hashtagMatches = content.match(/(?:#|＃)([\p{L}\p{N}_-]{1,48})/gu) || [];
			const postHashtags = new Set(
				hashtagMatches
					.map((m) => m.replace(/^[#＃]/, '').toLowerCase())
					.filter((tag) => tag.length > 2)
			);

			for (const tag of postHashtags) {
				const fullTag = `#${tag}`;
				hashtagCounts.set(fullTag, (hashtagCounts.get(fullTag) || 0) + 1);
			}

			const rawTags = Array.isArray(post.tags) ? post.tags : [];
			const postTags = new Set(
				rawTags
					.map((rawTag) => String(rawTag || '').trim().toLowerCase().replace(/^[#＃]/, ''))
					.filter((tag) => tag.length > 2 && !postHashtags.has(tag))
			);

			for (const tag of postTags) {
				tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
			}
		}

		const mapToSortedList = (map) =>
			Array.from(map.entries())
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))
				.slice(0, normalizedLimit)
				.map(([tag_name, occurrence_count]) => ({
					tag_name,
					occurrence_count,
				}));

		const hashtagsList = mapToSortedList(hashtagCounts);
		const tagsList = mapToSortedList(tagCounts);

		const type = typeof options === 'string' ? options : options?.type;
		if (type === 'hashtags') return hashtagsList;
		if (type === 'tags') return tagsList;

		// 全体マージソート（互換用）
		const mergedCounts = new Map();
		for (const [k, v] of hashtagCounts) mergedCounts.set(k, v);
		for (const [k, v] of tagCounts) mergedCounts.set(k, v);
		const trendsList = mapToSortedList(mergedCounts);

		if (options?.summary || options?.detailed) {
			return {
				trends: trendsList,
				hashtags: hashtagsList,
				tags: tagsList,
			};
		}

		return trendsList;
	}

	
	async getUserStatus(userId) {
		const user = this.users.get(userId);
		if (!user) return null;
		return { shadow: !!user.shadow };
	}

	
	async setUserStatus(userId, status) {
		const user = this.users.get(userId);
		if (!user) return null;
		if (status.shadow !== undefined) user.shadow = !!status.shadow;
		return { shadow: !!user.shadow };
	}

	async beginAccountOperation(userId, operation) {
		if (!['reassigning', 'deleting'].includes(operation)) throw new Error('Invalid account operation');
		const user = this.users.get(Number(userId));
		if (!user || user.auth_provider === 'nyaitter' || user.account_operation) return null;
		user.account_operation = operation;
		return user;
	}

	async finishAccountOperation(userId, operation) {
		const user = this.users.get(Number(userId));
		if (!user || user.account_operation !== operation) return null;
		user.account_operation = null;
		return user;
	}

		async reassignUserId(userId) {
			const previousId = Number(userId);
			const user = this.users.get(previousId);
			if (!user || user.auth_provider === 'nyaitter' || user.account_operation !== 'reassigning') return null;

			const nextId = this._allocateUserId();
			if (!Number.isInteger(nextId) || nextId < 0 || nextId === previousId) {
				throw new Error('Could not allocate a unique Nyaitter ID');
			}

			this.users.delete(previousId);
			user.id = nextId;
			user.handle = formatNyaitterId(nextId);
			this.users.set(nextId, user);
			if (user.scid) this.scidToId.set(user.scid, nextId);
			if (user.nyaitter_address) this.nyaitterAddressToId.set(user.nyaitter_address, nextId);

			for (const session of this.sessions.values()) {
				if (Number(session.userId) === previousId) session.userId = nextId;
			}
			const updatedTrustedLoginIps = new Map();
			for (const record of this.trustedLoginIps.values()) {
				const updated = Number(record.userId) === previousId
					? { ...record, userId: nextId }
					: record;
				updatedTrustedLoginIps.set(`${updated.userId}:${updated.ipHash}`, updated);
			}
			this.trustedLoginIps = updatedTrustedLoginIps;
			for (const approval of this.loginApprovals.values()) {
				if (Number(approval.userId) === previousId) approval.userId = nextId;
			}
			for (const token of this.botTokens.values()) {
				if (Number(token.userId) === previousId) token.userId = nextId;
			}

			const postIds = [];
			for (const post of this.posts.values()) {
				if (Number(post.userId) === previousId) {
					post.userId = nextId;
					postIds.push(Number(post.id));
				}
			}
			this.postIdsByUser.delete(previousId);
			if (postIds.length > 0) {
				postIds.sort((left, right) => this.postIdsNewest.indexOf(left) - this.postIdsNewest.indexOf(right));
				this.postIdsByUser.set(nextId, postIds);
			}

			const rekeyUserPostMap = (map) => {
				for (const [key, value] of [...map.entries()]) {
					const [ownerId, postId] = String(key).split(':');
					if (Number(ownerId) !== previousId) continue;
					map.delete(key);
					map.set(`${nextId}:${postId}`, value);
				}
			};
			rekeyUserPostMap(this.likes);
			rekeyUserPostMap(this.stars);
			rekeyUserPostMap(this.reposts);
			rekeyUserPostMap(this.pinnedPosts);
			for (const index of [this.likedPostIdsByUser, this.starredPostIdsByUser]) {
				const values = index.get(previousId);
				if (values) {
					index.delete(previousId);
					index.set(nextId, values);
				}
			}

			for (const channel of this.dmChannels.values()) {
				channel.participants = (channel.participants || []).map((id) => Number(id) === previousId ? nextId : Number(id));
				channel.messages = (channel.messages || []).map((message) => {
					if (Number(message?.senderId) !== previousId && Number(message?.userid) !== previousId) return message;
					const updated = { ...message };
					if (Number(updated.senderId) === previousId) updated.senderId = nextId;
					if (Number(updated.userid) === previousId) updated.userid = nextId;
					return updated;
				});
			}
			for (const dm of this.groupDms.values()) {
				this._removeGroupDmMemberIndexes(dm);
				dm.host_id = Number(dm.host_id) === previousId ? nextId : Number(dm.host_id);
				dm.member = (dm.member || []).map((id) => Number(id) === previousId ? nextId : Number(id));
				dm.post = (dm.post || []).map((message) => (
					Number(message?.userid) === previousId ? { ...message, userid: nextId } : message
				));
				if (dm.unread && Object.prototype.hasOwnProperty.call(dm.unread, String(previousId))) {
					dm.unread[String(nextId)] = dm.unread[String(previousId)];
					delete dm.unread[String(previousId)];
				}
				this._addGroupDmMemberIndexes(dm);
			}
			for (const [key, createdAt] of [...this.follows]) {
				const [followerId, followingId] = String(key).split(':').map(Number);
				if (followerId !== previousId && followingId !== previousId) continue;
				this.follows.delete(key);
				this.follows.set(`${followerId === previousId ? nextId : followerId}:${followingId === previousId ? nextId : followingId}`, createdAt);
			}
			this.followingIdsByUser.clear();
			this.followerIdsByUser.clear();
			for (const key of this.follows.keys()) {
				const [followerId, followingId] = String(key).split(':').map(Number);
				this._updateFollowIndexes(followerId, followingId, true);
			}
			for (const candidate of this.users.values()) {
				candidate.block = normalizeBlockList((candidate.block || []).map((id) => (
					Number(id) === previousId ? nextId : id
				)), candidate.id);
			}

			const updatedNotifications = new Map();
			for (const [ownerId, notifications] of this.notifications.entries()) {
				for (const notification of notifications) {
					if (Number(notification.userId) === previousId) notification.userId = nextId;
					if (Number(notification.fromUserId) === previousId) notification.fromUserId = nextId;
					if (notification.target?.kind === 'user' && Number(notification.target.id) === previousId) {
						notification.target = { ...notification.target, id: nextId };
					}
				}
				updatedNotifications.set(Number(ownerId) === previousId ? nextId : Number(ownerId), notifications);
			}
			this.notifications = updatedNotifications;
			if (this.unreadNotificationCounts.has(previousId)) {
				const unread = this.unreadNotificationCounts.get(previousId);
				this.unreadNotificationCounts.delete(previousId);
				this.unreadNotificationCounts.set(nextId, unread);
			}
			if (this.dmE2EKeys.has(previousId)) {
				const key = this.dmE2EKeys.get(previousId);
				this.dmE2EKeys.delete(previousId);
				this.dmE2EKeys.set(nextId, key);
			}
			if (this.pushSubscriptions.has(previousId)) {
				const subscriptions = this.pushSubscriptions.get(previousId);
				this.pushSubscriptions.delete(previousId);
				this.pushSubscriptions.set(nextId, subscriptions);
			}
			for (const report of this.moderationReports.values()) {
				if (Number(report.reporterUserId) === previousId) report.reporterUserId = nextId;
				if (Number(report.assignedAdminId) === previousId) report.assignedAdminId = nextId;
				if (report.targetKind === 'user' && Number(report.targetId) === previousId) report.targetId = String(nextId);
				if (Number(report.targetSnapshot?.subjectUser?.id) === previousId) report.targetSnapshot.subjectUser.id = nextId;
				for (const member of report.targetSnapshot?.dm?.members || []) {
					if (Number(member?.id) === previousId) member.id = nextId;
				}
				report.excludedAdminIds = (report.excludedAdminIds || []).map((id) => Number(id) === previousId ? nextId : Number(id));
			}
			for (const log of this.logs) {
				if (Number(log.nyaitter_id) === previousId) log.nyaitter_id = nextId;
			}

			// imposter parent_id and members
			for (const candidate of this.users.values()) {
				if (candidate?.settings?.imposter && typeof candidate.settings.imposter === 'object') {
					if (Number(candidate.settings.imposter.parent_id) === previousId) {
						candidate.settings.imposter.parent_id = nextId;
					}
					if (Array.isArray(candidate.settings.imposter.members)) {
						candidate.settings.imposter.members = candidate.settings.imposter.members.map((m) => {
							if (Number(m?.user_id) === previousId) {
								return { ...m, user_id: nextId };
							}
							return m;
						});
					}
				}
			}

			return user;
		}

	async getAccountAttachmentKeys(userId) {
		const keys = new Set();
		for (const post of this.posts.values()) {
			if (Number(post.userId) !== Number(userId)) continue;
			for (const attachment of Array.isArray(post.attachments) ? post.attachments : []) {
				const key = attachment?.id || attachment?.key;
				if (typeof key === 'string' && key.startsWith('attachments/')) keys.add(key);
			}
		}
		return [...keys];
	}

	async rewriteAccountAttachmentKeys(userId, replacements) {
		const replacementMap = createAttachmentReplacementMap(replacements);
		if (replacementMap.size === 0) return 0;
		let updatedCount = 0;
		for (const post of this.posts.values()) {
			if (Number(post.userId) !== Number(userId)) continue;
			const { attachments, changed } = rewriteAttachmentReferences(post.attachments, replacementMap);
			if (!changed) continue;
			post.attachments = attachments;
			updatedCount += 1;
		}
		return updatedCount;
	}

	async deleteAccount(userId) {
		const normalizedUserId = Number(userId);
		const user = this.users.get(normalizedUserId);
		if (!user || user.account_operation !== 'deleting') return false;

		const ownedPostIds = new Set([...this.posts.values()]
			.filter((post) => Number(post.userId) === normalizedUserId)
			.map((post) => Number(post.id)));
		for (const post of this.posts.values()) {
			if (ownedPostIds.has(Number(post.id))) continue;
			if (ownedPostIds.has(Number(post.replyTo))) post.replyTo = null;
			if (ownedPostIds.has(Number(post.repostTo))) post.repostTo = null;
		}
		for (const postId of ownedPostIds) await this.adminDeletePost(postId);

		for (const [channelId, channel] of this.dmChannels.entries()) {
			const participants = (channel.participants || []).map(Number).filter((id) => id !== normalizedUserId);
			if (participants.length < 2) {
				this.dmChannels.delete(channelId);
				continue;
			}
			channel.participants = participants;
			channel.messages = (channel.messages || []).filter((message) => Number(message.senderId ?? message.userid) !== normalizedUserId);
		}
		for (const [dmId, dm] of this.groupDms.entries()) {
			if (!(dm.member || []).map(Number).includes(normalizedUserId)) continue;
			this._removeGroupDmMemberIndexes(dm);
			dm.member = dm.member.map(Number).filter((id) => id !== normalizedUserId);
			dm.post = (dm.post || []).filter((message) => Number(message?.userid) !== normalizedUserId);
			delete dm.unread?.[String(normalizedUserId)];
			if (dm.member.length === 0) this.groupDms.delete(dmId);
			else {
				if (Number(dm.host_id) === normalizedUserId) dm.host_id = dm.member[0];
				this._addGroupDmMemberIndexes(dm);
			}
		}

		for (const key of [...this.follows.keys()]) {
			if (key.split(':').map(Number).includes(normalizedUserId)) this.follows.delete(key);
		}
		this.followingIdsByUser.delete(normalizedUserId);
		this.followerIdsByUser.delete(normalizedUserId);
		for (const candidate of this.users.values()) {
			candidate.block = normalizeBlockList((candidate.block || []).filter((id) => Number(id) !== normalizedUserId), candidate.id);
		}
		for (const notifications of this.notifications.values()) {
			for (const notification of notifications) {
				if (Number(notification.fromUserId) === normalizedUserId) notification.fromUserId = null;
			}
		}
		this.notifications.delete(normalizedUserId);
		for (const [id, notification] of this.notificationsById.entries()) {
			if (Number(notification.userId) === normalizedUserId) this.notificationsById.delete(id);
		}
		this.unreadNotificationCounts.delete(normalizedUserId);
		this.sessions.forEach((session, token) => { if (Number(session.userId) === normalizedUserId) this.sessions.delete(token); });
		this.trustedLoginIps.forEach((record, key) => { if (Number(record.userId) === normalizedUserId) this.trustedLoginIps.delete(key); });
		this.loginApprovals.forEach((approval, id) => { if (Number(approval.userId) === normalizedUserId) this.loginApprovals.delete(id); });
		this.botTokens.forEach((token, id) => { if (Number(token.userId) === normalizedUserId) this.botTokens.delete(id); });
		this.pushSubscriptions.delete(normalizedUserId);
		this.dmE2EKeys.delete(normalizedUserId);
		this.likedPostIdsByUser.delete(normalizedUserId);
		this.starredPostIdsByUser.delete(normalizedUserId);
		for (const key of [...this.likes.keys()]) if (key.startsWith(`${normalizedUserId}:`)) this.likes.delete(key);
		for (const key of [...this.stars.keys()]) if (key.startsWith(`${normalizedUserId}:`)) this.stars.delete(key);
		for (const key of [...this.reposts.keys()]) if (key.startsWith(`${normalizedUserId}:`)) this.reposts.delete(key);
		for (const key of [...this.pinnedPosts.keys()]) if (key.startsWith(`${normalizedUserId}:`)) this.pinnedPosts.delete(key);
		this.moderationReports.forEach((report, id) => {
			if (Number(report.reporterUserId) === normalizedUserId) this.moderationReports.delete(id);
			else if (Number(report.assignedAdminId) === normalizedUserId) report.assignedAdminId = null;
		});
		this.logs = this.logs.filter((entry) => Number(entry.nyaitter_id) !== normalizedUserId);
		if (user.scid) this.scidToId.delete(user.scid);
		if (user.nyaitter_address) this.nyaitterAddressToId.delete(user.nyaitter_address);
		this.users.delete(normalizedUserId);
		return true;
	}

	async addLog(entry) {
		this.logs.push({
			scratch_id: entry.scratch_id || '',
			nyaitter_id: entry.nyaitter_id || null,
			masked_ip_uuid: entry.masked_ip_uuid || '',
			log_time: new Date(),
		});
	}

	async getLogs(limit = 20, offset = 0) {
		const sorted = this.logs
			.slice()
			.sort((a, b) => new Date(b.log_time) - new Date(a.log_time));
		return sorted.slice(offset, offset + limit);
	}
}

module.exports = InMemoryAdapter;
