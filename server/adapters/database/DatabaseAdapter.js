/**
 * @typedef {Object} QueryOptions
 * @property {number} [limit]
 * @property {number} [offset]
 * @property {string} [orderBy]
 * @property {'asc'|'desc'} [orderDirection]
 */

class DatabaseAdapter {
	
	async connect() {
		throw new Error('connect() must be implemented');
	}

	
	async disconnect() {
		throw new Error('disconnect() must be implemented');
	}

	async createSession(userId, meta = {}) { throw new Error('createSession() must be implemented'); }
	async getSessionByToken(token) { throw new Error('getSessionByToken() must be implemented'); }
	async invalidateSession(token) { throw new Error('invalidateSession() must be implemented'); }
	async getUserSessions(userId) { throw new Error('getUserSessions() must be implemented'); }
	async invalidateAllSessions(userId) { throw new Error('invalidateAllSessions() must be implemented'); }
	async invalidateSessionsByIp(userId, ipHash) { throw new Error('invalidateSessionsByIp() must be implemented'); }
	async trustLoginIp(userId, metadata) { throw new Error('trustLoginIp() must be implemented'); }
	async getTrustedLoginIp(userId, ipHash) { throw new Error('getTrustedLoginIp() must be implemented'); }
	async countTrustedLoginIps(userId) { throw new Error('countTrustedLoginIps() must be implemented'); }
	async revokeTrustedLoginIp(userId, ipHash) { throw new Error('revokeTrustedLoginIp() must be implemented'); }
	async createLoginApproval(approvalData) { throw new Error('createLoginApproval() must be implemented'); }
	async getLoginApproval(id) { throw new Error('getLoginApproval() must be implemented'); }
	async getLoginApprovalByPollToken(id, pollTokenHash) { throw new Error('getLoginApprovalByPollToken() must be implemented'); }
	async decideLoginApproval(userId, id, decision) { throw new Error('decideLoginApproval() must be implemented'); }
	async consumeLoginApproval(id, pollTokenHash) { throw new Error('consumeLoginApproval() must be implemented'); }

	/**
	 * SCIDでユーザーを取得
	 * @param {string} scid
	 * @returns {Promise<Object|null>}
	 */
	async getUserByScid(scid) {
		throw new Error('getUserByScid() must be implemented');
	}

	
	async getUserById(id) {
		throw new Error('getUserById() must be implemented');
	}

	async getUserByExternalId(authProvider, externalId) {
		throw new Error('getUserByExternalId() must be implemented');
	}

	async getUserAuthProviders(userId) {
		const targetId = Number(userId);
		const user = typeof this.getUserById === 'function' ? await this.getUserById(targetId) : null;
		if (!user) return [];
		const records = [];
		if (user.scid) {
			records.push({
				id: 0,
				userId: targetId,
				provider: 'scratch',
				providerUserId: user.scid,
				providerProfile: { username: user.scid },
				isPrimary: true,
				createdAt: user.created_at || user.createdAt || new Date(),
			});
		} else if (user.auth_provider && user.external_id) {
			records.push({
				id: 0,
				userId: targetId,
				provider: user.auth_provider,
				providerUserId: user.external_id,
				providerProfile: user.external_profile || {},
				isPrimary: true,
				createdAt: user.created_at || user.createdAt || new Date(),
			});
		}
		return records;
	}

	async findUserByAuthProvider(provider, providerUserId) {
		if (!provider || providerUserId == null) return null;
		const normProvider = String(provider).toLowerCase();
		const normUserId = String(providerUserId).trim();
		if (normProvider === 'scratch' || normProvider === 'local') {
			if (typeof this.getUserByScid === 'function') {
				const userByScid = await this.getUserByScid(normUserId);
				if (userByScid) return userByScid;
			}
		}
		if (typeof this.getUserByExternalId === 'function') {
			const userByExt = await this.getUserByExternalId(normProvider, normUserId);
			if (userByExt) return userByExt;
		}
		return null;
	}

