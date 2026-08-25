const DatabaseAdapter = require('../DatabaseAdapter');

const { normalizeBlockList } = require('../../../utils/blockList');
const { extractViewContent } = require('../../../utils/viewContent');

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

function boundedInteger(value, fallback, minimum, maximum) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function requireId(value, fieldName = 'id', minimum = 0) {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum) {
		throw new TypeError(`${fieldName} must be an integer greater than or equal to ${minimum}`);
	}
	return parsed;
}

function mapSession(session) {
	if (!session) return null;
	return {
		id: session.id || session.session_id,
		token: session.token,
		userId: session.userId ?? session.user_id,
		expiresAt: session.expiresAt || session.expires_at,
		createdAt: session.createdAt || session.created_at,
		ipHash: session.ipHash ?? session.ip_hash ?? null,
		ipMasked: session.ipMasked ?? session.ip_masked ?? '旧セッション',
		userAgent: session.userAgent ?? session.user_agent ?? '不明な端末',
	};
}

function mapLoginApproval(approval) {
	if (!approval) return null;
	return {
		id: approval.id,
		userId: approval.userId ?? approval.user_id,
		ipHash: approval.ipHash ?? approval.ip_hash,
		ipMasked: approval.ipMasked ?? approval.ip_masked,
		userAgent: approval.userAgent ?? approval.user_agent,
		pollTokenHash: approval.pollTokenHash ?? approval.poll_token_hash,
		status: approval.status,
		createdAt: approval.createdAt ?? approval.created_at,
		expiresAt: approval.expiresAt ?? approval.expires_at,
		decidedAt: approval.decidedAt ?? approval.decided_at,
		consumedAt: approval.consumedAt ?? approval.consumed_at,
	};
}

function normalizeUser(user) {
	if (!user) return null;
	return {
		...user,
		block: normalizeBlockList(user.block, user.id),
	};
}

function normalizePost(post) {
	if (!post) return post;
	post.userId = post.userId ?? post.user_id;
	post.replyTo = post.replyTo ?? post.reply_to ?? null;
	post.repostTo = post.repostTo ?? post.repost_to ?? null;
	post.createdAt = post.createdAt ?? post.created_at ?? null;
	post.viewContent = post.viewContent ?? post.view_content ?? extractViewContent(post.content || '');
	post.view_content = post.viewContent;
	post.tagsGeneratedAt = post.tagsGeneratedAt ?? post.tags_generated_at ?? null;
	post.tags_generated_at = post.tagsGeneratedAt;
	post.mask = !!post.mask;
	post.lock = !!post.lock;
	post.announcement = !!post.announcement;
	post.groupId = post.groupId ?? post.group_id ?? null;
	post.group_id = post.groupId;
	post.groupAnnouncement = !!(post.groupAnnouncement ?? post.group_announcement);
	post.group_announcement = post.groupAnnouncement;
	post.replyControl = post.replyControl ?? post.reply_control ?? 'everyone';
	post.reply_control = post.replyControl;
	if (post.tags && typeof post.tags === 'string') {
		try {
			post.tags = JSON.parse(post.tags);
		} catch (_) {}
	}
	if (!Array.isArray(post.tags)) post.tags = [];
	if (post.attachments && typeof post.attachments === 'string') {
		try {
			post.attachments = JSON.parse(post.attachments);
		} catch (_) {}
	}
	if (!Array.isArray(post.attachments)) {
		post.attachments = post.attachments ? [post.attachments] : [];
	}
	return post;
}

function normalizeGroup(group) {
	if (!group) return null;
	const ownerId = Number(group.ownerId ?? group.owner_id);
	const iconData = group.iconData ?? group.icon_data ?? null;
	const headerImage = group.headerImage ?? group.header_image ?? null;
	const createdAt = group.createdAt ?? group.created_at ?? null;
	const updatedAt = group.updatedAt ?? group.updated_at ?? null;
	const deletedAt = group.deletedAt ?? group.deleted_at ?? null;
	return {
		...group, id: String(group.id), ownerId, owner_id: ownerId, iconData, icon_data: iconData,
		headerImage, header_image: headerImage, memberCount: Number(group.memberCount ?? group.member_count) || 0,
		member_count: Number(group.memberCount ?? group.member_count) || 0, createdAt, created_at: createdAt,
		updatedAt, updated_at: updatedAt, deletedAt, deleted_at: deletedAt,
	};
}

function normalizeGroupRole(role) {
	if (!role) return null;
	let permissions = role.permissions;
	if (typeof permissions === 'string') { try { permissions = JSON.parse(permissions); } catch (_) { permissions = []; } }
	const groupId = String(role.groupId ?? role.group_id);
	const createdAt = role.createdAt ?? role.created_at ?? null;
	const updatedAt = role.updatedAt ?? role.updated_at ?? null;
	return { ...role, id: String(role.id), groupId, group_id: groupId, permissions: Array.isArray(permissions) ? permissions.map(String) : [],
		isSystem: Boolean(role.isSystem ?? role.is_system), is_system: Boolean(role.isSystem ?? role.is_system),
		sortOrder: Number(role.sortOrder ?? role.sort_order) || 0, sort_order: Number(role.sortOrder ?? role.sort_order) || 0,
		createdAt, created_at: createdAt, updatedAt, updated_at: updatedAt };
}

function normalizeGroupMembership(membership) {
	if (!membership) return null;
	const groupId = String(membership.groupId ?? membership.group_id);
	const userId = Number(membership.userId ?? membership.user_id);
	const roleId = membership.roleId ?? membership.role_id ?? null;
	const joinedAt = membership.joinedAt ?? membership.joined_at ?? null;
	const updatedAt = membership.updatedAt ?? membership.updated_at ?? null;
	return { ...membership, groupId, group_id: groupId, userId, user_id: userId, roleId, role_id: roleId,
		joinedAt, joined_at: joinedAt, updatedAt, updated_at: updatedAt };
}

function normalizeGroupInvite(invite) {
	if (!invite) return null;
	const groupId = String(invite.groupId ?? invite.group_id);
	const inviterId = Number(invite.inviterId ?? invite.inviter_id);
	const inviteeId = Number(invite.inviteeId ?? invite.invitee_id);
	const createdAt = invite.createdAt ?? invite.created_at ?? null;
	const respondedAt = invite.respondedAt ?? invite.responded_at ?? null;
	return { ...invite, id: String(invite.id), groupId, group_id: groupId, inviterId, inviter_id: inviterId, inviteeId, invitee_id: inviteeId,
		createdAt, created_at: createdAt, respondedAt, responded_at: respondedAt };
}

function normalizeGroupJoinRequest(request) {
	if (!request) return null;
	const groupId = String(request.groupId ?? request.group_id);
	const userId = Number(request.userId ?? request.user_id);
	const reviewedBy = request.reviewedBy ?? request.reviewed_by ?? null;
	const createdAt = request.createdAt ?? request.created_at ?? null;
	const reviewedAt = request.reviewedAt ?? request.reviewed_at ?? null;
	return { ...request, id: String(request.id), groupId, group_id: groupId, userId, user_id: userId,
		reviewedBy, reviewed_by: reviewedBy, createdAt, created_at: createdAt, reviewedAt, reviewed_at: reviewedAt };
}

function serializeGroupDm(row, userId = null) {
	if (!row) return null;
	const unread = row.unread || {};
	const memberList = Array.isArray(row.member) ? row.member.map(Number) : [];
	const accepted = Array.isArray(row.accepted)
		? row.accepted.map(Number)
		: (Array.isArray(unread?._accepted) ? unread._accepted.map(Number) : memberList);
	const res = {
		id: row.id,
		title: row.title || '',
		member: memberList,
		accepted,
		host_id: row.host_id ?? row.hostId,
		time: row.time instanceof Date ? row.time.toISOString() : (row.time || null),
		post: Array.isArray(row.post) ? row.post : [],
	};
	if (row.unread !== undefined) {
		res.unread = row.unread;
	}
	if (userId !== null && userId !== undefined) {
		res.unread_count = Number(unread[userId] ?? unread[String(userId)] ?? row.unread_count ?? 0);
	}
	return res;
}