	async linkAuthProvider(userId, provider, providerUserId, providerProfile = {}) {
		throw new Error('linkAuthProvider() must be implemented');
	}

	async unlinkAuthProvider(userId, provider, providerUserId = null) {
		throw new Error('unlinkAuthProvider() must be implemented');
	}

	
	async createUser(userData) {
		throw new Error('createUser() must be implemented');
	}

	
	async searchUsers(query, limit = 20, offset = 0) {
		throw new Error('searchUsers() must be implemented');
	}

	
	async getUsersByIds(userIds) {
		throw new Error('getUsersByIds() must be implemented');
	}

	async getPostAuthorsByIds(userIds) {
		return this.getUsersByIds(userIds);
	}

	
	async getAllUsers() {
		throw new Error('getAllUsers() must be implemented');
	}

	
	async getUserStatus(userId) {
		throw new Error('getUserStatus() must be implemented');
	}

	
	async setUserStatus(userId, status) {
		throw new Error('setUserStatus() must be implemented');
	}

	async beginAccountOperation(userId, operation) {
		throw new Error('beginAccountOperation() must be implemented');
	}
	async finishAccountOperation(userId, operation) {
		throw new Error('finishAccountOperation() must be implemented');
	}
	async reassignUserId(userId) {
		throw new Error('reassignUserId() must be implemented');
	}
	async deleteAccount(userId) {
		throw new Error('deleteAccount() must be implemented');
	}
	async deleteUser(userId) {
		return this.deleteAccount(userId);
	}
	async getAccountAttachmentKeys(userId) {
		throw new Error('getAccountAttachmentKeys() must be implemented');
	}
	async rewriteAccountAttachmentKeys(userId, replacements) {
		throw new Error('rewriteAccountAttachmentKeys() must be implemented');
	}

	// 全アダプター間のデータ移行に使う中立スナップショット。
	async exportDataSnapshot() {
		throw new Error('exportDataSnapshot() must be implemented');
	}
	async importDataSnapshot(snapshot, options = {}) {
		throw new Error('importDataSnapshot() must be implemented');
	}

	async createBotToken(userId, tokenId, tokenHash, name) { throw new Error('createBotToken() must be implemented'); }
	async getBotTokenById(tokenId) { throw new Error('getBotTokenById() must be implemented'); }
	async getUserBotTokens(userId) { throw new Error('getUserBotTokens() must be implemented'); }
	async revokeBotToken(userId, tokenId) { throw new Error('revokeBotToken() must be implemented'); }
	async updateBotTokenLastUsed(tokenId) { throw new Error('updateBotTokenLastUsed() must be implemented'); }

	// ==================== Authorized Apps (NyaitterAuth) ====================
	async createAuthorizedApp(userId, appId, appTokenHash, appName, appIconUrl, scopes, accessTokenId = null, accessTokenHash = null) { throw new Error('createAuthorizedApp() must be implemented'); }
	async getAuthorizedAppByUserAndAppToken(userId, appId, appTokenHash) { throw new Error('getAuthorizedAppByUserAndAppToken() must be implemented'); }
	async getAuthorizedAppByAccessTokenId(accessTokenId) { throw new Error('getAuthorizedAppByAccessTokenId() must be implemented'); }
	async getUserAuthorizedApps(userId) { throw new Error('getUserAuthorizedApps() must be implemented'); }
	async getAuthorizedAppById(id, userId) { throw new Error('getAuthorizedAppById() must be implemented'); }
	async updateAuthorizedAppScopes(id, userId, scopes, accessTokenId = null, accessTokenHash = null) { throw new Error('updateAuthorizedAppScopes() must be implemented'); }
	async updateAuthorizedAppLastUsed(id) { throw new Error('updateAuthorizedAppLastUsed() must be implemented'); }
	async deleteAuthorizedApp(id, userId) { throw new Error('deleteAuthorizedApp() must be implemented'); }


	// ==================== Groups ====================
	async createGroup(groupData) { throw new Error('createGroup() must be implemented'); }
	async getGroupById(groupId) { throw new Error('getGroupById() must be implemented'); }
	async updateGroup(groupId, fields) { throw new Error('updateGroup() must be implemented'); }
	async deleteGroup(groupId) { throw new Error('deleteGroup() must be implemented'); }
	async transferGroupOwnership(groupId, newOwnerId) { throw new Error('transferGroupOwnership() must be implemented'); }
	async getGroupsByVisibility(params = {}) { throw new Error('getGroupsByVisibility() must be implemented'); }
	async getUserGroups(userId, params = {}) { throw new Error('getUserGroups() must be implemented'); }
	async getUsersGroupBadgesBatch(userIds) { throw new Error('getUsersGroupBadgesBatch() must be implemented'); }
	async createGroupRole(roleData) { throw new Error('createGroupRole() must be implemented'); }
	async getGroupRoles(groupId) { throw new Error('getGroupRoles() must be implemented'); }
	async updateGroupRole(roleId, fields) { throw new Error('updateGroupRole() must be implemented'); }
	async deleteGroupRole(roleId) { throw new Error('deleteGroupRole() must be implemented'); }
	async getGroupMembership(groupId, userId) { throw new Error('getGroupMembership() must be implemented'); }
	async getGroupMemberships(groupId, params = {}) { throw new Error('getGroupMemberships() must be implemented'); }
	async createGroupMembership(membershipData) { throw new Error('createGroupMembership() must be implemented'); }
	async updateGroupMembership(groupId, userId, fields) { throw new Error('updateGroupMembership() must be implemented'); }
	async createGroupInvite(inviteData) { throw new Error('createGroupInvite() must be implemented'); }
	async getGroupInvite(inviteId) { throw new Error('getGroupInvite() must be implemented'); }
	async getGroupInvites(params = {}) { throw new Error('getGroupInvites() must be implemented'); }
	async updateGroupInvite(inviteId, fields) { throw new Error('updateGroupInvite() must be implemented'); }
	async createGroupJoinRequest(requestData) { throw new Error('createGroupJoinRequest() must be implemented'); }
	async getGroupJoinRequest(requestId) { throw new Error('getGroupJoinRequest() must be implemented'); }
	async getGroupJoinRequests(params = {}) { throw new Error('getGroupJoinRequests() must be implemented'); }
	async updateGroupJoinRequest(requestId, fields) { throw new Error('updateGroupJoinRequest() must be implemented'); }
	async getGroupPostIds(groupId, params = {}) { throw new Error('getGroupPostIds() must be implemented'); }
	async getGroupAnnouncementPostIds(groupId, params = {}) { throw new Error('getGroupAnnouncementPostIds() must be implemented'); }
	async searchGroupPostIds(userId, query, params = {}) { throw new Error('searchGroupPostIds() must be implemented'); }

	async createPost(postData) {
		throw new Error('createPost() must be implemented');
	}

	async enqueuePostEvent(eventType, payload, options = {}) {
		throw new Error('enqueuePostEvent() must be implemented');
	}
	async claimPostEvents(limit = 50, workerId = null) {
		throw new Error('claimPostEvents() must be implemented');
	}
	async completePostEvent(eventId) {
		throw new Error('completePostEvent() must be implemented');
	}
	async failPostEvent(eventId, error, retryAt = null) {
		throw new Error('failPostEvent() must be implemented');
	}

	
			async getPostById(postId) {
			throw new Error('getPostById() must be implemented');
		}

		
		async getPostsByIds(postIds) {
			throw new Error('getPostsByIds() must be implemented');
		}

		
		async getPostMetricsBatch(postIds, currentUserId = null) {
			throw new Error('getPostMetricsBatch() must be implemented');
		}

		
	async auditAndHealPostCounters(postId) {
		return null;
	}