function mapModerationReport(row) {
	if (!row) return null;
	const parseObject = (value, fallback) => {
		if (value && typeof value === 'object') return value;
		try { return JSON.parse(value || ''); } catch (_) { return fallback; }
	};
	const excluded = parseObject(row.excludedAdminIds ?? row.excluded_admin_ids, []);
	return {
		id: Number(row.id),
		reporterUserId: Number(row.reporterUserId ?? row.reporter_user_id),
		targetKind: row.targetKind ?? row.target_kind,
		targetId: String(row.targetId ?? row.target_id),
		description: row.description || '',
		targetSnapshot: parseObject(row.targetSnapshot ?? row.target_snapshot, {}),
		assignmentType: row.assignmentType ?? row.assignment_type ?? 'report',
		status: row.status,
		assignedAdminId: row.assignedAdminId ?? row.assigned_admin_id ?? null,
		assignedAt: row.assignedAt ?? row.assigned_at ?? null,
		excludedAdminIds: Array.isArray(excluded) ? excluded.map(Number).filter(Number.isInteger) : [],
		resolution: parseObject(row.resolution, null),
		createdAt: row.createdAt ?? row.created_at ?? null,
		resolvedAt: row.resolvedAt ?? row.resolved_at ?? null,
	};
}

class D1Adapter extends DatabaseAdapter {
	constructor(options = {}) {
		super();
		this.workerUrl = options.workerUrl || options.endpoint || process.env.D1_WORKER_URL || '';
		this.authToken = options.authToken || options.token || process.env.D1_WORKER_TOKEN || '';
		this.fetchImpl = options.fetch || globalThis.fetch;
		this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs ?? process.env.D1_REQUEST_TIMEOUT_MS, 10000, 100, 60000);
		this.retryAttempts = boundedInteger(options.retryAttempts ?? process.env.D1_RETRY_ATTEMPTS, 1, 0, 4);
		this.retryBaseDelayMs = boundedInteger(options.retryBaseDelayMs ?? process.env.D1_RETRY_BASE_DELAY_MS, 120, 0, 5000);
		this.readCacheSeconds = boundedInteger(options.readCacheSeconds ?? process.env.D1_READ_CACHE_SECONDS, 0, 0, 60);
		this.maxReadCacheEntries = boundedInteger(options.maxReadCacheEntries ?? process.env.D1_READ_CACHE_MAX_ENTRIES, 500, 1, 5000);
		this.batchMaxItems = boundedInteger(options.batchMaxItems ?? process.env.D1_BATCH_MAX_ITEMS, 100, 1, 500);
		this.readCache = new Map();
		this.inFlightReads = new Map();
	}

	async connect() {
		if (!this.workerUrl) {
			throw new Error('D1Adapter requires workerUrl (or D1_WORKER_URL env var)');
		}
		if (typeof this.fetchImpl !== 'function') {
			throw new Error('D1Adapter requires a Fetch-compatible implementation');
		}

		let endpoint;
		try {
			endpoint = new URL(this.workerUrl);
		} catch (_) {
			throw new Error('D1Adapter workerUrl must be an absolute URL');
		}
		if (!['https:', 'http:'].includes(endpoint.protocol)) {
			throw new Error('D1Adapter workerUrl must use HTTP(S)');
		}
		if (endpoint.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
			throw new Error('D1Adapter requires an HTTPS workerUrl in production');
		}
		endpoint.pathname = endpoint.pathname.replace(/\/+$/, '');
		this.workerUrl = endpoint.toString().replace(/\/+$/, '');
		console.log('[D1Adapter] Using D1 via Worker proxy:', endpoint.origin);
	}

	async disconnect() {
		this.readCache.clear();
		this.inFlightReads.clear();
	}

	async exportDataSnapshot() {
		const { createSnapshot } = require('../../../services/DataMigrationService');
		const snapshot = await this._read('/migration/snapshot', { cacheSeconds: 0 });
		return createSnapshot('d1', snapshot?.tables || {});
	}

	async importDataSnapshot(snapshot, { replace = false } = {}) {
		if (replace !== true) throw new Error('Destination replacement requires replace=true');
		const { normalizeSnapshot } = require('../../../services/DataMigrationService');
		const result = await this._write('/migration/snapshot/import', {
			replace: true,
			snapshot: normalizeSnapshot(snapshot),
		});
		return result?.counts || {};
	}

	_clearReadCache() {
		this.readCache.clear();
	}

	_pruneReadCache(now = Date.now()) {
		for (const [key, entry] of this.readCache) {
			if (!entry || entry.expiresAt <= now) this.readCache.delete(key);
		}
		while (this.readCache.size >= this.maxReadCacheEntries) {
			const oldestKey = this.readCache.keys().next().value;
			if (oldestKey === undefined) break;
			this.readCache.delete(oldestKey);
		}
	}

	_readCached(cacheKey) {
		const cached = this.readCache.get(cacheKey);
		if (!cached) return undefined;
		if (cached.expiresAt <= Date.now()) {
			this.readCache.delete(cacheKey);
			return undefined;
		}
		return cached.value;
	}

	_isRetryable(error) {
		if (error && RETRYABLE_STATUS_CODES.has(Number(error.status))) return true;
		return error?.name === 'AbortError' || error?.name === 'TimeoutError' || error instanceof TypeError;
	}

	async _sleep(milliseconds) {
		if (milliseconds <= 0) return;
		await new Promise((resolve) => setTimeout(resolve, milliseconds));
	}

	async _executeRequest(path, { method = 'GET', body = null, retry = false } = {}) {
		if (!this.workerUrl) throw new Error('D1Adapter is not connected');
		const bodyText = body == null ? undefined : JSON.stringify(body);
		const maximumAttempts = retry ? this.retryAttempts : 0;

		for (let attempt = 0; ; attempt += 1) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
			try {
				const response = await this.fetchImpl(`${this.workerUrl}${path}`, {
					method,
					headers: {
						...(bodyText ? { 'Content-Type': 'application/json' } : {}),
						...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
					},
					body: bodyText,
					signal: controller.signal,
				});
				if (!response || !response.ok) {
					const text = response ? (await response.text()).slice(0, 500) : '';
					const error = new Error(`D1 Worker error: ${response?.status || 0}${text ? ` ${text}` : ''}`);
					error.status = response?.status;
					throw error;
				}
				return await response.json();
			} catch (error) {
				if (!retry || attempt >= maximumAttempts || !this._isRetryable(error)) throw error;
				await this._sleep(this.retryBaseDelayMs * (2 ** attempt));
			} finally {
				clearTimeout(timeout);
			}
		}
	}

	async _request(path, {
		method = 'GET', body = null, cacheKey = null, cacheSeconds = 0, retry = false,
	} = {}) {
		const normalizedCacheKey = cacheKey || null;
		if (!normalizedCacheKey) {
			return this._executeRequest(path, { method, body, retry });
		}

		const cached = this._readCached(normalizedCacheKey);
		if (cached !== undefined) return cached;
		const existing = this.inFlightReads.get(normalizedCacheKey);
		if (existing) return existing;

		const request = this._executeRequest(path, { method, body, retry })
				.then((value) => {
					if (cacheSeconds > 0) {
						this._pruneReadCache();
						this.readCache.set(normalizedCacheKey, {
							value,
							expiresAt: Date.now() + cacheSeconds * 1000,
						});
					}
					return value;
				})
			.finally(() => this.inFlightReads.delete(normalizedCacheKey));
		this.inFlightReads.set(normalizedCacheKey, request);
		return request;
	}

	async _read(path, { body = null, cacheKey = null, cacheSeconds = this.readCacheSeconds } = {}) {
		return this._request(path, {
			method: body == null ? 'GET' : 'POST',
			body,
			cacheKey: cacheKey || `${path}:${body == null ? '' : JSON.stringify(body)}`,
			cacheSeconds,
			retry: true,
		});
	}

	async _write(path, body = null, method = 'POST') {
		const result = await this._request(path, {
			method,
			body,
			retry: false,
		});
		this._clearReadCache();
		return result;
	}

	_query(path, values = {}) {
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(values)) {
			if (value != null && value !== '') query.set(key, String(value));
		}
		const encoded = query.toString();
		return encoded ? `${path}?${encoded}` : path;
	}

	_normalizeIds(ids, { fieldName = 'id', minimum = 0 } = {}) {
		if (!Array.isArray(ids)) throw new TypeError('ids must be an array');
		return [...new Set(ids.map((id) => requireId(id, fieldName, minimum)))].slice(0, this.batchMaxItems);
	}

	_limit(value, fallback = 20, maximum = 100) {
		return boundedInteger(value, fallback, 1, maximum);
	}

	_offset(value) {
		return boundedInteger(value, 0, 0, 1000000);
	}

	async createSession(userId, meta = {}) {
		const session = await this._write('/sessions', {
			userId: requireId(userId, 'userId'),
			...meta,
		});
		return mapSession(session);
	}

	async getSessionByToken(token) {
		if (!token) return null;
		const session = await this._read(`/sessions/token/${encodeURIComponent(String(token))}`, { cacheSeconds: 0 });
		return mapSession(session);
	}

	async invalidateSession(token) {
		if (!token) return false;
		const result = await this._write('/sessions/invalidate', { token: String(token) });
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async getUserSessions(userId) {
		const sessions = await this._read(`/users/${requireId(userId, 'userId')}/sessions`, { cacheSeconds: 0 });
		return Array.isArray(sessions) ? sessions.map(mapSession) : [];
	}

	async invalidateAllSessions(userId) {
		const result = await this._write(`/users/${requireId(userId, 'userId')}/sessions/invalidate-all`);
		return Number(result?.count ?? result ?? 0);
	}

	async invalidateSessionsByIp(userId, ipHash) {
		const result = await this._write(`/users/${requireId(userId, 'userId')}/sessions/invalidate-ip`, {
			ipHash: String(ipHash),
		});
		return Number(result?.count ?? result ?? 0);
	}

	async trustLoginIp(userId, { ipHash, ipMasked }) {
		return this._write(`/users/${requireId(userId, 'userId')}/trusted-ips`, {
			ipHash: String(ipHash),
			ipMasked: ipMasked || '不明なIPアドレス',
		});
	}

	async getTrustedLoginIp(userId, ipHash) {
		return this._read(`/users/${requireId(userId, 'userId')}/trusted-ips/${encodeURIComponent(String(ipHash))}`, { cacheSeconds: 0 });
	}

	async countTrustedLoginIps(userId) {
		const result = await this._read(`/users/${requireId(userId, 'userId')}/trusted-ips/count`, { cacheSeconds: 0 });
		return Number(result?.count ?? result ?? 0);
	}

	async revokeTrustedLoginIp(userId, ipHash) {
		const result = await this._write(`/users/${requireId(userId, 'userId')}/trusted-ips/${encodeURIComponent(String(ipHash))}/revoke`);
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async createLoginApproval(approvalData) {
		const approval = await this._write('/login-approvals', approvalData);
		return mapLoginApproval(approval);
	}

	async getLoginApproval(id) {
		if (!id) return null;
		const approval = await this._read(`/login-approvals/${encodeURIComponent(String(id))}`, { cacheSeconds: 0 });
		return mapLoginApproval(approval);
	}

	async getLoginApprovalByPollToken(id, pollTokenHash) {
		if (!id || !pollTokenHash) return null;
		const approval = await this._write(`/login-approvals/${encodeURIComponent(String(id))}/poll`, {
			pollTokenHash: String(pollTokenHash),
		});
		return mapLoginApproval(approval);
	}

	async decideLoginApproval(userId, id, decision) {
		const approval = await this._write(`/login-approvals/${encodeURIComponent(String(id))}/decision`, {
			userId: requireId(userId, 'userId'),
			decision: String(decision),
		});
		return mapLoginApproval(approval);
	}

	async consumeLoginApproval(id, pollTokenHash) {
		const approval = await this._write(`/login-approvals/${encodeURIComponent(String(id))}/consume`, {
			pollTokenHash: String(pollTokenHash),
		});
		return mapLoginApproval(approval);
	}

	async createBotToken(userId, tokenId, tokenHash, name) {
		return this._write(`/users/${requireId(userId, 'userId')}/bot-tokens`, {
			tokenId: String(tokenId),
			tokenHash: String(tokenHash),
			name: String(name || ''),
		});
	}

	async getBotTokenById(tokenId) {
		if (!tokenId) return null;
		return this._read(`/bot-tokens/${encodeURIComponent(String(tokenId))}`, { cacheSeconds: 0 });
	}

	async getUserBotTokens(userId) {
		const tokens = await this._read(`/users/${requireId(userId, 'userId')}/bot-tokens`, { cacheSeconds: 0 });
		return Array.isArray(tokens) ? tokens : [];
	}

	async revokeBotToken(userId, tokenId) {
		const result = await this._write(`/users/${requireId(userId, 'userId')}/bot-tokens/${encodeURIComponent(String(tokenId))}/revoke`);
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async updateBotTokenLastUsed(tokenId) {
		await this._write(`/bot-tokens/${encodeURIComponent(String(tokenId))}/last-used`);
	}

	// ==================== Authorized Apps (NyaitterAuth) ====================

	async createAuthorizedApp(userId, appId, appTokenHash, appName, appIconUrl, scopes, accessTokenId = null, accessTokenHash = null) {
		return this._write(`/users/${requireId(userId, 'userId')}/authorized-apps`, {
			appId: String(appId),
			appTokenHash: String(appTokenHash),
			appName: String(appName),
			appIconUrl: appIconUrl ? String(appIconUrl) : null,
			scopes: Array.isArray(scopes) ? scopes : [],
			accessTokenId: accessTokenId ? String(accessTokenId) : null,
			accessTokenHash: accessTokenHash ? String(accessTokenHash) : null,
		});
	}

	async getAuthorizedAppByUserAndAppToken(userId, appId, appTokenHash) {
		return this._read(`/users/${requireId(userId, 'userId')}/authorized-apps/lookup?appId=${encodeURIComponent(String(appId))}&appTokenHash=${encodeURIComponent(String(appTokenHash))}`, { cacheSeconds: 0 });
	}

	async getAuthorizedAppByAccessTokenId(accessTokenId) {
		if (!accessTokenId) return null;
		return this._read(`/authorized-apps/by-token/${encodeURIComponent(String(accessTokenId))}`, { cacheSeconds: 0 });
	}

	async getUserAuthorizedApps(userId) {
		const apps = await this._read(`/users/${requireId(userId, 'userId')}/authorized-apps`, { cacheSeconds: 0 });
		return Array.isArray(apps) ? apps : [];
	}

	async getAuthorizedAppById(id, userId = null) {
		const query = userId !== null ? `?userId=${encodeURIComponent(String(userId))}` : '';
		return this._read(`/authorized-apps/${encodeURIComponent(String(id))}${query}`, { cacheSeconds: 0 });
	}

	async updateAuthorizedAppScopes(id, userId, scopes, accessTokenId = null, accessTokenHash = null) {
		return this._write(`/authorized-apps/${encodeURIComponent(String(id))}/scopes`, {
			userId: userId !== null ? Number(userId) : undefined,
			scopes: Array.isArray(scopes) ? scopes : [],
			accessTokenId: accessTokenId ? String(accessTokenId) : null,
			accessTokenHash: accessTokenHash ? String(accessTokenHash) : null,
		});
	}

	async updateAuthorizedAppLastUsed(id) {
		await this._write(`/authorized-apps/${encodeURIComponent(String(id))}/last-used`);
		return true;
	}

	async deleteAuthorizedApp(id, userId = null) {
		const query = userId !== null ? `?userId=${encodeURIComponent(String(userId))}` : '';
		const result = await this._write(`/authorized-apps/${encodeURIComponent(String(id))}/delete${query}`);
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async getUserByScid(scid) {
		return normalizeUser(await this._read(`/users/scid/${encodeURIComponent(String(scid))}`));
	}

	async getUserById(id) {
		const userId = requireId(id, 'id');
		return normalizeUser(await this._read(`/users/${userId}`));
	}

	async getUserByExternalId(authProvider, externalId) {
		return normalizeUser(await this._read(`/users/external/${encodeURIComponent(String(authProvider))}/${encodeURIComponent(String(externalId))}`));
	}

	async createUser(userData) {
		return normalizeUser(await this._write('/users', userData));
	}

	async searchUsers(query, limit = 20, offset = 0) {
		return this._read(this._query('/users/search', {
			q: String(query || ''),
			limit: this._limit(limit),
			offset: Math.max(Number(offset) || 0, 0),
		}));
	}

	async getUsersByIds(userIds) {
		const ids = this._normalizeIds(userIds);
		if (ids.length === 0) return [];
		const users = await this._read('/users/batch', { body: { ids } });
		return Array.isArray(users) ? users.map(normalizeUser).filter(Boolean) : [];
	}

	async getAllUsers() {
		const users = await this._read('/users', { cacheSeconds: 0 });
		return Array.isArray(users) ? users.map(normalizeUser).filter(Boolean) : [];
	}

	async getUserStatus(userId) {
		return this._read(`/users/${requireId(userId, 'userId')}/status`, { cacheSeconds: 0 });
	}

	async setUserStatus(userId, status) {
		return this._write(`/users/${requireId(userId, 'userId')}/status`, status);
	}

	async beginAccountOperation(userId, operation) {
		return normalizeUser(await this._write(
			`/users/${requireId(userId, 'userId')}/account-operation/begin`,
			{ operation },
		));
	}

	async finishAccountOperation(userId, operation) {
		return normalizeUser(await this._write(
			`/users/${requireId(userId, 'userId')}/account-operation/finish`,
			{ operation },
		));
	}

	async reassignUserId(userId) {
		return normalizeUser(await this._write(
			`/users/${requireId(userId, 'userId')}/nyaitter-id/reassign`,
		));
	}

	async getAccountAttachmentKeys(userId) {
		const keys = await this._read(`/users/${requireId(userId, 'userId')}/account/attachments`, { cacheSeconds: 0 });
		return Array.isArray(keys) ? keys.filter((key) => typeof key === 'string') : [];
	}

	async rewriteAccountAttachmentKeys(userId, replacements) {
		const result = await this._write(
			`/users/${requireId(userId, 'userId')}/account/attachments/rewrite`,
			{ replacements: Array.isArray(replacements) ? replacements : [] },
		);
		return Math.max(0, Number(result?.updatedCount) || 0);
	}

	async deleteAccount(userId) {
		const result = await this._write(`/users/${requireId(userId, 'userId')}/account/delete`);
		return result === true || Boolean(result?.success);
	}

	async updateUserProfile(userId, profileData) {
		return normalizeUser(await this._write(
			`/users/${requireId(userId, 'userId')}/profile`,
			profileData,
		));
	}

	async toggleFollow(followerId, followingId) {
		return this._write(`/users/${requireId(followingId, 'followingId')}/follow`, {
			followerId: requireId(followerId, 'followerId'),
		});
	}

	async isFollowing(followerId, followingId) {
		const result = await this._read(this._query(`/users/${requireId(followingId, 'followingId')}/is-following`, {
			followerId: requireId(followerId, 'followerId'),
		}), { cacheSeconds: 0 });
		return typeof result === 'boolean' ? result : !!result?.following;
	}

	async dislikePost(userId, postId) {
		const result = await this._write(`/posts/${requireId(postId, 'postId')}/dislike`, {
			userId: requireId(userId, 'userId'),
		});
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async getFollowing(userId, limit = 100) {
		const list = await this._read(this._query(`/users/${requireId(userId, 'userId')}/following`, {
			limit: this._limit(limit, 100, 500),
		}), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async getFollowers(userId, limit = 100) {
		const list = await this._read(this._query(`/users/${requireId(userId, 'userId')}/followers`, {
			limit: this._limit(limit, 100, 500),
		}), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async getFollowingCount(userId) {
		const res = await this._read(`/users/${requireId(userId, 'userId')}/following/count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async getFollowerCount(userId) {
		const res = await this._read(`/users/${requireId(userId, 'userId')}/followers/count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async getFollowIds(userId) {
		const ids = await this._read(`/users/${requireId(userId, 'userId')}/following/ids`, { cacheSeconds: 0 });
		return Array.isArray(ids) ? ids.map(Number) : [];
	}

	async getFollowRelationshipSnapshot(userId, candidateUserIds) {
		const normalizedUserId = requireId(userId, 'userId');
		const candidateIds = this._normalizeIds(candidateUserIds, { fieldName: 'candidateUserId' })
			.filter((id) => id !== normalizedUserId);
		if (candidateIds.length === 0) return { followingIds: [], followerIds: [] };
		const result = await this._read('/users/follow-relationships', {
			body: { userId: normalizedUserId, candidateIds },
			cacheSeconds: 0,
		});
		return {
			followingIds: Array.isArray(result?.following_ids ?? result?.followingIds)
				? (result.following_ids ?? result.followingIds).map(Number).filter(Number.isInteger)
				: [],
			followerIds: Array.isArray(result?.follower_ids ?? result?.followerIds)
				? (result.follower_ids ?? result.followerIds).map(Number).filter(Number.isInteger)
				: [],
		};
	}

	// ==================== Groups ====================

	_groupPath(groupId) {
		const id = String(groupId || '').trim();
		if (!id) throw new TypeError('groupId is required');
		return encodeURIComponent(id);
	}

	async createGroup(groupData) {
		return normalizeGroup(await this._write('/groups', groupData));
	}

	async getGroupById(groupId) {
		return normalizeGroup(await this._read(`/groups/${this._groupPath(groupId)}`, { cacheSeconds: 0 }));
	}

	async updateGroup(groupId, fields) {
		return normalizeGroup(await this._write(`/groups/${this._groupPath(groupId)}`, fields, 'PATCH'));
	}

	async deleteGroup(groupId) {
		return normalizeGroup(await this._write(`/groups/${this._groupPath(groupId)}`, undefined, 'DELETE'));
	}

	async transferGroupOwnership(groupId, newOwnerId) {
		return normalizeGroup(await this._write(
			`/groups/${this._groupPath(groupId)}/owner`,
			{ newOwnerId: requireId(newOwnerId, 'newOwnerId') },
			'PATCH',
		));
	}

	async getGroupsByVisibility({ query = '', visibility = ['open', 'open_invite'], limit = 20, offset = 0 } = {}) {
		const groups = await this._read(this._query('/groups', { query, visibility: Array.isArray(visibility) ? visibility.join(',') : visibility,
			limit: this._limit(limit, 20, 100), offset: Math.max(0, Number(offset) || 0) }), { cacheSeconds: 0 });
		return Array.isArray(groups) ? groups.map(normalizeGroup) : [];
	}

	async getUserGroups(userId, { status = 'active', limit = 100, offset = 0 } = {}) {
		const groups = await this._read(this._query(`/users/${requireId(userId, 'userId')}/groups`, {
			status, limit: this._limit(limit, 100, 200), offset: Math.max(0, Number(offset) || 0),
		}), { cacheSeconds: 0 });
		return Array.isArray(groups) ? groups.map((group) => ({ ...normalizeGroup(group), membership: normalizeGroupMembership(group.membership) })) : [];
	}

	async getUsersGroupBadgesBatch(userIds) {
		const result = new Map();
		const ids = [...new Set((userIds || []).map(Number).filter(Number.isInteger))];
		if (ids.length === 0) return result;
		ids.forEach((id) => result.set(id, []));

		try {
			const res = await this._write('/groups/user-badges-batch', { user_ids: ids });
			if (res && res.badges) {
				for (const [uid, badges] of Object.entries(res.badges)) {
					result.set(Number(uid), Array.isArray(badges) ? badges.slice(0, 3) : []);
				}
				return result;
			}
		} catch (_) {
			// Fallback to per-user retrieval below
		}

		await Promise.all(ids.map(async (userId) => {
			try {
				const groups = await this.getUserGroups(userId, { status: 'active', limit: 20 });
				const badges = (groups || [])
					.filter((g) => Boolean(g.icon_data || g.iconData) && (g.visibility === 'open' || g.visibility === 'open_invite'))
					.slice(0, 3)
					.map((g) => ({
						id: String(g.id),
						name: String(g.name || ''),
						icon_data: g.icon_data || g.iconData,
					}));
				result.set(userId, badges);
			} catch (_) {}
		}));

		return result;
	}

	async createGroupRole(roleData) {
		return normalizeGroupRole(await this._write(`/groups/${this._groupPath(roleData.groupId)}/roles`, roleData));
	}

	async getGroupRoles(groupId) {
		const roles = await this._read(`/groups/${this._groupPath(groupId)}/roles`, { cacheSeconds: 0 });
		return Array.isArray(roles) ? roles.map(normalizeGroupRole) : [];
	}

	async updateGroupRole(roleId, fields) {
		return normalizeGroupRole(await this._write(`/group-roles/${this._groupPath(roleId)}`, fields, 'PATCH'));
	}

	async deleteGroupRole(roleId) {
		return normalizeGroupRole(await this._write(`/group-roles/${this._groupPath(roleId)}`, undefined, 'DELETE'));
	}

	async getGroupMembership(groupId, userId) {
		return normalizeGroupMembership(await this._read(`/groups/${this._groupPath(groupId)}/members/${requireId(userId, 'userId')}`, { cacheSeconds: 0 }));
	}

	async getGroupMemberships(groupId, { status = null, limit = 100, offset = 0 } = {}) {
		const memberships = await this._read(this._query(`/groups/${this._groupPath(groupId)}/members`, {
			status: status || undefined, limit: this._limit(limit, 100, 200), offset: Math.max(0, Number(offset) || 0),
		}), { cacheSeconds: 0 });
		return Array.isArray(memberships) ? memberships.map(normalizeGroupMembership) : [];
	}

	async createGroupMembership(membershipData) {
		return normalizeGroupMembership(await this._write(`/groups/${this._groupPath(membershipData.groupId)}/members`, membershipData));
	}

	async updateGroupMembership(groupId, userId, fields) {
		return normalizeGroupMembership(await this._write(
			`/groups/${this._groupPath(groupId)}/members/${requireId(userId, 'userId')}`, fields, 'PATCH',
		));
	}

	async createGroupInvite(inviteData) {
		return normalizeGroupInvite(await this._write(`/groups/${this._groupPath(inviteData.groupId)}/invites`, inviteData));
	}

	async getGroupInvite(inviteId) {
		return normalizeGroupInvite(await this._read(`/group-invites/${this._groupPath(inviteId)}`, { cacheSeconds: 0 }));
	}

	async getGroupInvites({ groupId = null, inviteeId = null, status = null, limit = 100, offset = 0 } = {}) {
		const invites = await this._read(this._query('/group-invites', { groupId: groupId || undefined, inviteeId: inviteeId ?? undefined,
			status: status || undefined, limit: this._limit(limit, 100, 200), offset: Math.max(0, Number(offset) || 0) }), { cacheSeconds: 0 });
		return Array.isArray(invites) ? invites.map(normalizeGroupInvite) : [];
	}

	async updateGroupInvite(inviteId, fields) {
		return normalizeGroupInvite(await this._write(`/group-invites/${this._groupPath(inviteId)}`, fields, 'PATCH'));
	}

	async createGroupJoinRequest(requestData) {
		return normalizeGroupJoinRequest(await this._write(`/groups/${this._groupPath(requestData.groupId)}/join-requests`, requestData));
	}

	async getGroupJoinRequest(requestId) {
		return normalizeGroupJoinRequest(await this._read(`/group-join-requests/${this._groupPath(requestId)}`, { cacheSeconds: 0 }));
	}

	async getGroupJoinRequests({ groupId = null, userId = null, status = null, limit = 100, offset = 0 } = {}) {
		const requests = await this._read(this._query('/group-join-requests', { groupId: groupId || undefined, userId: userId ?? undefined,
			status: status || undefined, limit: this._limit(limit, 100, 200), offset: Math.max(0, Number(offset) || 0) }), { cacheSeconds: 0 });
		return Array.isArray(requests) ? requests.map(normalizeGroupJoinRequest) : [];
	}

	async updateGroupJoinRequest(requestId, fields) {
		return normalizeGroupJoinRequest(await this._write(`/group-join-requests/${this._groupPath(requestId)}`, fields, 'PATCH'));
	}

	async getGroupPostIds(groupId, { limit = 30, offset = 0, beforeId = null, authorId = null, subType = 'posts_only' } = {}) {
		return this._read(this._query(`/groups/${this._groupPath(groupId)}/posts`, {
			limit: this._limit(limit, 30, 100), offset: Math.max(0, Number(offset) || 0), beforeId: beforeId ?? undefined,
			authorId: authorId != null && authorId !== '' && Number.isInteger(Number(authorId)) && Number(authorId) >= 0
				? Number(authorId)
				: undefined,
			subType: subType === 'replies_only' ? 'replies_only' : 'posts_only',
		}), { cacheSeconds: 0 });
	}

	async getGroupAnnouncementPostIds(groupId, { limit = 30, offset = 0, beforeId = null } = {}) {
		return this._read(this._query(`/groups/${this._groupPath(groupId)}/announcements`, {
			limit: this._limit(limit, 30, 100), offset: Math.max(0, Number(offset) || 0), beforeId: beforeId ?? undefined,
		}), { cacheSeconds: 0 });
	}

	async searchGroupPostIds(userId, query, { limit = 30, offset = 0, beforeId = null } = {}) {
		return this._read(this._query('/group-posts/search', { userId: requireId(userId, 'userId'), query: String(query || ''),
			limit: this._limit(limit, 30, 100), offset: Math.max(0, Number(offset) || 0), beforeId: beforeId ?? undefined,
		}), { cacheSeconds: 0 });
	}

	async createPost(postData) {
		const post = await this._write('/posts', postData);
		return normalizePost(post);
	}

	async getPostById(id) {
		const postId = requireId(id, 'postId', 1);
		const post = await this._read(`/posts/${postId}`);
		return normalizePost(post);
	}

	async getPostsByIds(postIds) {
		const ids = this._normalizeIds(postIds, { fieldName: 'postId', minimum: 1 });
		if (ids.length === 0) return [];
		const posts = await this._read('/posts/batch', { body: { ids } });
		return Array.isArray(posts) ? posts.map(normalizePost) : [];
	}

	async getPostReferencesByIds(postIds, maxDepth = 2) {
		const ids = this._normalizeIds(postIds, { fieldName: 'postId', minimum: 1 });
		const normalizedMaxDepth = Math.min(4, Math.max(0, Number(maxDepth) || 0));
		if (ids.length === 0) return [];

		try {
			const res = await this._read('/posts/references/batch', {
				body: { ids, maxDepth: normalizedMaxDepth },
			});
			if (Array.isArray(res)) return res.map(normalizePost);
		} catch (_) {
			// Fallback: breadth-first resolution using getPostsByIds in bounded iterations
		}

		const postsById = new Map();
		let currentIds = ids;
		for (let depth = 0; depth <= normalizedMaxDepth && currentIds.length > 0; depth += 1) {
			const missingIds = currentIds.filter((id) => !postsById.has(id));
			if (missingIds.length === 0) break;
			const fetched = await this.getPostsByIds(missingIds);
			const nextIds = [];
			for (const post of fetched) {
				if (post && post.id) {
					const pid = Number(post.id);
					postsById.set(pid, post);
					if (post.replyTo != null && !postsById.has(Number(post.replyTo))) {
						nextIds.push(Number(post.replyTo));
					}
					if (post.repostTo != null && !postsById.has(Number(post.repostTo))) {
						nextIds.push(Number(post.repostTo));
					}
				}
			}
			currentIds = [...new Set(nextIds)];
		}
		return Array.from(postsById.values());
	}

	async getPostMetricsBatch(postIds, currentUserId = null) {
		const ids = this._normalizeIds(postIds, { fieldName: 'postId', minimum: 1 });
		if (ids.length === 0) return [];
		const body = {
			ids,
			currentUserId: currentUserId == null ? null : requireId(currentUserId, 'currentUserId'),
		};
		return this._read('/posts/metrics/batch', { body });
	}

	async updatePost(postId, fields) {
		const post = await this._write(`/posts/${requireId(postId, 'postId', 1)}`, fields);
		return normalizePost(post);
	}

	async deletePost(postId, userId) {
		const result = await this._write(`/posts/${requireId(postId, 'postId', 1)}/delete`, {
			userId: requireId(userId, 'userId'),
		});
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async adminDeletePost(postId) {
		const result = await this._write(`/posts/${requireId(postId, 'postId', 1)}/admin-delete`);
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async getRecentPosts(limit = 30) {
		const posts = await this._read(this._query('/posts/recent', { limit: this._limit(limit, 30) }));
		return Array.isArray(posts) ? posts.map(normalizePost) : [];
	}

	async getPostsByUserId(userId, limit = 50, currentUserId = null) {
		const posts = await this._read(this._query(`/users/${requireId(userId, 'userId')}/posts`, {
			limit: this._limit(limit, 50),
			currentUserId: currentUserId == null ? null : requireId(currentUserId, 'currentUserId'),
		}));
		return Array.isArray(posts) ? posts.map(normalizePost) : [];
	}

	async getTimelinePosts(params = {}) {
		const limit = this._limit(params.limit, 30);
		const posts = await this.getRecentPosts(limit);
		return { posts, hasMore: posts.length === limit };
	}

	async getTimelinePostIds({ tab = 'foryou', followIds = [], viewerId = null, limit = 30, offset = 0, beforeId = null } = {}) {
		let resolvedFollowIds = this._normalizeIds(followIds);
		if (tab === 'following' && resolvedFollowIds.length === 0 && viewerId != null) {
			const followingUsers = await this.getFollowing(viewerId, 1000);
			resolvedFollowIds = this._normalizeIds((followingUsers || []).map((u) => u.id));
		}
		const body = {
			tab: String(tab),
			followIds: resolvedFollowIds,
			limit: this._limit(limit, 30),
			offset: this._offset(offset),
			beforeId: beforeId == null ? null : requireId(beforeId, 'beforeId', 1),
		};
		return this._read('/posts/timeline/ids', { body, cacheSeconds: 0 });
	}

	async getRecommendedPostIds({ viewerId = null, limit = 30, offset = 0, beforeId = null } = {}) {
		return this._read(this._query('/posts/recommended/ids', {
			viewerId: viewerId == null ? null : requireId(viewerId, 'viewerId'),
			limit: this._limit(limit, 30),
			offset: this._offset(offset),
			beforeId: beforeId == null ? null : requireId(beforeId, 'beforeId', 1),
		}), { cacheSeconds: 0 });
	}

	async getProfilePostIds({ userId, subType = 'all', limit = 30, offset = 0, beforeId = null } = {}) {
		return this._read(this._query(`/users/${requireId(userId, 'userId')}/post-ids`, {
			subType: String(subType || 'all'),
			limit: this._limit(limit, 30),
			offset: this._offset(offset),
			beforeId: beforeId == null ? null : requireId(beforeId, 'beforeId', 1),
		}), { cacheSeconds: 0 });
	}

	async searchPostIds(query, limit = 30, offset = 0, beforeId = null) {
		return this._read(this._query('/posts/search/ids', {
			q: String(query || ''),
			limit: this._limit(limit, 30),
			offset: this._offset(offset),
			beforeId: beforeId == null ? null : requireId(beforeId, 'beforeId', 1),
		}), { cacheSeconds: 0 });
	}

	async searchPosts(query, limit = 20) {
		const posts = await this._read(this._query('/posts/search', { q: String(query || ''), limit: this._limit(limit) }), { cacheSeconds: 0 });
		return Array.isArray(posts) ? posts.map(normalizePost) : [];
	}

	async getReplyPostIds(parentPostId, limit = 50, offset = 0) {
		return this._read(this._query(`/posts/${requireId(parentPostId, 'parentPostId', 1)}/reply-ids`, {
			limit: this._limit(limit, 50), offset: this._offset(offset),
		}), { cacheSeconds: 0 });
	}

	async getThreadReplyPostIds(parentPostId, limit = 50, offset = 0) {
		return this._read(this._query(`/posts/${requireId(parentPostId, 'parentPostId', 1)}/thread-reply-ids`, {
			limit: this._limit(limit, 50), offset: this._offset(offset),
		}), { cacheSeconds: 0 });
	}

	async getPostDetail(id, currentUserId = null) {
		return this._read(this._query(`/posts/${requireId(id, 'postId', 1)}/detail`, {
			currentUserId: currentUserId == null ? null : requireId(currentUserId, 'currentUserId'),
		}));
	}

	async getTrendingPosts(limit = 20) {
		const posts = await this._read(this._query('/posts/trending', { limit: this._limit(limit) }), { cacheSeconds: 0 });
		return Array.isArray(posts) ? posts.map(normalizePost) : [];
	}

	async getTrendingHashtags(limit = 10, options = {}) {
		const type = typeof options === 'string' ? options : options?.type;
		const queryParams = { limit: this._limit(limit, 10, 50) };
		if (type) queryParams.type = type;
		if (options?.summary) queryParams.summary = 'true';
		const res = await this._read(this._query('/posts/trending-hashtags', queryParams), { cacheSeconds: 0 });
		if (res && typeof res === 'object' && !Array.isArray(res)) {
			return {
				trends: Array.isArray(res.trends) ? res.trends : [],
				hashtags: Array.isArray(res.hashtags) ? res.hashtags : [],
				tags: Array.isArray(res.tags) ? res.tags : [],
				words: Array.isArray(res.words) ? res.words : (Array.isArray(res.tags) ? res.tags : []),
			};
		}
		return Array.isArray(res) ? res : [];
	}

	async getPostCount(userId) {
		const res = await this._read(`/users/${requireId(userId, 'userId')}/posts/count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async getMediaCount(userId) {
		const res = await this._read(`/users/${requireId(userId, 'userId')}/media/count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async getMediaPosts(userId, limit = 15, offset = 0, type = null) {
		const query = { limit: this._limit(limit, 15, 100), offset: this._offset(offset) };
		if (type && (type === 'image' || type === 'video')) {
			query.type = type;
		}
		const list = await this._read(this._query(`/users/${requireId(userId, 'userId')}/media`, query), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async getReplyCount(postId) {
		const res = await this._read(`/posts/${requireId(postId, 'postId', 1)}/replies/count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async toggleLike(userId, postId) {
		return this._write(`/posts/${requireId(postId, 'postId', 1)}/like`, { userId: requireId(userId, 'userId') });
	}

	async getLikeCount(postId) {
		const res = await this._read(`/posts/${requireId(postId, 'postId', 1)}/likes/count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async hasUserLikedPost(userId, postId) {
		const res = await this._read(this._query(`/posts/${requireId(postId, 'postId', 1)}/likes/check`, {
			userId: requireId(userId, 'userId'),
		}), { cacheSeconds: 0 });
		return typeof res === 'boolean' ? res : !!res?.liked;
	}

	async getLikeIds(userId) {
		const list = await this._read(`/users/${requireId(userId, 'userId')}/likes/ids`, { cacheSeconds: 0 });
		return Array.isArray(list) ? list.map(Number) : [];
	}

	async toggleStar(userId, postId) {
		return this._write(`/posts/${requireId(postId, 'postId', 1)}/star`, { userId: requireId(userId, 'userId') });
	}

	async getStarCount(postId) {
		const res = await this._read(`/posts/${requireId(postId, 'postId', 1)}/stars/count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async hasUserStarredPost(userId, postId) {
		const res = await this._read(this._query(`/posts/${requireId(postId, 'postId', 1)}/stars/check`, {
			userId: requireId(userId, 'userId'),
		}), { cacheSeconds: 0 });
		return typeof res === 'boolean' ? res : !!res?.starred;
	}

	async getStarIds(userId) {
		const list = await this._read(`/users/${requireId(userId, 'userId')}/stars/ids`, { cacheSeconds: 0 });
		return Array.isArray(list) ? list.map(Number) : [];
	}

	async togglePin(userId, postId) {
		return this._write(`/posts/${requireId(postId, 'postId', 1)}/pin`, { userId: requireId(userId, 'userId') });
	}

	async getPinnedPosts(userId) {
		const posts = await this._read(`/users/${requireId(userId, 'userId')}/pinned`, { cacheSeconds: 0 });
		return Array.isArray(posts) ? posts.map(normalizePost) : [];
	}

	async getPinnedPostId(userId) {
		const res = await this._read(`/users/${requireId(userId, 'userId')}/pinned/id`, { cacheSeconds: 0 });
		if (res == null) return null;
		if (typeof res === 'number') return res;
		return res.postId != null ? Number(res.postId) : (res.id != null ? Number(res.id) : null);
	}

	async repostPost(userId, postId) {
		const post = await this._write(`/posts/${requireId(postId, 'postId', 1)}/repost`, { userId: requireId(userId, 'userId') });
		return normalizePost(post);
	}

	async getReposts(userId) {
		const posts = await this._read(`/users/${requireId(userId, 'userId')}/reposts`, { cacheSeconds: 0 });
		return Array.isArray(posts) ? posts.map(normalizePost) : [];
	}

	async getRepostsOfPost(postId, limit = 50) {
		const list = await this._read(this._query(`/posts/${requireId(postId, 'postId', 1)}/reposts`, {
			limit: this._limit(limit, 50),
		}), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async getRepostCount(postId) {
		const res = await this._read(`/posts/${requireId(postId, 'postId', 1)}/reposts/count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async getDmList(userId) {
		return this._read(this._query('/dm/list', { userId: requireId(userId, 'userId') }), { cacheSeconds: 0 });
	}

	async getOrCreateDmChannel(userId1, userId2) {
		return this._write('/dm/channel', {
			userId1: requireId(userId1, 'userId1'),
			userId2: requireId(userId2, 'userId2'),
		});
	}

	async getDmMessages(channelId, limit = 50, offset = 0) {
		return this._read(this._query(`/dm/messages/${encodeURIComponent(String(channelId))}`, {
			limit: this._limit(limit, 50), offset: this._offset(offset),
		}), { cacheSeconds: 0 });
	}

	async sendDmMessage(channelId, senderId, content, meta = {}) {
		return this._write('/dm/messages', {
			channelId: String(channelId),
			senderId: requireId(senderId, 'senderId'),
			content,
			...(meta || {}),
		});
	}

	async markDmMessagesAsRead(channelId, userId) {
		return this._write('/dm/read', { channelId: String(channelId), userId: requireId(userId, 'userId') });
	}

	async getUnreadDmCount(userId) {
		const res = await this._read(this._query('/dm/unread', { userId: requireId(userId, 'userId') }), { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async getGroupDmsForUser(userId) {
		const list = await this._read(`/users/${requireId(userId, 'userId')}/group-dms`, { cacheSeconds: 0 });
		return Array.isArray(list) ? list.map((item) => serializeGroupDm(item, userId)) : [];
	}

	async getGroupDm(dmId) {
		if (dmId == null || dmId === '') return null;
		const dm = await this._read(`/group-dms/${encodeURIComponent(String(dmId))}`, { cacheSeconds: 0 });
		return serializeGroupDm(dm);
	}

	async createGroupDm(dmData) {
		const dm = await this._write('/group-dms', {
			hostId: requireId(dmData.hostId, 'hostId'),
			member: this._normalizeIds(dmData.member || []),
			title: String(dmData.title || ''),
		});
		return serializeGroupDm(dm, dmData.hostId);
	}

	async updateGroupDm(dmId, updates) {
		const dm = await this._write(`/group-dms/${encodeURIComponent(String(dmId))}/update`, updates);
		return serializeGroupDm(dm, dm?.host_id ?? dm?.hostId);
	}

	async appendToGroupDm(dmId, message, senderId = null) {
		const dm = await this._write(`/group-dms/${encodeURIComponent(String(dmId))}/messages`, {
			message,
			senderId: senderId == null ? null : requireId(senderId, 'senderId'),
		});
		return serializeGroupDm(dm, senderId);
	}

	async markGroupDmRead(dmId, userId) {
		return this._write(`/group-dms/${encodeURIComponent(String(dmId))}/read`, {
			userId: requireId(userId, 'userId'),
		});
	}

	async getGroupDmUnreadCounts(userId) {
		const list = await this._read(`/users/${requireId(userId, 'userId')}/group-dms/unread-counts`, { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async getGroupDmUnreadTotal(userId) {
		const res = await this._read(`/users/${requireId(userId, 'userId')}/group-dms/unread-total`, { cacheSeconds: 0 });
		return Number(res?.total ?? res?.count ?? res ?? 0);
	}

	async deleteGroupDm(dmId) {
		const result = await this._write(`/group-dms/${encodeURIComponent(String(dmId))}/delete`);
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async leaveGroupDm(dmId, userId) {
		const result = await this._write(`/group-dms/${encodeURIComponent(String(dmId))}/leave`, {
			userId: requireId(userId, 'userId'),
		});
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async findGroupDmByMembers(memberIds) {
		const ids = this._normalizeIds(memberIds);
		if (ids.length === 0) return null;
		const dm = await this._write('/group-dms/find-by-members', { memberIds: ids });
		return serializeGroupDm(dm);
	}

	async getDmPublicKeys(userIds) {
		const ids = this._normalizeIds(userIds);
		if (ids.length === 0) return [];
		const list = await this._read(`/dm-e2e-keys?user_ids=${encodeURIComponent(ids.join(','))}`, { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async setDmPublicKey(userId, publicKey) {
		await this._write('/dm-e2e-keys', {
			userId: requireId(userId, 'userId'),
			publicKey: String(publicKey),
		});
	}

	async createNotification(notificationData) {
		return this._write('/notifications', notificationData);
	}

	async getNotifications(userId, limit = 50, offset = 0) {
		const list = await this._read(this._query(`/users/${requireId(userId, 'userId')}/notifications`, {
			limit: this._limit(limit, 50, 200), offset: this._offset(offset),
		}), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async markNotificationAsRead(notificationId) {
		return this._write(`/notifications/${requireId(notificationId, 'notificationId', 1)}/read`);
	}

	async markNotificationAsClicked(notificationId) {
		return this._write(`/notifications/${requireId(notificationId, 'notificationId', 1)}/click`);
	}

	async getNotificationById(notificationId) {
		return this._read(`/notifications/${requireId(notificationId, 'notificationId', 1)}`, { cacheSeconds: 0 });
	}

	async deleteNotification(notificationId) {
		const result = await this._write(`/notifications/${requireId(notificationId, 'notificationId', 1)}/delete`);
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async markAllNotificationsAsRead(userId) {
		return this._write(`/users/${requireId(userId, 'userId')}/notifications/read-all`);
	}

	async markAllNotificationsAsClicked(userId) {
		return this._write(`/users/${requireId(userId, 'userId')}/notifications/click-all`);
	}

	async getUnreadNotificationCount(userId) {
		const res = await this._read(`/users/${requireId(userId, 'userId')}/notifications/unread-count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async createModerationReport(reportData) {
		return mapModerationReport(await this._write('/moderation-reports', reportData));
	}

	async getOpenModerationAppealByUserId(userId) {
		return mapModerationReport(await this._read(
			`/users/${requireId(userId, 'userId')}/moderation-appeal/open`,
			{ cacheSeconds: 0 },
		));
	}

	async getOpenModerationVerificationByUserId(userId) {
		return mapModerationReport(await this._read(
			`/users/${requireId(userId, 'userId')}/moderation-verification/open`,
			{ cacheSeconds: 0 },
		));
	}

	async getModerationReportById(reportId) {
		return mapModerationReport(await this._read(
			`/moderation-reports/${requireId(reportId, 'reportId', 1)}`,
			{ cacheSeconds: 0 },
		));
	}

	async listModerationReportsForAdmin(adminId, options = {}) {
		const reports = await this._read(this._query(
			`/moderation-reports/admin/${requireId(adminId, 'adminId')}`,
			{
				status: options.status || 'assigned',
				limit: this._limit(options.limit, 50, 100),
				offset: this._offset(options.offset),
			},
		), { cacheSeconds: 0 });
		return Array.isArray(reports) ? reports.map(mapModerationReport).filter(Boolean) : [];
	}

	async getModerationAdminWorkloads(excludedAdminIds = []) {
		const excluded = this._normalizeIds(excludedAdminIds, { fieldName: 'excludedAdminId' });
		const result = await this._write('/moderation-reports/admin-workloads', { excludedAdminIds: excluded });
		return Array.isArray(result)
			? result.map((row) => ({
				adminId: Number(row.adminId ?? row.admin_id),
				activeCount: Number(row.activeCount ?? row.active_count ?? 0),
			})).filter((row) => Number.isInteger(row.adminId))
			: [];
	}

	async assignModerationReport(reportId, assignment = {}) {
		return mapModerationReport(await this._write(
			`/moderation-reports/${requireId(reportId, 'reportId', 1)}/assign`,
			assignment,
		));
	}

	async getOverdueModerationReports(cutoff) {
		const reports = await this._write('/moderation-reports/overdue', { cutoff });
		return Array.isArray(reports) ? reports.map(mapModerationReport).filter(Boolean) : [];
	}

	async getUnassignedModerationReports(limit = 100) {
		const reports = await this._write('/moderation-reports/unassigned', {
			limit: this._limit(limit, 100, 100),
		});
		return Array.isArray(reports) ? reports.map(mapModerationReport).filter(Boolean) : [];
	}

	async resolveModerationReport(reportId, adminId, resolution) {
		return mapModerationReport(await this._write(
			`/moderation-reports/${requireId(reportId, 'reportId', 1)}/resolve`,
			{ adminId: requireId(adminId, 'adminId'), resolution },
		));
	}

	async deleteModerationReport(reportId) {
		const result = await this._write(
			`/moderation-reports/${requireId(reportId, 'reportId', 1)}/delete`,
		);
		return typeof result === 'boolean' ? result : Boolean(result?.success);
	}

	async upsertPushSubscription(userId, subscription) {
		return this._write(`/users/${requireId(userId, 'userId')}/push-subscriptions`, subscription);
	}

	async getPushSubscriptions(userId) {
		const list = await this._read(`/users/${requireId(userId, 'userId')}/push-subscriptions`, { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async deletePushSubscription(userId, endpoint) {
		const result = await this._write(`/users/${requireId(userId, 'userId')}/push-subscriptions/delete`, {
			endpoint: String(endpoint),
		});
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async getRanking(type, limit = 50) {
		const list = await this._read(this._query(`/ranking/${encodeURIComponent(String(type))}`, {
			limit: this._limit(limit, 50, 100),
		}), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : (list?.data || []);
	}

	async getUserRanking(type, userId) {
		return this._read(`/users/${requireId(userId, 'userId')}/ranking/${encodeURIComponent(String(type))}`, { cacheSeconds: 0 });
	}

	async addLog(entry) {
		return this._write('/logs', entry);
	}

	async getLogs(limit = 20, offset = 0) {
		const list = await this._read(this._query('/logs', {
			limit: this._limit(limit, 20, 100), offset: this._offset(offset),
		}), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	// ==================== Polls ====================

	async createPoll(pollData) {
		const payload = { ...pollData };
		if (payload.id == null) {
			payload.id = Number(`${Date.now() % 1000000000}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`);
		}
		return this._write('/polls', payload);
	}

	async getPollByPostId(postId, currentUserId = null) {
		return this._read(this._query(`/posts/${requireId(postId, 'postId')}/poll`, {
			currentUserId: currentUserId == null ? null : requireId(currentUserId, 'currentUserId'),
		}), { cacheSeconds: 0 });
	}

	async getPollById(pollId, currentUserId = null) {
		return this._read(this._query(`/polls/${requireId(pollId, 'pollId')}`, {
			currentUserId: currentUserId == null ? null : requireId(currentUserId, 'currentUserId'),
		}), { cacheSeconds: 0 });
	}

	async getPollsByPostIds(postIds, currentUserId = null) {
		const res = await this._read(this._query('/polls/by-posts', {
			postIds: (postIds || []).map(Number).join(','),
			currentUserId: currentUserId == null ? null : requireId(currentUserId, 'currentUserId'),
		}), { cacheSeconds: 0 });
		const map = new Map();
		if (Array.isArray(res)) {
			for (const p of res) {
				if (p && p.post_id) map.set(Number(p.post_id), p);
			}
		}
		return map;
	}

	async votePoll({ pollId, userId, optionIds = [], otherText = null }) {
		const validOptionIds = (optionIds || []).map(Number);
		const votes = validOptionIds.map((optId) => ({
			id: Number(`${Date.now() % 1000000000}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`),
			optionId: optId,
		}));
		return this._write(`/polls/${requireId(pollId, 'pollId')}/vote`, {
			userId: requireId(userId, 'userId'),
			optionIds: validOptionIds,
			otherText,
			votes,
		});
	}

	async getExpiredUnnotifiedPolls() {
		const res = await this._read('/polls/expired-unnotified', { cacheSeconds: 0 });
		return Array.isArray(res) ? res : [];
	}

	async markPollClosedNotified(pollId) {
		return this._write(`/polls/${requireId(pollId, 'pollId')}/mark-notified`, {});
	}

	async getPollVoters(pollId) {
		const res = await this._read(`/polls/${requireId(pollId, 'pollId')}/voters`, { cacheSeconds: 0 });
		return Array.isArray(res) ? res : [];
	}

	// ==================== Post Activities ====================

	async getRepostsOfPost(postId, limit = 50) {
		const list = await this._read(this._query(`/posts/${requireId(postId, 'postId')}/reposts`, {
			limit: this._limit(limit, 50, 100),
		}), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async getLikesOfPost(postId, limit = 50) {
		const list = await this._read(this._query(`/posts/${requireId(postId, 'postId')}/likes`, {
			limit: this._limit(limit, 50, 100),
		}), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async getStarsOfPost(postId, limit = 50) {
		const list = await this._read(this._query(`/posts/${requireId(postId, 'postId')}/stars`, {
			limit: this._limit(limit, 50, 100),
		}), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async getQuotesOfPost(postId, limit = 50) {
		const list = await this._read(this._query(`/posts/${requireId(postId, 'postId')}/quotes`, {
			limit: this._limit(limit, 50, 100),
		}), { cacheSeconds: 0 });
		return Array.isArray(list) ? list.map(normalizePost) : [];
	}
}

module.exports = D1Adapter;