	async auditAndHealUserCounters(userId) {
		return null;
	}

	async updatePost(postId, fields) {
		throw new Error('updatePost() must be implemented');
	}

	
	async getTimelinePosts(params) {
		throw new Error('getTimelinePosts() must be implemented');
	}

	
	async getRecentPosts(limit = 30) {
		throw new Error('getRecentPosts() must be implemented');
	}

	
	async getPostsByUserId(userId, limit = 50, currentUserId = null) {
		throw new Error('getPostsByUserId() must be implemented');
	}

	
	async getReplyPostIds(parentPostId, limit = 50, offset = 0) {
		throw new Error('getReplyPostIds() must be implemented');
	}

	async getThreadReplyPostIds(parentPostId, limit = 50, offset = 0) {
		throw new Error('getThreadReplyPostIds() must be implemented');
	}

	async getTimelinePostIds(params = {}) {
		throw new Error('getTimelinePostIds() must be implemented');
	}

	async getRecommendedPostIds(params = {}) {
		throw new Error('getRecommendedPostIds() must be implemented');
	}

	async getProfilePostIds(params = {}) {
		throw new Error('getProfilePostIds() must be implemented');
	}

	async searchPostIds(query, limit = 30, offset = 0) {
		throw new Error('searchPostIds() must be implemented');
	}

	async getPostCount(userId) {
		throw new Error('getPostCount() must be implemented');
	}

	async getMediaCount(userId) {
		throw new Error('getMediaCount() must be implemented');
	}

	async getMediaPosts(userId, limit = 15, offset = 0, type = null) {
		throw new Error('getMediaPosts() must be implemented');
	}

	async getReplyCount(postId) {
		throw new Error('getReplyCount() must be implemented');
	}

	
	async getPostDetail(id, currentUserId = null) {
		throw new Error('getPostDetail() must be implemented');
	}

	
	async toggleLike(userId, postId) {
		throw new Error('toggleLike() must be implemented');
	}

	
	async toggleStar(userId, postId) {
		throw new Error('toggleStar() must be implemented');
	}

	
	async getLikeCount(postId) {
		throw new Error('getLikeCount() must be implemented');
	}

	async hasUserLikedPost(userId, postId) {
		throw new Error('hasUserLikedPost() must be implemented');
	}

	async getLikeIds(userId) {
		throw new Error('getLikeIds() must be implemented');
	}

	async getStarCount(postId) {
		throw new Error('getStarCount() must be implemented');
	}

	async hasUserStarredPost(userId, postId) {
		throw new Error('hasUserStarredPost() must be implemented');
	}

	async getStarIds(userId) {
		throw new Error('getStarIds() must be implemented');
	}

	async getPinnedPostId(userId) {
		throw new Error('getPinnedPostId() must be implemented');
	}

	
	async hasUserLikedPost(userId, postId) {
		throw new Error('hasUserLikedPost() must be implemented');
	}

	
	async getStarCount(postId) {
		throw new Error('getStarCount() must be implemented');
	}

	
	async hasUserStarredPost(userId, postId) {
		throw new Error('hasUserStarredPost() must be implemented');
	}

	
	async getDmList(userId) {
		throw new Error('getDmList() must be implemented');
	}

	
	async getOrCreateDmChannel(userId1, userId2) {
		throw new Error('getOrCreateDmChannel() must be implemented');
	}

	
	async getDmMessages(channelId, limit = 50, offset = 0) {
		throw new Error('getDmMessages() must be implemented');
	}

	
	async sendDmMessage(channelId, senderId, content) {
		throw new Error('sendDmMessage() must be implemented');
	}

	
	async markDmMessagesAsRead(channelId, userId) {
		throw new Error('markDmMessagesAsRead() must be implemented');
	}

	
	async getUnreadDmCount(userId) {
		throw new Error('getUnreadDmCount() must be implemented');
	}

	
	async getGroupDmsForUser(userId) {
		throw new Error('getGroupDmsForUser() must be implemented');
	}

	
	async getGroupDm(dmId) {
		throw new Error('getGroupDm() must be implemented');
	}

	
	async createGroupDm(dmData) {
		throw new Error('createGroupDm() must be implemented');
	}

	
	async updateGroupDm(dmId, updates) {
		throw new Error('updateGroupDm() must be implemented');
	}

	
	async appendToGroupDm(dmId, message, senderId = null) {
		throw new Error('appendToGroupDm() must be implemented');
	}

	
	async markGroupDmRead(dmId, userId) {
		throw new Error('markGroupDmRead() must be implemented');
	}

	
	async getGroupDmUnreadCounts(userId) {
		throw new Error('getGroupDmUnreadCounts() must be implemented');
	}

	
	async getGroupDmUnreadTotal(userId) {
		throw new Error('getGroupDmUnreadTotal() must be implemented');
	}

	
	async deleteGroupDm(dmId) {
		throw new Error('deleteGroupDm() must be implemented');
	}

	
	async leaveGroupDm(dmId, userId) {
		throw new Error('leaveGroupDm() must be implemented');
	}

	
	async findGroupDmByMembers(memberIds) {
		throw new Error('findGroupDmByMembers() must be implemented');
	}

	
	async getDmPublicKeys(userIds) {
		throw new Error('getDmPublicKeys() must be implemented');
	}

	
	async setDmPublicKey(userId, publicKey) {
		throw new Error('setDmPublicKey() must be implemented');
	}

	
	async toggleFollow(followerId, followingId) {
		throw new Error('toggleFollow() must be implemented');
	}

	
	async isFollowing(followerId, followingId) {
		throw new Error('isFollowing() must be implemented');
	}

	
	async getFollowing(userId, limit = 100, offset = 0) {
		throw new Error('getFollowing() must be implemented');
	}

	
	async getFollowers(userId, limit = 100, offset = 0) {
		throw new Error('getFollowers() must be implemented');
	}

	
	async deletePost(postId, userId) {
		throw new Error('deletePost() must be implemented');
	}

	
	async togglePin(userId, postId) {
		throw new Error('togglePin() must be implemented');
	}

	
	async getPinnedPosts(userId) {
		throw new Error('getPinnedPosts() must be implemented');
	}

	
	async repostPost(userId, postId) {
		throw new Error('repostPost() must be implemented');
	}

	
	async getReposts(userId) {
		throw new Error('getReposts() must be implemented');
	}

	
	async getRepostsOfPost(postId, limit = 50) {
		throw new Error('getRepostsOfPost() must be implemented');
	}

	
	async getPinnedPosts(userId) {
		throw new Error('getPinnedPosts() must be implemented');
	}

	
	async createNotification(notificationData) {
		throw new Error('createNotification() must be implemented');
	}

	
	async getNotifications(userId, limit = 50, offset = 0) {
		throw new Error('getNotifications() must be implemented');
	}

	
	async markNotificationAsRead(notificationId) {
		throw new Error('markNotificationAsRead() must be implemented');
	}

	
	async markNotificationAsClicked(notificationId) {
		throw new Error('markNotificationAsClicked() must be implemented');
	}

	
	async getNotificationById(notificationId) {
		throw new Error('getNotificationById() must be implemented');
	}

	
	async deleteNotification(notificationId) {
		throw new Error('deleteNotification() must be implemented');
	}

	
	async markAllNotificationsAsRead(userId) {
		throw new Error('markAllNotificationsAsRead() must be implemented');
	}

	async markAllNotificationsAsClicked(userId) {
		throw new Error('markAllNotificationsAsClicked() must be implemented');
	}

	
	async getUnreadNotificationCount(userId) {
		throw new Error('getUnreadNotificationCount() must be implemented');
	}

	// モデレーション報告。reporterUserId は管理者向けの公開データへ含めないこと。
	async createModerationReport(reportData) { throw new Error('createModerationReport() must be implemented'); }
	async getOpenModerationAppealByUserId(userId) { throw new Error('getOpenModerationAppealByUserId() must be implemented'); }
	async getOpenModerationVerificationByUserId(userId) { throw new Error('getOpenModerationVerificationByUserId() must be implemented'); }
	async getModerationReportById(reportId) { throw new Error('getModerationReportById() must be implemented'); }
	async listModerationReportsForAdmin(adminId, options = {}) { throw new Error('listModerationReportsForAdmin() must be implemented'); }
	async getModerationAdminWorkloads(excludedAdminIds = []) { throw new Error('getModerationAdminWorkloads() must be implemented'); }
	async assignModerationReport(reportId, assignment) { throw new Error('assignModerationReport() must be implemented'); }
	async getOverdueModerationReports(cutoff) { throw new Error('getOverdueModerationReports() must be implemented'); }
	async getUnassignedModerationReports(limit = 100) { throw new Error('getUnassignedModerationReports() must be implemented'); }
	async resolveModerationReport(reportId, adminId, resolution) { throw new Error('resolveModerationReport() must be implemented'); }
	async deleteModerationReport(reportId) { throw new Error('deleteModerationReport() must be implemented'); }

	
	async upsertPushSubscription(userId, subscription) {
		throw new Error('upsertPushSubscription() must be implemented');
	}

	
	async getPushSubscriptions(userId) {
		throw new Error('getPushSubscriptions() must be implemented');
	}

	
	async deletePushSubscription(userId, endpoint) {
		throw new Error('deletePushSubscription() must be implemented');
	}

	
	async searchPosts(query, limit = 20) {
		throw new Error('searchPosts() must be implemented');
	}

	
	async updateUserProfile(userId, profileData) {
		throw new Error('updateUserProfile() must be implemented');
	}

	
	async getTrendingPosts(limit = 20) {
		throw new Error('getTrendingPosts() must be implemented');
	}

	
	async adminDeletePost(postId) {
		throw new Error('adminDeletePost() must be implemented');
	}

	async getFollowingCount(userId) {
		throw new Error('getFollowingCount() must be implemented');
	}

	async getFollowerCount(userId) {
		throw new Error('getFollowerCount() must be implemented');
	}

	async getFollowIds(userId) {
		throw new Error('getFollowIds() must be implemented');
	}

	async getFollowRelationshipSnapshot(userId, candidateUserIds) {
		throw new Error('getFollowRelationshipSnapshot() must be implemented');
	}

	async getRepostCount(postId) {
		throw new Error('getRepostCount() must be implemented');
	}

	async getRanking(type, limit = 50) {
		throw new Error('getRanking() must be implemented');
	}

	async getUserRanking(type, userId) {
		throw new Error('getUserRanking() must be implemented');
	}

	async getTrendingHashtags(limit = 10, options = {}) {
		throw new Error('getTrendingHashtags() must be implemented');
	}

	async addLog(entry) {
		throw new Error('addLog() must be implemented');
	}

	async getLogs(limit = 20, offset = 0) {
		throw new Error('getLogs() must be implemented');
	}

	async getUserPostSubscribers(authorUserId) {
		return [];
	}

	// ==================== Polls ====================

	async createPoll(pollData) {
		throw new Error('createPoll() must be implemented');
	}

	async getPollByPostId(postId, currentUserId = null) {
		throw new Error('getPollByPostId() must be implemented');
	}

	async getPollById(pollId, currentUserId = null) {
		throw new Error('getPollById() must be implemented');
	}

	async votePoll(params) {
		throw new Error('votePoll() must be implemented');
	}

	async getExpiredUnnotifiedPolls() {
		return [];
	}

	async markPollClosedNotified(pollId) {
		throw new Error('markPollClosedNotified() must be implemented');
	}

	async getPollVoters(pollId) {
		return [];
	}
}

module.exports = DatabaseAdapter;
