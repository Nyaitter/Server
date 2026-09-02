'use strict';

const { Pool } = require('pg');
const crypto = require('crypto');
const DatabaseAdapter = require('../DatabaseAdapter');
const {
	formatNyaitterId,
} = require('../../../utils/nyaitterAddress');
const appConfig = require('../../../config');
const MemoryBoundedCache = require('../../../utils/MemoryBoundedCache');
const { normalizeTarget } = require('../../../utils/notification');
const { normalizeBlockList } = require('../../../utils/blockList');
const {
	createAttachmentReplacementMap,
	rewriteAttachmentReferences,
} = require('../../../utils/attachmentKeys');
const {
	exportPostgresSnapshot,
	importPostgresSnapshot,
} = require('../../../services/DataMigrationSql');
const { normalizeSnapshot } = require('../../../services/DataMigrationService');
const { scoreRecommendedPosts } = require('../../../utils/recommendation');
const { extractViewContent } = require('../../../utils/viewContent');
const { isFuzzyMatch, calculateStringSimilarity } = require('../../../utils/fuzzySearch');
const { encodePostCursor, decodePostCursor } = require('../../../utils/postCursor');


function parseJsonSafe(value, fallback = null) {
	if (value === null || value === undefined) return fallback;
	if (typeof value === 'object') return value;
	if (typeof value !== 'string') return fallback;
	try {
		return JSON.parse(value);
	} catch (_) {
		return fallback;
	}
}

function toIsoString(value, fallback = null) {
	if (value === null || value === undefined) return fallback;
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? fallback : value.toISOString();
	}
	if (typeof value === 'string') return value;
	return fallback;
}

function normalizeUserRow(row) {
	if (!row) return null;
	const id = Number(row.id);
	const rawBlock = parseJsonSafe(row.block, []);
	return {
		id,
		account_operation: row.account_operation || null,
		scid: row.scid || null,
		name: row.name || '',
		handle: row.handle || formatNyaitterId(id),
		nyaitter_address: row.nyaitter_address || null,
		auth_provider: row.auth_provider || 'local',
		provider_domain: row.provider_domain || null,
		external_id: row.external_id || null,
		external_profile: parseJsonSafe(row.external_profile, null),
		uuid: row.uuid || null,
		settings: parseJsonSafe(row.settings, {}),
		bio: row.bio || '',
		me: row.me ?? row.bio ?? '',
		header_image: row.header_image || null,
		icon_data: row.icon_data || null,
		verify: Boolean(row.verify),
		admin: Boolean(row.admin),
		freeze: row.freeze || null,
		shadow: Boolean(row.shadow),
		block: normalizeBlockList(rawBlock, id),
		created_at: toIsoString(row.created_at),
	};
}

function normalizePostTags(value) {
	const rawTags = parseJsonSafe(value, Array.isArray(value) ? value : []);
	if (!Array.isArray(rawTags)) return [];
	return [...new Set(rawTags
		.map((tag) => String(tag || '').trim().toLocaleLowerCase('ja-JP'))
		.filter((tag) => tag.length > 0 && tag.length <= 48))]
		.slice(0, 10);
}

function normalizePostRow(row) {
	if (!row) return null;
	const id = Number(row.id);
	const userId = Number(row.user_id ?? row.userId);
	const replyTo = row.reply_to ?? row.replyTo;
	const repostTo = row.repost_to ?? row.repostTo;
	const createdAt = toIsoString(row.created_at ?? row.createdAt);
	const tagsGeneratedAt = toIsoString(row.tags_generated_at ?? row.tagsGeneratedAt);
	const rawAttachments = parseJsonSafe(row.attachments, []);
	const attachments = Array.isArray(rawAttachments)
		? rawAttachments
		: (rawAttachments ? [rawAttachments] : []);
	const tags = normalizePostTags(row.tags);
	const groupId = row.group_id ?? row.groupId ?? null;
	const groupAnnouncement = Boolean(row.group_announcement ?? row.groupAnnouncement);
	const viewContent = row.view_content ?? row.viewContent ?? extractViewContent(row.content || '');
	const replyControl = row.reply_control ?? row.replyControl ?? 'everyone';

	let author = null;
	if (row.author_id != null) {
		author = normalizeUserRow({
			id: row.author_id,
			name: row.author_name,
			scid: row.author_scid,
			handle: row.author_handle,
			icon_data: row.author_icon_data,
			settings: row.author_settings,
			block: row.author_block,
			verify: row.author_verify,
			admin: row.author_admin,
			created_at: row.author_created_at,
		});
	} else if (row.author && typeof row.author === 'object') {
		author = normalizeUserRow(row.author);
	}

	return {
		id,
		userId,
		user_id: userId,
		content: row.content || '',
		viewContent,
		view_content: viewContent,
		tags,
		tagsGeneratedAt,
		tags_generated_at: tagsGeneratedAt,
		attachments,
		mask: Boolean(row.mask),
		lock: Boolean(row.lock),
		announcement: Boolean(row.announcement),
		groupId: groupId == null ? null : String(groupId),
		group_id: groupId == null ? null : String(groupId),
		groupAnnouncement,
		group_announcement: groupAnnouncement,
		replyControl,
		reply_control: replyControl,
		replyTo: replyTo == null ? null : Number(replyTo),
		reply_to: replyTo == null ? null : Number(replyTo),
		repostTo: repostTo == null ? null : Number(repostTo),
		repost_to: repostTo == null ? null : Number(repostTo),
		like_count: Math.max(0, Number(row.like_count ?? row.likeCount) || 0),
		likeCount: Math.max(0, Number(row.like_count ?? row.likeCount) || 0),
		star_count: Math.max(0, Number(row.star_count ?? row.starCount) || 0),
		starCount: Math.max(0, Number(row.star_count ?? row.starCount) || 0),
		repost_count: Math.max(0, Number(row.repost_count ?? row.repostCount) || 0),
		repostCount: Math.max(0, Number(row.repost_count ?? row.repostCount) || 0),
		reply_count: Math.max(0, Number(row.reply_count ?? row.replyCount) || 0),
		replyCount: Math.max(0, Number(row.reply_count ?? row.replyCount) || 0),
		...(row.liked_by_me !== undefined ? { liked_by_me: Boolean(row.liked_by_me) } : {}),
		...(row.starred_by_me !== undefined ? { starred_by_me: Boolean(row.starred_by_me) } : {}),
		...(author ? { author } : {}),
		createdAt,
		created_at: createdAt,
	};
}

function normalizeGroupRow(row) {
	if (!row) return null;
	const id = String(row.id);
	const ownerId = Number(row.owner_id ?? row.ownerId);
	const createdAt = toIsoString(row.created_at ?? row.createdAt);
	const updatedAt = toIsoString(row.updated_at ?? row.updatedAt);
	const deletedAt = toIsoString(row.deleted_at ?? row.deletedAt);
	return {
		id,
		ownerId,
		owner_id: ownerId,
		name: row.name || '',
		description: row.description || '',
		iconData: row.icon_data ?? row.iconData ?? null,
		icon_data: row.icon_data ?? row.iconData ?? null,
		headerImage: row.header_image ?? row.headerImage ?? null,
		header_image: row.header_image ?? row.headerImage ?? null,
		visibility: row.visibility || 'open',
		memberCount: Math.max(0, Number(row.member_count ?? row.memberCount) || 0),
		member_count: Math.max(0, Number(row.member_count ?? row.memberCount) || 0),
		createdAt,
		created_at: createdAt,
		updatedAt,
		updated_at: updatedAt,
		deletedAt,
		deleted_at: deletedAt,
	};
}

function normalizeGroupRoleRow(row) {
	if (!row) return null;
	const groupId = String(row.group_id ?? row.groupId);
	const permissions = parseJsonSafe(row.permissions, []);
	const createdAt = toIsoString(row.created_at ?? row.createdAt);
	const updatedAt = toIsoString(row.updated_at ?? row.updatedAt);
	return {
		id: String(row.id),
		groupId,
		group_id: groupId,
		name: row.name || '',
		permissions: Array.isArray(permissions) ? permissions.map(String) : [],
		isSystem: Boolean(row.is_system ?? row.isSystem),
		is_system: Boolean(row.is_system ?? row.isSystem),
		sortOrder: Number(row.sort_order ?? row.sortOrder) || 0,
		sort_order: Number(row.sort_order ?? row.sortOrder) || 0,
		createdAt,
		created_at: createdAt,
		updatedAt,
		updated_at: updatedAt,
	};
}

function normalizeGroupMembershipRow(row) {
	if (!row) return null;
	const groupId = String(row.group_id ?? row.groupId);
	const userId = Number(row.user_id ?? row.userId);
	const roleId = row.role_id ?? row.roleId ?? null;
	const joinedAt = toIsoString(row.joined_at ?? row.joinedAt);
	const updatedAt = toIsoString(row.updated_at ?? row.updatedAt);
	return {
		groupId,
		group_id: groupId,
		userId,
		user_id: userId,
		roleId: roleId == null ? null : String(roleId),
		role_id: roleId == null ? null : String(roleId),
		status: row.status || 'active',
		joinedAt,
		joined_at: joinedAt,
		updatedAt,
		updated_at: updatedAt,
	};
}

function normalizeGroupInviteRow(row) {
	if (!row) return null;
	const groupId = String(row.group_id ?? row.groupId);
	const inviterId = Number(row.inviter_id ?? row.inviterId);
	const inviteeId = Number(row.invitee_id ?? row.inviteeId);
	const createdAt = toIsoString(row.created_at ?? row.createdAt);
	const respondedAt = toIsoString(row.responded_at ?? row.respondedAt);
	return {
		id: String(row.id), groupId, group_id: groupId, inviterId, inviter_id: inviterId,
		inviteeId, invitee_id: inviteeId, status: row.status || 'pending',
		createdAt, created_at: createdAt, respondedAt, responded_at: respondedAt,
	};
}

function normalizeGroupJoinRequestRow(row) {
	if (!row) return null;
	const groupId = String(row.group_id ?? row.groupId);
	const userId = Number(row.user_id ?? row.userId);
	const reviewedBy = row.reviewed_by ?? row.reviewedBy ?? null;
	const createdAt = toIsoString(row.created_at ?? row.createdAt);
	const reviewedAt = toIsoString(row.reviewed_at ?? row.reviewedAt);
	return {
		id: String(row.id), groupId, group_id: groupId, userId, user_id: userId,
		status: row.status || 'pending',
		reviewedBy: reviewedBy == null ? null : Number(reviewedBy),
		reviewed_by: reviewedBy == null ? null : Number(reviewedBy),
		createdAt, created_at: createdAt, reviewedAt, reviewed_at: reviewedAt,
	};
}

function normalizeGroupDmRow(row, viewerId = null) {
	if (!row) return null;
	const member = parseJsonSafe(row.member, []);
	const unread = parseJsonSafe(row.unread, {});
	const post = parseJsonSafe(row.post, []);
	const time = toIsoString(row.time);
	const createdAt = toIsoString(row.created_at);
	const memberList = Array.isArray(member) ? member.map(Number).filter(Number.isInteger) : [];
	const accepted = Array.isArray(unread?._accepted)
		? unread._accepted.map(Number).filter(Number.isInteger)
		: memberList;

	const res = {
		id: String(row.id),
		host_id: Number(row.host_id ?? row.hostId),
		title: row.title || '',
		member: memberList,
		accepted,
		unread: typeof unread === 'object' && unread !== null ? unread : {},
		post: Array.isArray(post) ? post : [],
		time,
		created_at: createdAt,
	};
	if (viewerId != null) {
		res.unread_count = Number(res.unread[viewerId] ?? res.unread[String(viewerId)] ?? 0);
	}
	return res;
}

function normalizeModerationReportRow(row) {
	if (!row) return null;
	const excluded = parseJsonSafe(row.excluded_admin_ids ?? row.excludedAdminIds, []);
	const assignedAdminId = row.assigned_admin_id ?? row.assignedAdminId;
	return {
		id: Number(row.id),
		reporterUserId: Number(row.reporter_user_id ?? row.reporterUserId),
		targetKind: String(row.target_kind ?? row.targetKind),
		targetId: String(row.target_id ?? row.targetId),
		description: row.description || '',
		targetSnapshot: parseJsonSafe(row.target_snapshot ?? row.targetSnapshot, {}),
		assignmentType: String(row.assignment_type ?? row.assignmentType ?? 'report'),
		status: String(row.status || 'pending'),
		assignedAdminId: assignedAdminId == null ? null : Number(assignedAdminId),
		assignedAt: toIsoString(row.assigned_at ?? row.assignedAt),
		excludedAdminIds: Array.isArray(excluded) ? excluded.map(Number).filter(Number.isInteger) : [],
		resolution: parseJsonSafe(row.resolution, null),
		createdAt: toIsoString(row.created_at ?? row.createdAt),
		resolvedAt: toIsoString(row.resolved_at ?? row.resolvedAt),
	};
}

function mapSession(session) {
	if (!session) return null;
	const id = String(session.session_id || session.id);
	const userId = Number(session.user_id ?? session.userId);
	const expiresAt = toIsoString(session.expires_at || session.expiresAt);
	const createdAt = toIsoString(session.created_at || session.createdAt);
	const ipHash = session.ip_hash ?? session.ipHash ?? null;
	const ipMasked = session.ip_masked ?? session.ipMasked ?? '旧セッション';
	const userAgent = session.user_agent ?? session.userAgent ?? '不明な端末';

	return {
		id,
		session_id: id,
		token: session.token,
		userId,
		user_id: userId,
		expiresAt,
		expires_at: expiresAt,
		createdAt,
		created_at: createdAt,
		ipHash,
		ip_hash: ipHash,
		ipMasked,
		ip_masked: ipMasked,
		userAgent,
		user_agent: userAgent,
	};
}

function mapLoginApproval(approval) {
	if (!approval) return null;
	return {
		id: String(approval.id),
		userId: Number(approval.user_id ?? approval.userId),
		ipHash: approval.ip_hash ?? approval.ipHash ?? null,
		ipMasked: approval.ip_masked ?? approval.ipMasked ?? '不明なIPアドレス',
		userAgent: approval.user_agent ?? approval.userAgent ?? '不明な端末',
		pollTokenHash: String(approval.poll_token_hash ?? approval.pollTokenHash ?? ''),
		status: String(approval.status || 'pending'),
		createdAt: toIsoString(approval.created_at ?? approval.createdAt),
		expiresAt: toIsoString(approval.expires_at ?? approval.expiresAt),
		decidedAt: toIsoString(approval.decided_at ?? approval.decidedAt),
		consumedAt: toIsoString(approval.consumed_at ?? approval.consumedAt),
	};
}

class PostgresAdapter extends DatabaseAdapter {
	constructor(options = {}) {
		super();
		this.config = options;
		this.pool = null;
		this.transactionRetries = Math.max(
			0,
			Math.min(10, Math.floor(Number(options.transactionRetries) || 5)),
		);
		this.retryBaseDelayMs = Math.max(
			10,
			Math.min(5000, Math.floor(Number(options.retryBaseDelayMs) || 50)),
		);
	}

	async connect() {
		const connectionString = String(
			this.config.connectionString || process.env.DATABASE_URL || '',
		).trim();

		if (!connectionString) {
			throw new Error('PostgreSQL connection string is required (DATABASE_URL or config.database.postgres.connectionString)');
		}

		let parsedConnectionString;
		try {
			parsedConnectionString = new URL(connectionString);
		} catch (_) {
			throw new Error('Invalid PostgreSQL connection string. Set DATABASE_URL to a complete postgres:// or postgresql:// URL.');
		}
		if (!['postgres:', 'postgresql:'].includes(parsedConnectionString.protocol)) {
			throw new Error('Invalid PostgreSQL connection string protocol. DATABASE_URL must start with postgres:// or postgresql://.');
		}
		if (!parsedConnectionString.hostname && !parsedConnectionString.searchParams.get('host')) {
			throw new Error('Invalid PostgreSQL connection string host. Set a hostname in DATABASE_URL, or use the host query parameter for a local Unix socket.');
		}
		const sslMode = parsedConnectionString.searchParams.get('sslmode');
		if (
			sslMode &&
			!['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify'].includes(sslMode)
		) {
			throw new Error('Invalid PostgreSQL sslmode. Use disable, allow, prefer, require, verify-ca, verify-full, or no-verify.');
		}

		const poolMax = Math.max(1, Number(this.config.poolSize) || 10);
		const poolMin = Math.min(poolMax, Math.max(1, Number(this.config.poolMin) || 2));
		const poolOptions = {
			connectionString,
			max: poolMax,
			min: poolMin,
			idleTimeoutMillis: this.config.poolIdleTimeoutMs || 300000,
			connectionTimeoutMillis: this.config.connectionTimeoutMs || 15000,
			maxLifetimeSeconds: this.config.poolMaxLifetimeSeconds || 1800,
			keepAlive: true,
			keepAliveInitialDelayMillis: 10000,
		};
		if (this.config.sslCa) {
			poolOptions.ssl = { ca: this.config.sslCa, rejectUnauthorized: true };
		} else if (this.config.ssl === true) {
			poolOptions.ssl = { rejectUnauthorized: false };
		} else if (sslMode && ['verify-full', 'verify-ca', 'require', 'prefer', 'allow'].includes(sslMode)) {
			// verify-full/verify-ca では明示的なCA証明書なしに pg v8 がハングするため、
			// システムのCA束を優先し、なければ Node.js のデフォルトに委ねる。
			const fs = require('fs');
			const SYSTEM_CA_PATHS = [
				'/etc/ssl/certs/ca-certificates.crt',   // Debian/Ubuntu
				'/etc/pki/tls/certs/ca-bundle.crt',     // RHEL/CentOS
				'/etc/ssl/ca-bundle.pem',                // OpenSUSE
			];
			let systemCa = null;
			for (const caPath of SYSTEM_CA_PATHS) {
				try { systemCa = fs.readFileSync(caPath); break; } catch (_) {}
			}
			poolOptions.ssl = systemCa
				? { ca: systemCa, rejectUnauthorized: ['verify-full', 'verify-ca'].includes(sslMode) }
				: { rejectUnauthorized: false };
		}
		this.pool = new Pool(poolOptions);

		let client;
		const warmupClients = [];
		try {
			client = await this.pool.connect();
			await client.query('SELECT 1');
			client.release();
			client = null;

			await Promise.all(Array.from({ length: poolMin }, async () => {
				const warmupClient = await this.pool.connect();
				warmupClients.push(warmupClient);
			}));
			for (const warmupClient of warmupClients.splice(0)) warmupClient.release();
		} catch (error) {
			await this.pool.end();
			this.pool = null;
			if (['EAI_AGAIN', 'ENOTFOUND'].includes(error?.code)) {
				throw new Error(`PostgreSQL host "${error.hostname || 'unknown'}" could not be resolved. Check DATABASE_URL and set the complete database connection URL, not a name such as "base".`);
			}
			throw error;
		} finally {
			client?.release();
			for (const warmupClient of warmupClients.splice(0)) warmupClient.release();
		}

		console.log(`[PostgresAdapter] Connected to PostgreSQL (pool ${poolMin}-${poolMax})`);
	}

	async disconnect() {
		if (this.pool) {
			await this.pool.end();
			this.pool = null;
			console.log('[PostgresAdapter] Disconnected from PostgreSQL');
		}
	}

	async exportDataSnapshot() {
		if (!this.pool) throw new Error('PostgreSQL adapter is not connected');
		return exportPostgresSnapshot(this.pool, 'postgres');
	}

	async importDataSnapshot(snapshot, options = {}) {
		if (!this.pool) throw new Error('PostgreSQL adapter is not connected');
		return importPostgresSnapshot(this.pool, normalizeSnapshot(snapshot), options);
	}

	_reassignReportSnapshotUserIds(snapshot, previousId, nextId) {
		if (!snapshot || typeof snapshot !== 'object') return { snapshot, changed: false };
		const updated = JSON.parse(JSON.stringify(snapshot));
		let changed = false;
		if (Number(updated?.subjectUser?.id) === previousId) {
			updated.subjectUser.id = nextId;
			changed = true;
		}
		for (const member of updated?.dm?.members || []) {
			if (Number(member?.id) !== previousId) continue;
			member.id = nextId;
			changed = true;
		}
		return { snapshot: updated, changed };
	}

	_isRetryableTransactionError(error) {
		if (!error) return false;
		if (error.code === '40001' || error.code === '40P01') return true;
		const msg = String(error.message || '');
		return /restart transaction|transaction retry|retry transaction|could not serialize|deadlock detected/i.test(msg);
	}

	async _waitForTransactionRetry(attempt) {
		const jitter = Math.floor(Math.random() * 50);
		const delay = Math.min(
			2000,
			this.retryBaseDelayMs * (2 ** Math.max(0, attempt - 1)) + jitter,
		);
		await new Promise((resolve) => setTimeout(resolve, delay));
	}

	async _withTransaction(operation) {
		let lastError;
		for (let attempt = 0; attempt <= this.transactionRetries; attempt += 1) {
			const client = await this.pool.connect();
			let started = false;
			try {
				await client.query('BEGIN');
				started = true;
				const result = await operation(client);
				await client.query('COMMIT');
				return result;
			} catch (error) {
				lastError = error;
				if (started) {
					try {
						await client.query('ROLLBACK');
					} catch (_) {
						// Ignored to preserve original error
					}
				}
				if (
					!this._isRetryableTransactionError(error) ||
					attempt >= this.transactionRetries
				) {
					throw error;
				}
				await this._waitForTransactionRetry(attempt + 1);
			} finally {
				client.release();
			}
		}
		throw lastError;
	}

	_normalizeUserBlockList(user) {
		return normalizeUserRow(user);
	}

	_normalizePost(post) {
		return normalizePostRow(post);
	}

	// ==================== User Methods ====================

	async getUserByScid(scid) {
		if (!scid) return null;
		const { rows } = await this.pool.query(
			'SELECT * FROM users WHERE LOWER(scid) = LOWER($1) LIMIT 1',
			[String(scid)],
		);
		const user = normalizeUserRow(rows[0]);
		if (user) this._setCachedUser(user);
		return user;
	}

	_setCachedUser(user) {
		const cache = this._getUserCache();
		if (!cache || !user) return;
		cache.set(user.id, user);
	}

	_updateCachedUser(userId, patch) {
		const cache = this._getUserCache();
		const current = cache?.get(Number(userId));
		if (!cache || !current) return;
		cache.set(Number(userId), { ...current, ...patch, id: Number(userId) });
	}

	_getUserCache() {
		if (!this._userCache) {
			const cacheCfg = appConfig.cache || {};
			if (cacheCfg.userCacheEnabled !== false) {
				this._userCache = new MemoryBoundedCache({
					maxSize: cacheCfg.userCacheMaxSize || 3000,
					ttlMs: cacheCfg.userCacheTtlMs || 300000,
					maxHeapMb: cacheCfg.memoryCacheMaxHeapMb || 0,
				});
			}
		}
		return this._userCache;
	}

	_getProfileStatsCache() {
		if (!this._profileStatsCache) {
			this._profileStatsCache = new MemoryBoundedCache({
				maxSize: 3000,
				ttlMs: 30000,
			});
		}
		return this._profileStatsCache;
	}

	_invalidateProfileStatsCache(userId) {
		if (this._profileStatsCache) {
			if (userId != null) {
				this._profileStatsCache.delete(Number(userId));
			} else {
				this._profileStatsCache.clear();
			}
		}
	}

	async getUserById(id) {
		if (id == null) return null;
		const userId = Number(id);
		if (!Number.isSafeInteger(userId) || userId <= 0) return null;

		const cache = this._getUserCache();
		const cached = cache?.get(userId);
		if (cached) return cached;

		const { rows } = await this.pool.query(
			'SELECT * FROM users WHERE id = $1 LIMIT 1',
			[userId],
		);
		const user = normalizeUserRow(rows[0]);
		if (user) {
			this._setCachedUser(user);
		}
		return user;
	}

	async getUsersByIds(userIds) {
		const ids = [...new Set((userIds || []).map(Number)
			.filter((id) => Number.isSafeInteger(id) && id > 0))];
		if (ids.length === 0) return [];

		const cache = this._getUserCache();
		const userMap = new Map();
		const missingIds = [];

		for (const id of ids) {
			const cached = cache?.get(id);
			if (cached) {
				userMap.set(id, cached);
			} else {
				missingIds.push(id);
			}
		}

		if (missingIds.length > 0) {
			const { rows } = await this.pool.query(
				'SELECT * FROM users WHERE id = ANY($1::int[])',
				[missingIds],
			);
			for (const row of rows) {
				const user = normalizeUserRow(row);
				if (user) {
					this._setCachedUser(user);
					userMap.set(user.id, user);
				}
			}
		}

		return ids.map((id) => userMap.get(id)).filter(Boolean);
	}

	async getPostAuthorsByIds(userIds) {
		const ids = [...new Set((userIds || []).map(Number)
			.filter((id) => Number.isSafeInteger(id) && id > 0))];
		if (ids.length === 0) return [];

		const { rows } = await this.pool.query(
			`SELECT id, auth_provider, external_id, name, scid, icon_data,
					verify, admin, settings, block
			 FROM users
			 WHERE id = ANY($1::int[])`,
			[ids],
		);
		return rows.map(normalizeUserRow).filter(Boolean);
	}

	_invalidateUserCache(userId) {
		if (this._userCache) {
			if (userId != null) {
				this._userCache.delete(Number(userId));
			} else {
				this._userCache.clear();
			}
		}
		if (this._affinityCache) {
			if (userId != null) {
				this._affinityCache.delete(Number(userId));
			} else {
				this._affinityCache.clear();
			}
		}
		if (this._followCache) {
			if (userId != null) {
				this._followCache.delete(Number(userId));
			} else {
				this._followCache.clear();
			}
		}
		this._invalidateProfileStatsCache(userId);
	}

	async getUserByExternalId(authProvider, externalId) {
		if (!authProvider || externalId == null) return null;
		const { rows } = await this.pool.query(
			'SELECT * FROM users WHERE auth_provider = $1 AND external_id = $2 LIMIT 1',
			[String(authProvider), String(externalId)],
		);
		const user = normalizeUserRow(rows[0]);
		if (user) this._setCachedUser(user);
		return user;
	}

	async getUserAuthProviders(userId) {
		const targetId = Number(userId);
		const user = await this.getUserById(targetId);
		if (!user) return [];

		const { rows } = await this.pool.query(
			'SELECT id, user_id AS "userId", provider, provider_user_id AS "providerUserId", provider_profile AS "providerProfile", created_at AS "createdAt" FROM user_auth_providers WHERE user_id = $1 ORDER BY id ASC',
			[targetId],
		);

		const records = rows.map((r) => ({
			id: r.id,
			userId: r.userId,
			provider: r.provider,
			providerUserId: r.providerUserId,
			providerProfile: typeof r.providerProfile === 'string' ? JSON.parse(r.providerProfile) : (r.providerProfile || {}),
			createdAt: r.createdAt,
		}));

		const hasScratch = records.some((r) => String(r.provider).toLowerCase() === 'scratch');
		if (!hasScratch && user.scid) {
			records.unshift({
				id: 0,
				userId: targetId,
				provider: 'scratch',
				providerUserId: user.scid,
				providerProfile: { username: user.scid },
				isPrimary: records.length === 0,
				createdAt: user.created_at || new Date(),
			});
		} else if (records.length === 0 && user.auth_provider && user.external_id) {
			records.push({
				id: 0,
				userId: targetId,
				provider: user.auth_provider,
				providerUserId: user.external_id,
				providerProfile: user.external_profile || {},
				isPrimary: true,
				createdAt: user.created_at || new Date(),
			});
		}

		return records;
	}

	async findUserByAuthProvider(provider, providerUserId) {
		if (!provider || providerUserId == null) return null;
		const normProvider = String(provider).toLowerCase();
		const normUserId = String(providerUserId).trim();

		const { rows } = await this.pool.query(
			`SELECT u.* FROM users u
			 JOIN user_auth_providers p ON u.id = p.user_id
			 WHERE LOWER(p.provider) = $1 AND LOWER(p.provider_user_id) = $2
			 LIMIT 1`,
			[normProvider, normUserId.toLowerCase()],
		);

		if (rows.length > 0) return normalizeUserRow(rows[0]);

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
		const normProvider = String(provider).toLowerCase();
		const normUserId = String(providerUserId).trim();

		const existingUser = await this.findUserByAuthProvider(normProvider, normUserId);
		if (existingUser && existingUser.id !== targetId) {
			const err = new Error('この認証情報は既に他のアカウントに紐付けられています。');
			err.status = 409;
			err.code = 'auth_provider_already_linked';
			throw err;
		}

		const profileJson = JSON.stringify(providerProfile || {});
		const { rows } = await this.pool.query(
			`INSERT INTO user_auth_providers (user_id, provider, provider_user_id, provider_profile, created_at)
			 VALUES ($1, $2, $3, $4::jsonb, NOW())
			 ON CONFLICT (provider, provider_user_id) DO UPDATE SET provider_profile = EXCLUDED.provider_profile
			 RETURNING id, user_id AS "userId", provider, provider_user_id AS "providerUserId", provider_profile AS "providerProfile", created_at AS "createdAt"`,
			[targetId, normProvider, normUserId, profileJson],
		);

		if (normProvider === 'scratch') {
			await this.pool.query(
				'UPDATE users SET scid = COALESCE(scid, $1) WHERE id = $2',
				[normUserId, targetId],
			);
		}
		if (normProvider === 'scratch') this._updateCachedUser(targetId, { scid: normUserId });

		const r = rows[0];
		return {
			id: r.id,
			userId: r.userId,
			provider: r.provider,
			providerUserId: r.providerUserId,
			providerProfile: typeof r.providerProfile === 'string' ? JSON.parse(r.providerProfile) : (r.providerProfile || {}),
			createdAt: r.createdAt,
		};
	}

	async unlinkAuthProvider(userId, provider, providerUserId = null) {
		const targetId = Number(userId);
		const normProvider = String(provider).toLowerCase();
		const linkedProviders = await this.getUserAuthProviders(targetId);

		if (linkedProviders.length <= 1) {
			const err = new Error('最後のログイン方法を解除することはできません。アカウントには最低1つのログイン方法が必要です。');
			err.status = 400;
			err.code = 'cannot_unlink_last_provider';
			throw err;
		}

		if (providerUserId != null) {
			await this.pool.query(
				'DELETE FROM user_auth_providers WHERE user_id = $1 AND LOWER(provider) = $2 AND LOWER(provider_user_id) = $3',
				[targetId, normProvider, String(providerUserId).toLowerCase()],
			);
		} else {
			await this.pool.query(
				'DELETE FROM user_auth_providers WHERE user_id = $1 AND LOWER(provider) = $2',
				[targetId, normProvider],
			);
		}

		if (normProvider === 'scratch') {
			await this.pool.query(
				'UPDATE users SET scid = NULL WHERE id = $1',
				[targetId],
			);
		}
		if (normProvider === 'scratch') this._updateCachedUser(targetId, { scid: null });

		return { success: true };
	}

	async createUser(userData) {
		const provider = userData.auth_provider || 'local';
		const now = new Date().toISOString();

		for (let attempt = 0; attempt < 20; attempt += 1) {
			const countResult = await this.pool.query('SELECT COUNT(*)::bigint AS count FROM users');
			const count = Number(countResult.rows[0].count);
			const digits = Math.max(4, String(Math.max(count, 1)).length);
			const id = Math.floor(Math.random() * (10 ** digits));
			const handle = provider === 'nyaitter' && userData.external_id != null
				? formatNyaitterId(userData.external_id)
				: formatNyaitterId(id);

			const address = userData.nyaitter_address || null;
			try {
				const { rows } = await this.pool.query(
					`INSERT INTO users (id, scid, name, handle, nyaitter_address, auth_provider, provider_domain, external_id, external_profile, uuid, settings, "block", bio, header_image, icon_data, created_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13, $14, $15, $16) RETURNING *`,
					[
						id,
						userData.scid || null,
						userData.name || userData.scid || handle,
						handle,
						address,
						provider,
						userData.provider_domain || null,
						userData.external_id || null,
						userData.external_profile ? JSON.stringify(userData.external_profile) : null,
						userData.uuid || null,
						userData.settings ? JSON.stringify(userData.settings) : '{}',
						JSON.stringify(normalizeBlockList(userData.block, id)),
						userData.bio || userData.me || '',
						userData.header_image || null,
						userData.icon_data || null,
						now,
					],
				);
				const user = normalizeUserRow(rows[0]);
				if (user) this._setCachedUser(user);
				return user;
			} catch (error) {
				if (error.code === '23505') continue;
				throw error;
			}
		}
		throw new Error('Could not allocate a unique Nyaitter ID');
	}

	async searchUsers(query, limit = 20, offset = 0, { cursor = null, withNextCursor = false } = {}) {
		const q = String(query || '').trim();
		if (!q) return withNextCursor ? { users: [], has_more: false, next_cursor: null } : [];
		const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
		const decodedCursor = typeof cursor === 'string' && cursor.trim() ? decodePostCursor(cursor.trim()) : null;
		const targetId = decodedCursor ? Number(decodedCursor.id) : null;
		const digits = q.replace(/^#/, '').replace(/\D/g, '');
		const pattern = `%${q}%`;

		let sql = `SELECT * FROM users WHERE (name ILIKE $1 OR scid ILIKE $1 OR handle ILIKE $1 OR bio ILIKE $1`;
		const values = [pattern];

		if (digits) {
			values.push(`%${digits}%`);
			sql += ` OR CAST(id AS TEXT) LIKE $${values.length}`;
		}
		sql += `)`;

		if (targetId != null) {
			values.push(targetId);
			sql += ` AND id > $${values.length}`;
		}

		values.push(safeLimit + 1);
		const limitIdx = values.length;

		let offsetSql = '';
		if (targetId == null) {
			const safeOffset = Math.max(Number(offset) || 0, 0);
			if (safeOffset > 0) {
				values.push(safeOffset);
				offsetSql = ` OFFSET $${values.length}`;
			}
		}

		sql += ` ORDER BY id ASC LIMIT $${limitIdx}${offsetSql}`;

		const { rows } = await this.pool.query(sql, values);
		const users = rows.map(normalizeUserRow);
		const hasMore = users.length > safeLimit;
		const slice = users.slice(0, safeLimit);
		const lastUser = slice.length > 0 ? slice[slice.length - 1] : null;
		const nextCursor = hasMore && lastUser
			? encodePostCursor({ id: lastUser.id, created_at: lastUser.created_at || new Date(0).toISOString() })
			: null;

		if (withNextCursor) {
			return { users: slice, has_more: hasMore, next_cursor: nextCursor };
		}
		return slice;
	}

	async getAllUsers() {
		const { rows } = await this.pool.query('SELECT * FROM users ORDER BY id ASC');
		return rows.map(normalizeUserRow);
	}

	async getImposterUsers() {
		const { rows } = await this.pool.query(
			`SELECT * FROM users
			 WHERE auth_provider = 'imposter'
			    OR (settings IS NOT NULL AND jsonb_typeof(settings) = 'object' AND settings ? 'imposter')
			 ORDER BY id ASC`,
		);
		return rows.map(normalizeUserRow);
	}

	async getRecommendedUsers(limit = 3, excludedUserId = null) {
		const normalizedLimit = Math.min(Math.max(Number(limit) || 3, 1), 100);
		const values = [normalizedLimit];
		const exclusion = excludedUserId != null && Number.isSafeInteger(Number(excludedUserId))
			? `WHERE id <> $${values.push(Number(excludedUserId))}`
			: '';
		const { rows } = await this.pool.query(
			`SELECT *
			 FROM users
			 ${exclusion}
			 ORDER BY created_at DESC, id ASC
			 LIMIT $1`,
			values,
		);
		return rows.map(normalizeUserRow);
	}

	async getUserStatus(userId) {
		const { rows } = await this.pool.query(
			'SELECT shadow FROM users WHERE id = $1',
			[Number(userId)],
		);
		if (!rows[0]) return null;
		return { shadow: Boolean(rows[0].shadow) };
	}

	async setUserStatus(userId, status) {
		const shadow = Boolean(status && status.shadow);
		const { rows } = await this.pool.query(
			'UPDATE users SET shadow = $2 WHERE id = $1 RETURNING shadow',
			[Number(userId), shadow],
		);
		if (!rows[0]) return null;
		this._updateCachedUser(userId, { shadow });
		return { shadow: Boolean(rows[0].shadow) };
	}

	async updateUserProfile(userId, profileData) {
		const fields = [];
		const values = [];
		let idx = 1;

		if (profileData.name !== undefined) {
			fields.push(`name = $${idx++}`);
			values.push(profileData.name);
		}
		if (profileData.bio !== undefined) {
			fields.push(`bio = $${idx++}`);
			values.push(profileData.bio);
		} else if (profileData.me !== undefined) {
			fields.push(`bio = $${idx++}`);
			values.push(profileData.me);
		}
		if (profileData.header_image !== undefined) {
			fields.push(`header_image = $${idx++}`);
			values.push(profileData.header_image);
		}
		if (profileData.icon_data !== undefined) {
			fields.push(`icon_data = $${idx++}`);
			values.push(profileData.icon_data);
		}
		if (profileData.settings !== undefined) {
			fields.push(`settings = $${idx++}::jsonb`);
			values.push(JSON.stringify(profileData.settings || {}));
		}
		if (profileData.block !== undefined) {
			fields.push(`"block" = $${idx++}::jsonb`);
			values.push(JSON.stringify(normalizeBlockList(profileData.block, userId)));
		}
		if (profileData.verify !== undefined) {
			fields.push(`verify = $${idx++}`);
			values.push(Boolean(profileData.verify));
		}
		if (profileData.freeze !== undefined) {
			fields.push(`"freeze" = $${idx++}`);
			values.push(profileData.freeze || null);
		}
		if (profileData.admin !== undefined) {
			fields.push(`admin = $${idx++}`);
			values.push(Boolean(profileData.admin));
		}
		if (profileData.shadow !== undefined) {
			fields.push(`shadow = $${idx++}`);
			values.push(Boolean(profileData.shadow));
		}
		if (fields.length === 0) return this.getUserById(userId);

		values.push(Number(userId));
		const { rows } = await this.pool.query(
			`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
			values,
		);
		const user = normalizeUserRow(rows[0]);
		this._setCachedUser(user);
		return user;
	}

	async beginAccountOperation(userId, operation) {
		if (!['reassigning', 'deleting'].includes(operation)) throw new Error('Invalid account operation');
		const { rows } = await this.pool.query(
			`UPDATE users
			 SET account_operation = $2
			 WHERE id = $1
			   AND auth_provider <> 'nyaitter'
			   AND account_operation IS NULL
			 RETURNING *`,
			[Number(userId), operation],
		);
		const user = normalizeUserRow(rows[0] || null);
		this._setCachedUser(user);
		return user;
	}

	async finishAccountOperation(userId, operation) {
		const { rows } = await this.pool.query(
			`UPDATE users SET account_operation = NULL
			 WHERE id = $1 AND account_operation = $2
			 RETURNING *`,
			[Number(userId), operation],
		);
		const user = normalizeUserRow(rows[0] || null);
		this._setCachedUser(user);
		return user;
	}

	async reassignUserId(userId) {
		return this._withTransaction(async (client) => {
			const { rows: userRows } = await client.query(
				`SELECT * FROM users
				 WHERE id = $1 AND auth_provider <> 'nyaitter' AND account_operation = 'reassigning'
				 FOR UPDATE`,
				[Number(userId)],
			);
			const user = userRows[0];
			if (!user) return null;

			const previousId = Number(user.id);
			const { rows: countRows } = await client.query('SELECT COUNT(*)::bigint AS count FROM users');
			const digits = Math.max(4, String(Math.max(Number(countRows[0]?.count) || 1, 1)).length);
			const upperBound = 10 ** digits;
			let nextId = null;
			for (let attempt = 0; attempt < 100; attempt += 1) {
				const candidate = Math.floor(Math.random() * upperBound);
				if (candidate === previousId) continue;
				const { rows } = await client.query('SELECT 1 FROM users WHERE id = $1 LIMIT 1', [candidate]);
				if (rows.length === 0) {
					nextId = candidate;
					break;
				}
			}
			if (nextId == null) throw new Error('Could not allocate a unique Nyaitter ID');

			// Update users table first so ON UPDATE CASCADE foreign keys cascade automatically
			const { rows } = await client.query(
				`UPDATE users
				 SET id = $2, handle = $3
				 WHERE id = $1
				 RETURNING *`,
				[previousId, nextId, formatNyaitterId(nextId)],
			);

			// Fallback updates for non-cascading or legacy constraints
			await client.query('UPDATE sessions SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE trusted_login_ips SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE login_approvals SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE bot_tokens SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE posts SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE likes SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE stars SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE reposts SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE pinned_posts SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE dm_messages SET sender_id = $2 WHERE sender_id = $1', [previousId, nextId]);
			await client.query('UPDATE follows SET follower_id = $2 WHERE follower_id = $1', [previousId, nextId]);
			await client.query('UPDATE follows SET following_id = $2 WHERE following_id = $1', [previousId, nextId]);
			await client.query('UPDATE dm_e2e_keys SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE notifications SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE notifications SET from_user_id = $2 WHERE from_user_id = $1', [previousId, nextId]);
			await client.query('UPDATE push_subscriptions SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE moderation_reports SET reporter_user_id = $2 WHERE reporter_user_id = $1', [previousId, nextId]);
			await client.query('UPDATE moderation_reports SET assigned_admin_id = $2 WHERE assigned_admin_id = $1', [previousId, nextId]);
			await client.query('UPDATE logs SET nyaitter_id = $2 WHERE nyaitter_id = $1', [previousId, nextId]);

			// groups and memberships
			await client.query('UPDATE groups SET owner_id = $2 WHERE owner_id = $1', [previousId, nextId]);
			await client.query('UPDATE group_memberships SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE group_invites SET inviter_id = $2 WHERE inviter_id = $1', [previousId, nextId]);
			await client.query('UPDATE group_invites SET invitee_id = $2 WHERE invitee_id = $1', [previousId, nextId]);
			await client.query('UPDATE group_join_requests SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE group_join_requests SET reviewed_by = $2 WHERE reviewed_by = $1', [previousId, nextId]);

			// authorized apps and affinities
			await client.query('UPDATE authorized_apps SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE user_keyword_affinities SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);

			// dm_channels participants
			const { rows: channels } = await client.query(
				'SELECT id, participants FROM dm_channels WHERE $1::int = ANY(participants)',
				[previousId],
			);
			for (const channel of channels) {
				const participants = (channel.participants || []).map((id) => (Number(id) === previousId ? nextId : Number(id)));
				await client.query('UPDATE dm_channels SET participants = $2::int[] WHERE id = $1', [channel.id, participants]);
			}

			// group_dms
			const { rows: groups } = await client.query(
				'SELECT id, host_id, member, post, unread FROM group_dms WHERE host_id = $1::int OR $1::int = ANY(member)',
				[previousId],
			);
			for (const group of groups) {
				const member = (group.member || []).map((id) => (Number(id) === previousId ? nextId : Number(id)));
				const rawPost = Array.isArray(group.post) ? group.post : parseJsonSafe(group.post, []);
				const post = rawPost.map((msg) => (
					Number(msg?.userid) === previousId ? { ...msg, userid: nextId } : msg
				));
				const unread = { ...(typeof group.unread === 'object' && group.unread !== null ? group.unread : parseJsonSafe(group.unread, {})) };
				if (Object.prototype.hasOwnProperty.call(unread, String(previousId))) {
					unread[String(nextId)] = unread[String(previousId)];
					delete unread[String(previousId)];
				}
				const hostId = Number(group.host_id) === previousId ? nextId : Number(group.host_id);
				await client.query(
					'UPDATE group_dms SET host_id = $2, member = $3::int[], post = $4::jsonb, unread = $5::jsonb WHERE id = $1',
					[group.id, hostId, member, JSON.stringify(post), JSON.stringify(unread)],
				);
			}

			// blocked users
			const { rows: blockedUsers } = await client.query(
				'SELECT id, "block" FROM users WHERE "block" @> $1::jsonb',
				[JSON.stringify([previousId])],
			);
			for (const bu of blockedUsers) {
				const rawBlock = Array.isArray(bu.block) ? bu.block : parseJsonSafe(bu.block, []);
				const block = normalizeBlockList(rawBlock.map((id) => (Number(id) === previousId ? nextId : id)), bu.id);
				await client.query('UPDATE users SET "block" = $2::jsonb WHERE id = $1', [bu.id, JSON.stringify(block)]);
			}

			// notifications target
			const { rows: notifs } = await client.query(
				"SELECT id, target FROM notifications WHERE target->>'kind' = 'user' AND target->>'id' = $1",
				[String(previousId)],
			);
			for (const notif of notifs) {
				const target = typeof notif.target === 'object' && notif.target !== null ? notif.target : parseJsonSafe(notif.target, {});
				target.id = nextId;
				await client.query('UPDATE notifications SET target = $2::jsonb WHERE id = $1', [notif.id, JSON.stringify(target)]);
			}

			// moderation reports snapshot
			const { rows: reportRows } = await client.query('SELECT id, target_kind, target_id, target_snapshot, excluded_admin_ids FROM moderation_reports FOR UPDATE');
			for (const report of reportRows) {
				const rawSnapshot = typeof report.target_snapshot === 'object' && report.target_snapshot !== null ? report.target_snapshot : parseJsonSafe(report.target_snapshot, {});
				const { snapshot, changed } = this._reassignReportSnapshotUserIds(rawSnapshot, previousId, nextId);
				const targetId = report.target_kind === 'user' && String(report.target_id) === String(previousId)
					? String(nextId)
					: report.target_id;
				const rawExcluded = Array.isArray(report.excluded_admin_ids) ? report.excluded_admin_ids : parseJsonSafe(report.excluded_admin_ids, []);
				const excluded = rawExcluded.map((id) => (Number(id) === previousId ? nextId : Number(id)));
				const excludedChanged = excluded.some((id, index) => Number(id) !== Number(rawExcluded[index]));
				if (!changed && targetId === report.target_id && !excludedChanged) continue;
				await client.query(
					'UPDATE moderation_reports SET target_id = $2, target_snapshot = $3::jsonb, excluded_admin_ids = $4::jsonb WHERE id = $1',
					[report.id, targetId, JSON.stringify(snapshot || {}), JSON.stringify(excluded || [])],
				);
			}

			// imposter parent_id and members
			const { rows: imposterUsers } = await client.query(
				"SELECT id, settings FROM users WHERE settings::text LIKE '%imposter%' OR auth_provider = 'imposter'",
			);
			for (const imp of imposterUsers) {
				const impSettings = typeof imp.settings === 'object' && imp.settings !== null ? imp.settings : parseJsonSafe(imp.settings, {});
				if (!impSettings || typeof impSettings !== 'object') continue;
				let changed = false;
				if (impSettings.imposter && typeof impSettings.imposter === 'object') {
					if (Number(impSettings.imposter.parent_id) === previousId) {
						impSettings.imposter.parent_id = nextId;
						changed = true;
					}
					if (Array.isArray(impSettings.imposter.members)) {
						impSettings.imposter.members = impSettings.imposter.members.map((m) => {
							if (Number(m?.user_id) === previousId) {
								changed = true;
								return { ...m, user_id: nextId };
							}
							return m;
						});
					}
				}
				if (changed) {
					await client.query('UPDATE users SET settings = $2::jsonb WHERE id = $1', [imp.id, JSON.stringify(impSettings)]);
				}
			}

			this._invalidateUserCache(previousId);
			this._invalidateUserCache(nextId);

			if (this._affinityCache instanceof Map) {
				const userAffinity = this._affinityCache.get(previousId);
				this._affinityCache.delete(previousId);
				if (userAffinity) this._affinityCache.set(nextId, userAffinity);
			}
			if (this._followCache instanceof Map) {
				const userFollows = this._followCache.get(previousId);
				this._followCache.delete(previousId);
				if (userFollows) this._followCache.set(nextId, userFollows);
			}
			if (Array.isArray(this._candidatePostsCache?.posts)) {
				for (const post of this._candidatePostsCache.posts) {
					if (Number(post.user_id) === previousId) post.user_id = nextId;
				}
			}

			return normalizeUserRow(rows[0] || null);
		});
	}

	async deleteAccount(userId) {
		this._invalidateUserCache(userId);
		return this._withTransaction(async (client) => {
			const { rows: userRows } = await client.query(
				`SELECT id FROM users WHERE id = $1 AND account_operation = 'deleting' FOR UPDATE`,
				[Number(userId)],
			);
			if (!userRows[0]) return false;

			const { rows: postRows } = await client.query('SELECT id, reply_to, repost_to FROM posts WHERE user_id = $1', [userId]);
			const postIds = postRows.map((row) => Number(row.id));
			if (postIds.length > 0) {
				// Decrement reply/repost counters on parents of posts created by this user
				for (const p of postRows) {
					if (p.reply_to) {
						await client.query('UPDATE posts SET reply_count = GREATEST(0, reply_count - 1) WHERE id = $1', [Number(p.reply_to)]);
					}
					if (p.repost_to) {
						await client.query('UPDATE posts SET repost_count = GREATEST(0, repost_count - 1) WHERE id = $1', [Number(p.repost_to)]);
					}
				}
				await client.query('UPDATE posts SET repost_to = NULL WHERE repost_to = ANY($1::int[])', [postIds]);
			}

			// Decrement like counters for posts liked by this user
			const { rows: userLikes } = await client.query('SELECT post_id FROM likes WHERE user_id = $1', [userId]);
			const likedPostIds = userLikes.map((r) => Number(r.post_id)).filter((id) => !postIds.includes(id));
			if (likedPostIds.length > 0) {
				await client.query('UPDATE posts SET like_count = GREATEST(0, like_count - 1) WHERE id = ANY($1::int[])', [likedPostIds]);
			}

			// Decrement star counters for posts starred by this user
			const { rows: userStars } = await client.query('SELECT post_id FROM stars WHERE user_id = $1', [userId]);
			const starredPostIds = userStars.map((r) => Number(r.post_id)).filter((id) => !postIds.includes(id));
			if (starredPostIds.length > 0) {
				await client.query('UPDATE posts SET star_count = GREATEST(0, star_count - 1) WHERE id = ANY($1::int[])', [starredPostIds]);
			}

			const { rows: channelRows } = await client.query(
				`SELECT id, participants FROM dm_channels WHERE $1::int = ANY(participants) FOR UPDATE`,
				[userId],
			);
			for (const channel of channelRows) {
				const participants = (channel.participants || []).map(Number).filter((id) => id !== Number(userId));
				if (participants.length < 2) await client.query('DELETE FROM dm_channels WHERE id = $1', [channel.id]);
				else await client.query('UPDATE dm_channels SET participants = $2::int[] WHERE id = $1', [channel.id, participants]);
			}

			const { rows: groupRows } = await client.query(
`SELECT id, host_id, member, post, unread
					 FROM group_dms
					 WHERE host_id = $1 OR $1::int = ANY(member)
					 FOR UPDATE`,
				[userId],
			);
			for (const group of groupRows) {
				const members = (group.member || []).map(Number).filter((id) => id !== Number(userId));
				if (members.length === 0) {
					await client.query('DELETE FROM group_dms WHERE id = $1', [group.id]);
					continue;
				}
				const rawPost = Array.isArray(group.post) ? group.post : parseJsonSafe(group.post, []);
				const messages = rawPost.filter((message) => Number(message?.userid) !== Number(userId));
				const unread = { ...(typeof group.unread === 'object' && group.unread !== null ? group.unread : parseJsonSafe(group.unread, {})) };
				delete unread[String(userId)];
				const hostId = Number(group.host_id) === Number(userId) ? members[0] : Number(group.host_id);
				await client.query(
					`UPDATE group_dms
					 SET host_id = $2, member = $3::int[], post = $4::jsonb, unread = $5::jsonb
					 WHERE id = $1`,
					[group.id, hostId, members, JSON.stringify(messages), JSON.stringify(unread)],
				);
			}

			const { rows: blockedUsers } = await client.query(
				'SELECT id, "block" FROM users WHERE "block" @> $1::jsonb',
				[JSON.stringify([Number(userId)])],
			);
			for (const bu of blockedUsers) {
				const rawBlock = Array.isArray(bu.block) ? bu.block : parseJsonSafe(bu.block, []);
				const block = normalizeBlockList(rawBlock.filter((id) => Number(id) !== Number(userId)), bu.id);
				await client.query('UPDATE users SET "block" = $2::jsonb WHERE id = $1', [bu.id, JSON.stringify(block)]);
			}

			await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
			await client.query('DELETE FROM bot_tokens WHERE user_id = $1', [userId]);
			await client.query('DELETE FROM trusted_login_ips WHERE user_id = $1', [userId]);
			await client.query('DELETE FROM login_approvals WHERE user_id = $1', [userId]);
			await client.query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
			await client.query('DELETE FROM moderation_reports WHERE reporter_user_id = $1', [userId]);
			await client.query('DELETE FROM logs WHERE nyaitter_id = $1', [Number(userId)]);
			const result = await client.query('DELETE FROM users WHERE id = $1', [userId]);
			return result.rowCount > 0;
		});
	}

	async getAccountAttachmentKeys(userId) {
		const { rows } = await this.pool.query(
			'SELECT attachments FROM posts WHERE user_id = $1',
			[Number(userId)],
		);
		const keys = new Set();
		for (const row of rows) {
			const attachments = Array.isArray(row.attachments) ? row.attachments : parseJsonSafe(row.attachments, []);
			for (const attachment of attachments) {
				const key = attachment?.id || attachment?.key;
				if (typeof key === 'string' && key.startsWith('attachments/')) keys.add(key);
			}
		}
		return [...keys];
	}

	async rewriteAccountAttachmentKeys(userId, replacements) {
		const replacementMap = createAttachmentReplacementMap(replacements);
		if (replacementMap.size === 0) return 0;
		return this._withTransaction(async (client) => {
			const { rows } = await client.query(
				'SELECT id, attachments FROM posts WHERE user_id = $1 FOR UPDATE',
				[Number(userId)],
			);
			let updatedCount = 0;
			for (const row of rows) {
				const rawAttachments = Array.isArray(row.attachments) ? row.attachments : parseJsonSafe(row.attachments, []);
				const { attachments, changed } = rewriteAttachmentReferences(rawAttachments, replacementMap);
				if (!changed) continue;
				await client.query(
					'UPDATE posts SET attachments = $2::jsonb WHERE id = $1',
					[row.id, JSON.stringify(attachments)],
				);
				const cachedPost = this._getPostCache()?.get(row.id);
				if (cachedPost) {
					this._getPostCache()?.set(row.id, { ...cachedPost, attachments });
				}
				updatedCount += 1;
			}
			return updatedCount;
		});
	}

	// ==================== Sessions ====================

	async createSession(userId, meta = {}) {
		const token = typeof meta.token === 'string' && meta.token
			? meta.token
			: crypto.randomBytes(appConfig.auth.sessionTokenBytes).toString('hex');
		const sessionId = typeof meta.sessionId === 'string' && meta.sessionId
			? meta.sessionId
			: crypto.randomBytes(16).toString('base64url');
		const expiresAt = meta.expiresAt
			? toIsoString(meta.expiresAt)
			: new Date(Date.now() + appConfig.auth.sessionExpiryDays * 24 * 60 * 60 * 1000).toISOString();
		const createdAt = new Date().toISOString();
		const ipHash = meta.ipHash || null;
		const ipMasked = meta.ipMasked || '不明なIPアドレス';
		const userAgent = meta.userAgent || '不明な端末';

		const { rows } = await this.pool.query(
			`INSERT INTO sessions (session_id, token, user_id, expires_at, created_at, ip_hash, ip_masked, user_agent)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			 RETURNING *`,
			[sessionId, token, Number(userId), expiresAt, createdAt, ipHash, ipMasked, userAgent],
		);
		return mapSession(rows[0]);
	}

	async getSessionByToken(token) {
		if (!token) return null;
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`SELECT * FROM sessions WHERE token = $1 AND expires_at > $2 LIMIT 1`,
			[String(token), now],
		);
		if (!rows[0]) {
			await this.pool.query('DELETE FROM sessions WHERE token = $1 AND expires_at <= $2', [String(token), now]);
			return null;
		}
		return mapSession(rows[0]);
	}

	async getUserBySessionToken(token) {
		if (!token) return null;
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`SELECT u.*, s.token AS session_token, s.expires_at AS session_expires_at, s.session_id, s.ip_hash, s.ip_masked, s.user_agent
			 FROM sessions AS s
			 INNER JOIN users AS u ON u.id = s.user_id
			 WHERE s.token = $1 AND s.expires_at > $2
			 LIMIT 1`,
			[String(token), now],
		);
		if (!rows[0]) return null;
		return normalizeUserRow(rows[0]);
	}

	async getUsersAndSessionsByTokens(tokens) {
		const safeTokens = [...new Set((tokens || []).map(String).filter(Boolean))];
		if (safeTokens.length === 0) return [];
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`SELECT u.*, s.token AS session_token, s.expires_at AS session_expires_at, s.session_id, s.ip_hash, s.ip_masked, s.user_agent
			 FROM sessions AS s
			 INNER JOIN users AS u ON u.id = s.user_id
			 WHERE s.token = ANY($1::text[]) AND s.expires_at > $2`,
			[safeTokens, now],
		);
		return rows.map((row) => ({
			session: {
				id: row.session_id,
				token: row.session_token,
				userId: Number(row.id),
				expiresAt: toIsoString(row.session_expires_at),
				ipHash: row.ip_hash || null,
				ipMasked: row.ip_masked || '不明なIPアドレス',
				userAgent: row.user_agent || '不明な端末',
			},
			user: normalizeUserRow(row),
		}));
	}

	async invalidateSession(token) {
		if (!token) return false;
		const { rowCount } = await this.pool.query('DELETE FROM sessions WHERE token = $1', [String(token)]);
		return rowCount > 0;
	}

	async invalidateUserSessionById(userId, sessionId) {
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`DELETE FROM sessions
			 WHERE user_id = $1 AND session_id = $2 AND expires_at > $3
			 RETURNING token`,
			[Number(userId), String(sessionId), now],
		);
		return rows[0]?.token || null;
	}

	async revokeUserSessionsBySessionId(userId, sessionId) {
		return this._withTransaction(async (client) => {
			const now = new Date().toISOString();
			const { rows: targetRows } = await client.query(
				`SELECT ip_hash FROM sessions WHERE user_id = $1 AND session_id = $2 AND expires_at > $3`,
				[Number(userId), String(sessionId), now],
			);
			const target = targetRows[0];
			if (!target) {
				return { found: false, ipHash: null, tokens: [], invalidated: 0, trustRevoked: false };
			}
			const ipHash = target.ip_hash;
			let trustRevoked = false;
			let tokens = [];
			let invalidated = 0;

			if (ipHash) {
				const revokedResult = await client.query(
					'DELETE FROM trusted_login_ips WHERE user_id = $1 AND ip_hash = $2',
					[Number(userId), ipHash],
				);
				trustRevoked = revokedResult.rowCount > 0;

				const invalidatedResult = await client.query(
					'DELETE FROM sessions WHERE user_id = $1 AND ip_hash = $2 RETURNING token',
					[Number(userId), ipHash],
				);
				tokens = invalidatedResult.rows.map((r) => r.token);
				invalidated = invalidatedResult.rowCount;
			} else {
				const singleDel = await client.query(
					'DELETE FROM sessions WHERE user_id = $1 AND session_id = $2 RETURNING token',
					[Number(userId), String(sessionId)],
				);
				tokens = singleDel.rows.map((r) => r.token);
				invalidated = singleDel.rowCount;
			}

			return {
				found: true,
				ipHash,
				tokens,
				invalidated,
				trustRevoked,
			};
		});
	}

	async getUserSessions(userId) {
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`SELECT * FROM sessions WHERE user_id = $1 AND expires_at > $2 ORDER BY created_at DESC`,
			[Number(userId), now],
		);
		return rows.map(mapSession);
	}

	async invalidateAllSessions(userId) {
		const { rowCount } = await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [Number(userId)]);
		return Number(rowCount || 0);
	}

	async invalidateSessionsByIp(userId, ipHash) {
		const { rowCount } = await this.pool.query(
			'DELETE FROM sessions WHERE user_id = $1 AND ip_hash = $2',
			[Number(userId), String(ipHash)],
		);
		return Number(rowCount || 0);
	}

	// ==================== Trusted Login IPs ====================

	async trustLoginIp(userId, { ipHash, ipMasked }) {
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`INSERT INTO trusted_login_ips (user_id, ip_hash, ip_masked, created_at, last_used_at)
			 VALUES ($1, $2, $3, $4, $4)
			 ON CONFLICT (user_id, ip_hash) DO UPDATE SET ip_masked = EXCLUDED.ip_masked, last_used_at = EXCLUDED.last_used_at
			 RETURNING *`,
			[Number(userId), String(ipHash), ipMasked || '不明なIPアドレス', now],
		);
		return {
			userId: Number(rows[0].user_id),
			ipHash: rows[0].ip_hash,
			ipMasked: rows[0].ip_masked,
			createdAt: toIsoString(rows[0].created_at),
			lastUsedAt: toIsoString(rows[0].last_used_at),
		};
	}

	async getTrustedLoginIp(userId, ipHash) {
		const { rows } = await this.pool.query(
			'SELECT * FROM trusted_login_ips WHERE user_id = $1 AND ip_hash = $2',
			[Number(userId), String(ipHash)],
		);
		if (!rows[0]) return null;
		return {
			userId: Number(rows[0].user_id),
			ipHash: rows[0].ip_hash,
			ipMasked: rows[0].ip_masked,
			createdAt: toIsoString(rows[0].created_at),
			lastUsedAt: toIsoString(rows[0].last_used_at),
		};
	}

	async countTrustedLoginIps(userId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int AS count FROM trusted_login_ips WHERE user_id = $1',
			[Number(userId)],
		);
		return Number(rows[0]?.count || 0);
	}

	async revokeTrustedLoginIp(userId, ipHash) {
		const { rowCount } = await this.pool.query(
			'DELETE FROM trusted_login_ips WHERE user_id = $1 AND ip_hash = $2',
			[Number(userId), String(ipHash)],
		);
		return rowCount > 0;
	}

	// ==================== Login Approvals ====================

	async createLoginApproval(approvalData) {
		const id = approvalData.id || crypto.randomUUID();
		const now = new Date().toISOString();
		const expiresAt = approvalData.expiresAt ? toIsoString(approvalData.expiresAt) : new Date(Date.now() + 10 * 60000).toISOString();
		const { rows } = await this.pool.query(
			`INSERT INTO login_approvals (id, user_id, ip_hash, ip_masked, user_agent, poll_token_hash, status, expires_at, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
			 RETURNING *`,
			[
				id,
				Number(approvalData.userId),
				approvalData.ipHash || null,
				approvalData.ipMasked || '不明なIPアドレス',
				approvalData.userAgent || '不明な端末',
				String(approvalData.pollTokenHash),
				expiresAt,
				now,
			],
		);
		return mapLoginApproval(rows[0]);
	}

	async getLoginApproval(id) {
		if (!id) return null;
		const now = new Date().toISOString();
		await this.pool.query(
			"UPDATE login_approvals SET status = 'expired' WHERE id = $1 AND status = 'pending' AND expires_at <= $2",
			[String(id), now],
		);
		const { rows } = await this.pool.query('SELECT * FROM login_approvals WHERE id = $1', [String(id)]);
		return mapLoginApproval(rows[0]);
	}

	async getLoginApprovalByPollToken(id, pollTokenHash) {
		if (!id || !pollTokenHash) return null;
		const now = new Date().toISOString();
		await this.pool.query(
			"UPDATE login_approvals SET status = 'expired' WHERE id = $1 AND status = 'pending' AND expires_at <= $2",
			[String(id), now],
		);
		const { rows } = await this.pool.query(
			'SELECT * FROM login_approvals WHERE id = $1 AND poll_token_hash = $2',
			[String(id), String(pollTokenHash)],
		);
		return mapLoginApproval(rows[0]);
	}

	async decideLoginApproval(userId, id, decision) {
		const status = (decision === 'approve' || decision === 'approved') ? 'approved' : 'denied';
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`UPDATE login_approvals SET status = $3, decided_at = $4
			 WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > $4
			 RETURNING *`,
			[String(id), Number(userId), status, now],
		);
		if (rows[0]) return mapLoginApproval(rows[0]);
		const existing = await this.getLoginApproval(id);
		return existing && Number(existing.userId) === Number(userId) ? existing : null;
	}

	async consumeLoginApproval(id, pollTokenHash) {
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`UPDATE login_approvals SET status = 'consumed', consumed_at = $3
			 WHERE id = $1 AND poll_token_hash = $2 AND status = 'approved' AND expires_at > $3
			 RETURNING *`,
			[String(id), String(pollTokenHash), now],
		);
		return mapLoginApproval(rows[0]);
	}

	// ==================== Bot Tokens ====================

	async createBotToken(userId, tokenId, tokenHash, name) {
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`INSERT INTO bot_tokens (token_id, user_id, token_hash, name, created_at)
			 VALUES ($1, $2, $3, $4, $5)
			 RETURNING *`,
			[String(tokenId), Number(userId), String(tokenHash), String(name || ''), now],
		);
		return {
			tokenId: rows[0].token_id,
			userId: Number(rows[0].user_id),
			tokenHash: rows[0].token_hash,
			name: rows[0].name,
			createdAt: toIsoString(rows[0].created_at),
			lastUsedAt: toIsoString(rows[0].last_used_at),
		};
	}

	async getBotTokenById(tokenId) {
		if (!tokenId) return null;
		const { rows } = await this.pool.query(
			'SELECT * FROM bot_tokens WHERE token_id = $1',
			[String(tokenId)],
		);
		if (!rows[0]) return null;
		return {
			tokenId: rows[0].token_id,
			userId: Number(rows[0].user_id),
			tokenHash: rows[0].token_hash,
			name: rows[0].name,
			createdAt: toIsoString(rows[0].created_at),
			lastUsedAt: toIsoString(rows[0].last_used_at),
		};
	}

	async getUserBotTokens(userId) {
		const { rows } = await this.pool.query(
			'SELECT token_id, name, created_at, last_used_at FROM bot_tokens WHERE user_id = $1 ORDER BY created_at DESC',
			[Number(userId)],
		);
		return rows.map((r) => ({
			tokenId: r.token_id,
			name: r.name,
			createdAt: toIsoString(r.created_at),
			lastUsedAt: toIsoString(r.last_used_at),
		}));
	}

	async revokeBotToken(userId, tokenId) {
		const { rowCount } = await this.pool.query(
			'DELETE FROM bot_tokens WHERE user_id = $1 AND token_id = $2',
			[Number(userId), String(tokenId)],
		);
		return rowCount > 0;
	}

	async updateBotTokenLastUsed(tokenId) {
		if (!tokenId) return;
		const now = new Date().toISOString();
		await this.pool.query(
			'UPDATE bot_tokens SET last_used_at = $2 WHERE token_id = $1',
			[String(tokenId), now],
		);
	}

	// ==================== Authorized Apps (NyaitterAuth) ====================

	async createAuthorizedApp(userId, appId, appTokenHash, appName, appIconUrl, scopes, accessTokenId = null, accessTokenHash = null) {
		const now = new Date().toISOString();
		const scopesJson = JSON.stringify(Array.isArray(scopes) ? scopes : []);
		const { rows } = await this.pool.query(
			`INSERT INTO authorized_apps (user_id, app_id, app_token_hash, app_name, app_icon_url, scopes, access_token_id, access_token_hash, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $9)
			 ON CONFLICT (user_id, app_id, app_token_hash)
			 DO UPDATE SET
			   app_name = EXCLUDED.app_name,
			   app_icon_url = EXCLUDED.app_icon_url,
			   scopes = EXCLUDED.scopes,
			   access_token_id = COALESCE(EXCLUDED.access_token_id, authorized_apps.access_token_id),
			   access_token_hash = COALESCE(EXCLUDED.access_token_hash, authorized_apps.access_token_hash),
			   updated_at = EXCLUDED.updated_at
			 RETURNING *`,
			[Number(userId), String(appId), String(appTokenHash), String(appName), appIconUrl ? String(appIconUrl) : null, scopesJson, accessTokenId, accessTokenHash, now],
		);
		return this._mapAuthorizedApp(rows[0]);
	}

	async getAuthorizedAppByUserAndAppToken(userId, appId, appTokenHash) {
		const { rows } = await this.pool.query(
			'SELECT * FROM authorized_apps WHERE user_id = $1 AND app_id = $2 AND app_token_hash = $3',
			[Number(userId), String(appId), String(appTokenHash)],
		);
		return this._mapAuthorizedApp(rows[0]);
	}

	async getAuthorizedAppByAccessTokenId(accessTokenId) {
		if (!accessTokenId) return null;
		const { rows } = await this.pool.query(
			'SELECT * FROM authorized_apps WHERE access_token_id = $1',
			[String(accessTokenId)],
		);
		return this._mapAuthorizedApp(rows[0]);
	}

	async getUserAuthorizedApps(userId) {
		const { rows } = await this.pool.query(
			'SELECT * FROM authorized_apps WHERE user_id = $1 ORDER BY created_at DESC',
			[Number(userId)],
		);
		return rows.map((r) => this._mapAuthorizedApp(r));
	}

	async getAuthorizedAppById(id, userId = null) {
		const query = userId !== null
			? 'SELECT * FROM authorized_apps WHERE id = $1 AND user_id = $2'
			: 'SELECT * FROM authorized_apps WHERE id = $1';
		const params = userId !== null ? [Number(id), Number(userId)] : [Number(id)];
		const { rows } = await this.pool.query(query, params);
		return this._mapAuthorizedApp(rows[0]);
	}

	async updateAuthorizedAppScopes(id, userId, scopes, accessTokenId = null, accessTokenHash = null) {
		const now = new Date().toISOString();
		const scopesJson = JSON.stringify(Array.isArray(scopes) ? scopes : []);
		const query = userId !== null
			? `UPDATE authorized_apps
			   SET scopes = $3::jsonb, access_token_id = $4, access_token_hash = $5, updated_at = $6
			   WHERE id = $1 AND user_id = $2
			   RETURNING *`
			: `UPDATE authorized_apps
			   SET scopes = $2::jsonb, access_token_id = $3, access_token_hash = $4, updated_at = $5
			   WHERE id = $1
			   RETURNING *`;
		const params = userId !== null
			? [Number(id), Number(userId), scopesJson, accessTokenId, accessTokenHash, now]
			: [Number(id), scopesJson, accessTokenId, accessTokenHash, now];
		const { rows } = await this.pool.query(query, params);
		return this._mapAuthorizedApp(rows[0]);
	}

	async updateAuthorizedAppLastUsed(id) {
		const now = new Date().toISOString();
		await this.pool.query(
			'UPDATE authorized_apps SET last_used_at = $2 WHERE id = $1',
			[Number(id), now],
		);
		return true;
	}

	async deleteAuthorizedApp(id, userId = null) {
		const query = userId !== null
			? 'DELETE FROM authorized_apps WHERE id = $1 AND user_id = $2'
			: 'DELETE FROM authorized_apps WHERE id = $1';
		const params = userId !== null ? [Number(id), Number(userId)] : [Number(id)];
		const { rowCount } = await this.pool.query(query, params);
		return (rowCount || 0) > 0;
	}

	_mapAuthorizedApp(row) {
		if (!row) return null;
		let parsedScopes = [];
		if (Array.isArray(row.scopes)) {
			parsedScopes = row.scopes;
		} else if (typeof row.scopes === 'string') {
			try { parsedScopes = JSON.parse(row.scopes); } catch (_) { parsedScopes = []; }
		}
		return {
			id: row.id,
			userId: Number(row.user_id),
			appId: row.app_id,
			appTokenHash: row.app_token_hash,
			appName: row.app_name,
			appIconUrl: row.app_icon_url || null,
			scopes: Array.isArray(parsedScopes) ? parsedScopes : [],
			accessTokenId: row.access_token_id || null,
			accessTokenHash: row.access_token_hash || null,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			lastUsedAt: row.last_used_at || null,
		};
	}

	// ==================== Groups ====================

	async createGroup(groupData) {
		const now = groupData.createdAt ? toIsoString(groupData.createdAt) : new Date().toISOString();
		const { rows } = await this.pool.query(
			`INSERT INTO groups (id, owner_id, name, description, icon_data, header_image, visibility, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
			[
				String(groupData.id), Number(groupData.ownerId), String(groupData.name || ''),
				String(groupData.description || ''), groupData.iconData ?? null, groupData.headerImage ?? null,
				String(groupData.visibility || 'open'), now,
			],
		);
		return normalizeGroupRow(rows[0] || null);
	}

	async getGroupById(groupId) {
		const { rows } = await this.pool.query(
			`SELECT g.*, (
				SELECT COUNT(*)::int FROM group_memberships gm
				WHERE gm.group_id = g.id AND gm.status = 'active'
			) AS member_count
			FROM groups g WHERE g.id = $1 AND g.deleted_at IS NULL LIMIT 1`,
			[String(groupId)],
		);
		return normalizeGroupRow(rows[0] || null);
	}

	async updateGroup(groupId, fields) {
		const fieldMap = {
			name: 'name', description: 'description', iconData: 'icon_data', icon_data: 'icon_data',
			headerImage: 'header_image', header_image: 'header_image', visibility: 'visibility',
		};
		const sets = [];
		const values = [];
		const assigned = new Set();
		for (const [key, column] of Object.entries(fieldMap)) {
			if (fields[key] === undefined || assigned.has(column)) continue;
			assigned.add(column);
			values.push(fields[key] == null && ['icon_data', 'header_image'].includes(column) ? null : String(fields[key]));
			sets.push(`${column} = $${values.length}`);
		}
		if (sets.length === 0) return this.getGroupById(groupId);
		sets.push(`updated_at = NOW()`);
		values.push(String(groupId));
		const { rows } = await this.pool.query(
			`UPDATE groups SET ${sets.join(', ')} WHERE id = $${values.length} AND deleted_at IS NULL RETURNING *`,
			values,
		);
		if (rows[0]) {
			this._groupBadgesCache?.clear();
		}
		return normalizeGroupRow(rows[0] || null);
	}

	async deleteGroup(groupId) {
		return this._withTransaction(async (client) => {
			const normalizedGroupId = String(groupId);
			const { rows } = await client.query(
				`UPDATE groups SET deleted_at = NOW(), updated_at = NOW()
				 WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
				[normalizedGroupId],
			);
			if (!rows[0]) return null;

			const { rows: postRows } = await client.query(
				'SELECT id FROM posts WHERE group_id = $1 FOR UPDATE',
				[normalizedGroupId],
			);
			const postIds = postRows.map((post) => Number(post.id));
			if (postIds.length > 0) {
				await client.query('UPDATE posts SET repost_to = NULL WHERE repost_to = ANY($1::int[])', [postIds]);
				await client.query('DELETE FROM likes WHERE post_id = ANY($1::int[])', [postIds]);
				await client.query('DELETE FROM stars WHERE post_id = ANY($1::int[])', [postIds]);
				await client.query('DELETE FROM reposts WHERE post_id = ANY($1::int[])', [postIds]);
				await client.query('DELETE FROM pinned_posts WHERE post_id = ANY($1::int[])', [postIds]);
				await client.query('DELETE FROM posts WHERE id = ANY($1::int[])', [postIds]);
				for (const pId of postIds) {
					this._getPostCache()?.delete(pId);
					this._getPostMetricsCache()?.delete(pId);
				}
			}

			this._groupBadgesCache?.clear();
			return normalizeGroupRow(rows[0]);
		});
	}

	async transferGroupOwnership(groupId, newOwnerId) {
		const { rows } = await this.pool.query(
			`UPDATE groups SET owner_id = $1, updated_at = NOW()
			 WHERE id = $2 AND deleted_at IS NULL RETURNING *`,
			[Number(newOwnerId), String(groupId)],
		);
		this._groupBadgesCache?.delete(Number(newOwnerId));
		return normalizeGroupRow(rows[0] || null);
	}

	async getGroupsByVisibility({ query = '', visibility = ['open', 'open_invite'], limit = 20, offset = 0 } = {}) {
		const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
		const safeOffset = Math.max(0, Number(offset) || 0);
		const visibilities = (Array.isArray(visibility) ? visibility : [visibility])
			.map((item) => String(item || '').trim())
			.filter(Boolean);
		if (visibilities.length === 0) return [];
		const values = [visibilities];
		const clauses = ['g.deleted_at IS NULL', 'g.visibility = ANY($1::text[])'];
		const normalizedQuery = String(query || '').trim().toLowerCase();
		if (normalizedQuery) {
			values.push(`%${normalizedQuery}%`);
			clauses.push(`(LOWER(g.name) LIKE $${values.length} OR LOWER(g.description) LIKE $${values.length})`);
		}
		values.push(safeLimit, safeOffset);
		const { rows } = await this.pool.query(
			`SELECT g.*, (
				SELECT COUNT(*)::int FROM group_memberships gm
				WHERE gm.group_id = g.id AND gm.status = 'active'
			) AS member_count
			FROM groups g WHERE ${clauses.join(' AND ')}
			ORDER BY g.created_at DESC, g.id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
			values,
		);
		return rows.map(normalizeGroupRow);
	}

	async getUserGroups(userId, { status = 'active', limit = 100, offset = 0 } = {}) {
		const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
		const safeOffset = Math.max(0, Number(offset) || 0);
		const { rows } = await this.pool.query(
			`SELECT g.*, gm.role_id AS membership_role_id, gm.status AS membership_status,
				gm.joined_at AS membership_joined_at, (
					SELECT COUNT(*)::int FROM group_memberships count_gm
					WHERE count_gm.group_id = g.id AND count_gm.status = 'active'
				) AS member_count
			FROM group_memberships gm
			JOIN groups g ON g.id = gm.group_id
			WHERE gm.user_id = $1 AND gm.status = $2 AND g.deleted_at IS NULL
			ORDER BY gm.joined_at DESC NULLS LAST, g.created_at DESC
			LIMIT $3 OFFSET $4`,
			[Number(userId), String(status), safeLimit, safeOffset],
		);
		return rows.map((row) => ({
			...normalizeGroupRow(row),
			membership: normalizeGroupMembershipRow({
				group_id: row.id, user_id: userId, role_id: row.membership_role_id,
				status: row.membership_status, joined_at: row.membership_joined_at,
			}),
		}));
	}

	async getMutualUserGroups(userId1, userId2, { limit = 100, offset = 0 } = {}) {
		const u1 = Number(userId1);
		const u2 = Number(userId2);
		if (!Number.isSafeInteger(u1) || !Number.isSafeInteger(u2) || u1 <= 0 || u2 <= 0) return [];
		if (u1 === u2) return this.getUserGroups(u1, { status: 'active', limit, offset });

		const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
		const safeOffset = Math.max(0, Number(offset) || 0);
		const { rows } = await this.pool.query(
			`SELECT g.*, (
				SELECT COUNT(*)::int FROM group_memberships count_gm
				WHERE count_gm.group_id = g.id AND count_gm.status = 'active'
			) AS member_count
			FROM groups g
			JOIN group_memberships gm1 ON gm1.group_id = g.id AND gm1.user_id = $1 AND gm1.status = 'active'
			JOIN group_memberships gm2 ON gm2.group_id = g.id AND gm2.user_id = $2 AND gm2.status = 'active'
			WHERE g.deleted_at IS NULL
			ORDER BY g.created_at DESC
			LIMIT $3 OFFSET $4`,
			[u1, u2, safeLimit, safeOffset],
		);
		return rows.map(normalizeGroupRow);
	}

	_getGroupBadgesCache() {
		if (!this._groupBadgesCache) {
			this._groupBadgesCache = new MemoryBoundedCache({
				maxSize: 2000,
				ttlMs: 30000,
			});
		}
		return this._groupBadgesCache;
	}

	async getUsersGroupBadgesBatch(userIds) {
		const result = new Map();
		const ids = [...new Set((userIds || []).map(Number).filter(Number.isInteger))];
		if (ids.length === 0) return result;

		const cache = this._getGroupBadgesCache();
		const missingIds = [];
		for (const id of ids) {
			const cached = cache?.get(id);
			if (cached !== undefined) {
				result.set(id, cached);
			} else {
				result.set(id, []);
				missingIds.push(id);
			}
		}

		if (missingIds.length === 0) return result;

		const { rows } = await this.pool.query(
			`WITH ranked_badges AS (
				SELECT gm.user_id, g.id AS group_id, g.name, g.icon_data,
				       ROW_NUMBER() OVER (
				           PARTITION BY gm.user_id
				           ORDER BY gm.joined_at DESC NULLS LAST, g.created_at DESC
				       ) AS rn
				FROM group_memberships gm
				JOIN groups g ON g.id = gm.group_id
				WHERE gm.user_id = ANY($1::int[])
				  AND gm.status = 'active'
				  AND g.deleted_at IS NULL
				  AND g.icon_data IS NOT NULL
				  AND g.icon_data <> ''
				  AND g.visibility IN ('open', 'open_invite')
			)
			SELECT user_id, group_id, name, icon_data
			FROM ranked_badges
			WHERE rn <= 5
			ORDER BY user_id, rn ASC`,
			[missingIds],
		);

		for (const id of missingIds) {
			result.set(id, []);
		}
		for (const row of rows) {
			const userId = Number(row.user_id);
			const list = result.get(userId) || [];
			list.push({
				id: String(row.group_id),
				name: String(row.name || ''),
				icon_data: row.icon_data,
			});
			result.set(userId, list);
		}
		for (const id of missingIds) {
			cache?.set(id, result.get(id) || []);
		}
		return result;
	}

	async createGroupRole(roleData) {
		const now = roleData.createdAt ? toIsoString(roleData.createdAt) : new Date().toISOString();
		const { rows } = await this.pool.query(
			`INSERT INTO group_roles (id, group_id, name, permissions, is_system, sort_order, created_at, updated_at)
			 VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $7) RETURNING *`,
			[
				String(roleData.id), String(roleData.groupId), String(roleData.name || ''),
				JSON.stringify(Array.isArray(roleData.permissions) ? roleData.permissions : []),
				Boolean(roleData.isSystem), Number(roleData.sortOrder) || 0, now,
			],
		);
		return normalizeGroupRoleRow(rows[0] || null);
	}

	async getGroupRoles(groupId) {
		const { rows } = await this.pool.query(
			`SELECT * FROM group_roles WHERE group_id = $1 ORDER BY sort_order ASC, name ASC, id ASC`,
			[String(groupId)],
		);
		return rows.map(normalizeGroupRoleRow);
	}

	async updateGroupRole(roleId, fields) {
		const fieldMap = { name: 'name', permissions: 'permissions', sortOrder: 'sort_order', sort_order: 'sort_order' };
		const sets = [];
		const values = [];
		const assigned = new Set();
		for (const [key, column] of Object.entries(fieldMap)) {
			if (fields[key] === undefined || assigned.has(column)) continue;
			assigned.add(column);
			if (column === 'permissions') values.push(JSON.stringify(Array.isArray(fields[key]) ? fields[key] : []));
			else if (column === 'sort_order') values.push(Number(fields[key]) || 0);
			else values.push(String(fields[key] || ''));
			sets.push(`${column} = $${values.length}${column === 'permissions' ? '::jsonb' : ''}`);
		}
		if (sets.length === 0) return null;
		sets.push('updated_at = NOW()');
		values.push(String(roleId));
		const { rows } = await this.pool.query(
			`UPDATE group_roles SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`, values,
		);
		return normalizeGroupRoleRow(rows[0] || null);
	}

	async deleteGroupRole(roleId) {
		const { rows } = await this.pool.query(`DELETE FROM group_roles WHERE id = $1 RETURNING *`, [String(roleId)]);
		return normalizeGroupRoleRow(rows[0] || null);
	}

	async getGroupMembership(groupId, userId) {
		const { rows } = await this.pool.query(
			`SELECT * FROM group_memberships WHERE group_id = $1 AND user_id = $2 LIMIT 1`,
			[String(groupId), Number(userId)],
		);
		return normalizeGroupMembershipRow(rows[0] || null);
	}

	async getGroupMemberships(groupId, { status = null, limit = 100, offset = 0 } = {}) {
		const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
		const safeOffset = Math.max(0, Number(offset) || 0);
		const values = [String(groupId)];
		let where = 'group_id = $1';
		if (status) { values.push(String(status)); where += ` AND status = $${values.length}`; }
		values.push(safeLimit, safeOffset);
		const { rows } = await this.pool.query(
			`SELECT * FROM group_memberships WHERE ${where}
			 ORDER BY joined_at ASC NULLS LAST, user_id ASC LIMIT $${values.length - 1} OFFSET $${values.length}`,
			values,
		);
		return rows.map(normalizeGroupMembershipRow);
	}

	async createGroupMembership(membershipData) {
		const now = membershipData.updatedAt ? toIsoString(membershipData.updatedAt) : new Date().toISOString();
		const joinedAt = membershipData.joinedAt ? toIsoString(membershipData.joinedAt) : null;
		const { rows } = await this.pool.query(
			`INSERT INTO group_memberships (group_id, user_id, role_id, status, joined_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT (group_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id, status = EXCLUDED.status,
			 joined_at = EXCLUDED.joined_at, updated_at = EXCLUDED.updated_at RETURNING *`,
			[String(membershipData.groupId), Number(membershipData.userId), membershipData.roleId ?? null,
				String(membershipData.status || 'active'), joinedAt, now],
		);
		this._groupBadgesCache?.delete(Number(membershipData.userId));
		return normalizeGroupMembershipRow(rows[0] || null);
	}

	async updateGroupMembership(groupId, userId, fields) {
		const sets = [];
		const values = [];
		if (fields.roleId !== undefined || fields.role_id !== undefined) {
			values.push(fields.roleId ?? fields.role_id ?? null); sets.push(`role_id = $${values.length}`);
		}
		if (fields.status !== undefined) { values.push(String(fields.status)); sets.push(`status = $${values.length}`); }
		if (fields.joinedAt !== undefined || fields.joined_at !== undefined) {
			values.push(toIsoString(fields.joinedAt ?? fields.joined_at)); sets.push(`joined_at = $${values.length}`);
		}
		if (sets.length === 0) return this.getGroupMembership(groupId, userId);
		sets.push('updated_at = NOW()');
		values.push(String(groupId), Number(userId));
		const { rows } = await this.pool.query(
			`UPDATE group_memberships SET ${sets.join(', ')} WHERE group_id = $${values.length - 1} AND user_id = $${values.length} RETURNING *`, values,
		);
		this._groupBadgesCache?.delete(Number(userId));
		return normalizeGroupMembershipRow(rows[0] || null);
	}

	async createGroupInvite(inviteData) {
		const now = inviteData.createdAt ? toIsoString(inviteData.createdAt) : new Date().toISOString();
		const { rows } = await this.pool.query(
			`INSERT INTO group_invites (id, group_id, inviter_id, invitee_id, status, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
			[String(inviteData.id), String(inviteData.groupId), Number(inviteData.inviterId), Number(inviteData.inviteeId),
				String(inviteData.status || 'pending'), now],
		);
		return normalizeGroupInviteRow(rows[0] || null);
	}

	async getGroupInvite(inviteId) {
		const { rows } = await this.pool.query(`SELECT * FROM group_invites WHERE id = $1 LIMIT 1`, [String(inviteId)]);
		return normalizeGroupInviteRow(rows[0] || null);
	}

	async getGroupInvites({ groupId = null, inviteeId = null, status = null, limit = 100, offset = 0 } = {}) {
		const values = [];
		const clauses = [];
		if (groupId != null) { values.push(String(groupId)); clauses.push(`group_id = $${values.length}`); }
		if (inviteeId != null) { values.push(Number(inviteeId)); clauses.push(`invitee_id = $${values.length}`); }
		if (status != null) { values.push(String(status)); clauses.push(`status = $${values.length}`); }
		if (clauses.length === 0) return [];
		values.push(Math.max(1, Math.min(Number(limit) || 100, 200)), Math.max(0, Number(offset) || 0));
		const { rows } = await this.pool.query(
			`SELECT * FROM group_invites WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC
			 LIMIT $${values.length - 1} OFFSET $${values.length}`,
			values,
		);
		return rows.map(normalizeGroupInviteRow);
	}

	async updateGroupInvite(inviteId, fields) {
		const sets = [];
		const values = [];
		if (fields.status !== undefined) { values.push(String(fields.status)); sets.push(`status = $${values.length}`); }
		if (fields.respondedAt !== undefined || fields.responded_at !== undefined) {
			values.push(toIsoString(fields.respondedAt ?? fields.responded_at)); sets.push(`responded_at = $${values.length}`);
		} else if (fields.status && fields.status !== 'pending') { sets.push('responded_at = NOW()'); }
		if (sets.length === 0) return this.getGroupInvite(inviteId);
		values.push(String(inviteId));
		const { rows } = await this.pool.query(
			`UPDATE group_invites SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`, values,
		);
		return normalizeGroupInviteRow(rows[0] || null);
	}

	async createGroupJoinRequest(requestData) {
		const now = requestData.createdAt ? toIsoString(requestData.createdAt) : new Date().toISOString();
		const { rows } = await this.pool.query(
			`INSERT INTO group_join_requests (id, group_id, user_id, status, created_at)
			 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
			[String(requestData.id), String(requestData.groupId), Number(requestData.userId), String(requestData.status || 'pending'), now],
		);
		return normalizeGroupJoinRequestRow(rows[0] || null);
	}

	async getGroupJoinRequest(requestId) {
		const { rows } = await this.pool.query(`SELECT * FROM group_join_requests WHERE id = $1 LIMIT 1`, [String(requestId)]);
		return normalizeGroupJoinRequestRow(rows[0] || null);
	}

	async getGroupJoinRequests({ groupId = null, userId = null, status = null, limit = 100, offset = 0 } = {}) {
		const values = [];
		const clauses = [];
		if (groupId != null) { values.push(String(groupId)); clauses.push(`group_id = $${values.length}`); }
		if (userId != null) { values.push(Number(userId)); clauses.push(`user_id = $${values.length}`); }
		if (status != null) { values.push(String(status)); clauses.push(`status = $${values.length}`); }
		if (clauses.length === 0) return [];
		values.push(Math.max(1, Math.min(Number(limit) || 100, 200)), Math.max(0, Number(offset) || 0));
		const { rows } = await this.pool.query(
			`SELECT * FROM group_join_requests WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC
			 LIMIT $${values.length - 1} OFFSET $${values.length}`,
			values,
		);
		return rows.map(normalizeGroupJoinRequestRow);
	}

	async updateGroupJoinRequest(requestId, fields) {
		const sets = [];
		const values = [];
		if (fields.status !== undefined) { values.push(String(fields.status)); sets.push(`status = $${values.length}`); }
		if (fields.reviewedBy !== undefined || fields.reviewed_by !== undefined) {
			values.push(fields.reviewedBy ?? fields.reviewed_by ?? null); sets.push(`reviewed_by = $${values.length}`);
		}
		if (fields.reviewedAt !== undefined || fields.reviewed_at !== undefined) {
			values.push(toIsoString(fields.reviewedAt ?? fields.reviewed_at)); sets.push(`reviewed_at = $${values.length}`);
		} else if (fields.status && fields.status !== 'pending') { sets.push('reviewed_at = NOW()'); }
		if (sets.length === 0) return this.getGroupJoinRequest(requestId);
		values.push(String(requestId));
		const { rows } = await this.pool.query(
			`UPDATE group_join_requests SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`, values,
		);
		return normalizeGroupJoinRequestRow(rows[0] || null);
	}

	async getGroupPostIds(groupId, { limit = 30, offset = 0, beforeId = null, authorId = null, subType = 'posts_only', cursor = null, cursorCreatedAt = null, cursorId = null } = {}) {
		const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
		const values = [String(groupId)];
		const clauses = ['group_id = $1', subType === 'replies_only' ? 'reply_to IS NOT NULL' : 'reply_to IS NULL'];
		if (authorId != null && authorId !== '' && Number.isInteger(Number(authorId)) && Number(authorId) >= 0) {
			values.push(Number(authorId)); clauses.push(`user_id = $${values.length}`);
		}
		const decodedCursor = cursorCreatedAt && cursorId
			? { createdAt: cursorCreatedAt, id: Number(cursorId) }
			: (typeof cursor === 'string' && cursor.trim() ? decodePostCursor(cursor.trim()) : null);

		if (decodedCursor) {
			values.push(decodedCursor.createdAt, decodedCursor.id);
			clauses.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
		} else if (Number.isInteger(Number(beforeId)) && Number(beforeId) > 0) {
			values.push(Number(beforeId)); clauses.push(`id < $${values.length}`);
		}
		values.push(safeLimit + 1);
		const limitIndex = values.length;
		let offsetSql = '';
		if (!decodedCursor && !clauses.some((clause) => clause.startsWith('id <'))) {
			values.push(Math.max(0, Number(offset) || 0)); offsetSql = ` OFFSET $${values.length}`;
		}
		const { rows } = await this.pool.query(
			`SELECT id, created_at FROM posts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${limitIndex}${offsetSql}`,
			values,
		);
		const selectedRows = rows.slice(0, safeLimit);
		const ids = selectedRows.map((row) => Number(row.id));
		const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null;
		const nextCursor = rows.length > safeLimit && lastRow
			? (encodePostCursor(lastRow) || ids[ids.length - 1])
			: null;
		return { ids, has_more: rows.length > safeLimit, next_cursor: nextCursor };
	}

	async getGroupAnnouncementPostIds(groupId, params = {}) {
		const safeLimit = Math.max(1, Math.min(Number(params.limit) || 30, 100));
		const values = [String(groupId)];
		const clauses = ['group_id = $1', 'group_announcement = true'];
		const decodedCursor = params.cursorCreatedAt && params.cursorId
			? { createdAt: params.cursorCreatedAt, id: Number(params.cursorId) }
			: (typeof params.cursor === 'string' && params.cursor.trim() ? decodePostCursor(params.cursor.trim()) : null);

		if (decodedCursor) {
			values.push(decodedCursor.createdAt, decodedCursor.id);
			clauses.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
		} else if (Number.isInteger(Number(params.beforeId)) && Number(params.beforeId) > 0) {
			values.push(Number(params.beforeId)); clauses.push(`id < $${values.length}`);
		}
		values.push(safeLimit + 1);
		const limitIndex = values.length;
		let offsetSql = '';
		if (!decodedCursor && !clauses.some((clause) => clause.startsWith('id <'))) {
			values.push(Math.max(0, Number(params.offset) || 0)); offsetSql = ` OFFSET $${values.length}`;
		}
		const { rows } = await this.pool.query(
			`SELECT id, created_at FROM posts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${limitIndex}${offsetSql}`,
			values,
		);
		const selectedRows = rows.slice(0, safeLimit);
		const ids = selectedRows.map((row) => Number(row.id));
		const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null;
		const nextCursor = rows.length > safeLimit && lastRow
			? (encodePostCursor(lastRow) || ids[ids.length - 1])
			: null;
		return { ids, has_more: rows.length > safeLimit, next_cursor: nextCursor };
	}

	async searchGroupPostIds(userId, query, { limit = 30, offset = 0, beforeId = null, cursor = null, cursorCreatedAt = null, cursorId = null } = {}) {
		const normalizedQuery = String(query || '').trim().toLowerCase();
		if (!normalizedQuery) return { ids: [], has_more: false, next_cursor: null };
		const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
		const values = [Number(userId), `%${normalizedQuery}%`];
		const clauses = ['gm.user_id = $1', "gm.status = 'active'", 'p.group_id = gm.group_id', '(LOWER(COALESCE(p.view_content, p.content)) LIKE $2 OR LOWER(p.content) LIKE $2)'];
		const decodedCursor = cursorCreatedAt && cursorId
			? { createdAt: cursorCreatedAt, id: Number(cursorId) }
			: (typeof cursor === 'string' && cursor.trim() ? decodePostCursor(cursor.trim()) : null);

		if (decodedCursor) {
			values.push(decodedCursor.createdAt, decodedCursor.id);
			clauses.push(`(p.created_at < $${values.length - 1} OR (p.created_at = $${values.length - 1} AND p.id < $${values.length}))`);
		} else if (Number.isInteger(Number(beforeId)) && Number(beforeId) > 0) {
			values.push(Number(beforeId)); clauses.push(`p.id < $${values.length}`);
		}
		values.push(safeLimit + 1);
		const limitIndex = values.length;
		let offsetSql = '';
		if (!decodedCursor && !clauses.some((clause) => clause.startsWith('p.id <'))) {
			values.push(Math.max(0, Number(offset) || 0)); offsetSql = ` OFFSET $${values.length}`;
		}
		const { rows } = await this.pool.query(
			`SELECT p.id, p.created_at FROM posts p JOIN group_memberships gm ON ${clauses.join(' AND ')}
			 ORDER BY p.created_at DESC, p.id DESC LIMIT $${limitIndex}${offsetSql}`,
			values,
		);
		const selectedRows = rows.slice(0, safeLimit);
		const ids = selectedRows.map((row) => Number(row.id));
		const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null;
		const nextCursor = rows.length > safeLimit && lastRow
			? (encodePostCursor(lastRow) || ids[ids.length - 1])
			: null;
		return { ids, has_more: rows.length > safeLimit, next_cursor: nextCursor };
	}

	// ==================== Posts ====================

	async createPost(postData) {
		const now = postData.createdAt ? toIsoString(postData.createdAt) : new Date().toISOString();
		const viewContent = postData.viewContent != null
			? String(postData.viewContent)
			: (postData.view_content != null ? String(postData.view_content) : extractViewContent(postData.content || ''));
		const replyControl = String(postData.replyControl ?? postData.reply_control ?? 'everyone');
		const hasExplicitId = postData.id != null && Number.isSafeInteger(Number(postData.id)) && Number(postData.id) > 0;

		const values = [
			Number(postData.userId),
			String(postData.content || ''),
			viewContent,
			postData.attachments ? JSON.stringify(postData.attachments) : null,
			Boolean(postData.mask),
			Boolean(postData.lock),
			Boolean(postData.announcement),
			(postData.replyTo ?? postData.reply_to ?? postData.reply_id) ? Number(postData.replyTo ?? postData.reply_to ?? postData.reply_id) : null,
			(postData.repostTo ?? postData.repost_to ?? postData.repost_id) ? Number(postData.repostTo ?? postData.repost_to ?? postData.repost_id) : null,
			JSON.stringify(normalizePostTags(postData.tags)),
			postData.tagsGeneratedAt ? toIsoString(postData.tagsGeneratedAt) : null,
			postData.groupId ?? postData.group_id ?? null,
			Boolean(postData.groupAnnouncement ?? postData.group_announcement),
			replyControl,
			now,
		];

		const insertQuery = hasExplicitId
			? `INSERT INTO posts (id, user_id, content, view_content, attachments, mask, lock, announcement, reply_to, repost_to, tags, tags_generated_at, group_id, group_announcement, reply_control, created_at)
			   VALUES ($16, $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15)
			   RETURNING *`
			: `INSERT INTO posts (user_id, content, view_content, attachments, mask, lock, announcement, reply_to, repost_to, tags, tags_generated_at, group_id, group_announcement, reply_control, created_at)
			   VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15)
			   RETURNING *`;

		if (hasExplicitId) {
			values.push(Number(postData.id));
		}

		const createdPost = await this._withTransaction(async (client) => {
			const { rows } = await client.query(insertQuery, values);
			const post = normalizePostRow(rows[0] || null);
			if (post) {
				await this.enqueuePostEvent(
					'post.created',
					{ postId: Number(post.id), userId: Number(post.userId) },
					{ postId: Number(post.id), client },
				);
				// reply/repost カウント更新は並列実行
				await Promise.all([
					post.replyTo
						? client.query('UPDATE posts SET reply_count = reply_count + 1 WHERE id = $1', [Number(post.replyTo)])
						: null,
					post.repostTo
						? client.query('UPDATE posts SET repost_count = repost_count + 1 WHERE id = $1', [Number(post.repostTo)])
						: null,
				].filter(Boolean));
				if (post.replyTo) {
					const parentId = Number(post.replyTo);
					const cachedParent = this._getPostCache()?.get(parentId);
					if (cachedParent) {
						const replyCount = (Number(cachedParent.reply_count ?? cachedParent.replyCount) || 0) + 1;
						this._getPostCache()?.set(parentId, {
							...cachedParent,
							reply_count: replyCount,
							replyCount,
						});
					}
					const cachedMetrics = this._getPostMetricsCache()?.get(parentId);
					if (cachedMetrics) {
						this._updateCachedPostMetrics(parentId, {
							reply_count: (Number(cachedMetrics.reply_count) || 0) + 1,
						});
					}
				}
				if (post.repostTo) {
					const parentId = Number(post.repostTo);
					const cachedParent = this._getPostCache()?.get(parentId);
					if (cachedParent) {
						const repostCount = (Number(cachedParent.repost_count ?? cachedParent.repostCount) || 0) + 1;
						this._getPostCache()?.set(parentId, {
							...cachedParent,
							repost_count: repostCount,
							repostCount,
						});
					}
					const cachedMetrics = this._getPostMetricsCache()?.get(parentId);
					if (cachedMetrics) {
						this._updateCachedPostMetrics(parentId, {
							repost_count: (Number(cachedMetrics.repost_count) || 0) + 1,
						});
					}
				}
				this._getPostCache()?.set(post.id, post);
			}
			return post;
		});
		if (createdPost?.userId) {
			this._invalidateProfileStatsCache(createdPost.userId);
		}
		return createdPost;
	}

	async processPostCreatedEvent(event) {
		const postId = Number(event?.post_id ?? event?.payload?.postId);
		if (!Number.isSafeInteger(postId) || postId <= 0) return;
		const post = await this.getPostById(postId);
		if (!post) return;
		const client = await this.pool.connect();
		try {
			await this._adjustUserKeywordAffinitiesForTags(client, post.userId, post.tags, 1);
		} finally {
			client.release();
		}
	}

	async enqueuePostEvent(eventType, payload, { postId = null, availableAt = null, client = null } = {}) {
		const executor = client || this.pool;
		const result = await executor.query(
			`INSERT INTO post_events (event_type, post_id, payload, available_at)
			 VALUES ($1, $2, $3::jsonb, COALESCE($4, NOW()))
			 RETURNING *`,
			[String(eventType), postId == null ? null : Number(postId), JSON.stringify(payload || {}), availableAt],
		);
		return result.rows[0] || null;
	}

	async claimPostEvents(limit = 50, workerId = null) {
		const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
		return this._withTransaction(async (client) => {
			const { rows } = await client.query(
				`WITH candidates AS (
					SELECT id FROM post_events
					WHERE (status = 'pending' AND available_at <= NOW())
					   OR (status = 'processing' AND locked_at < NOW() - INTERVAL '60 seconds')
					ORDER BY available_at ASC, id ASC
					FOR UPDATE SKIP LOCKED
					LIMIT $1
				)
				UPDATE post_events e
				SET status = 'processing', attempts = e.attempts + 1,
				    locked_at = NOW(), worker_id = $2
				FROM candidates c
				WHERE e.id = c.id
				RETURNING e.*`,
				[safeLimit, workerId == null ? null : String(workerId)],
			);
			return rows;
		});
	}

	async completePostEvent(eventId) {
		const result = await this.pool.query(
			`UPDATE post_events
			 SET status = 'completed', locked_at = NULL, processed_at = NOW(), last_error = NULL
			 WHERE id = $1 AND status = 'processing'`,
			[Number(eventId)],
		);
		return result.rowCount > 0;
	}

	async failPostEvent(eventId, error, retryAt = null) {
		const result = await this.pool.query(
			`UPDATE post_events
			 SET status = CASE WHEN $2::timestamptz IS NULL THEN 'failed' ELSE 'pending' END,
			     available_at = COALESCE($2::timestamptz, available_at), locked_at = NULL,
			     last_error = LEFT($3, 2000)
			 WHERE id = $1 AND status = 'processing'`,
			[Number(eventId), toIsoString(retryAt), String(error?.message || error || 'Unknown error')],
		);
		return result.rowCount > 0;
	}

	_getPostCache() {
		if (!this._postCache) {
			const cacheCfg = appConfig.cache || {};
			if (cacheCfg.postCacheEnabled !== false) {
				this._postCache = new MemoryBoundedCache({
					maxSize: cacheCfg.postCacheMaxSize || 1000,
					ttlMs: cacheCfg.postCacheTtlMs || 1800000,
					maxHeapMb: cacheCfg.memoryCacheMaxHeapMb || 0,
				});
			}
		}
		return this._postCache;
	}

	_getPostMetricsCache() {
		if (!this._postMetricsCache) {
			this._postMetricsCache = new MemoryBoundedCache({
				maxSize: 4000,
				ttlMs: 3600000,
				maxHeapMb: appConfig.cache?.memoryCacheMaxHeapMb || 0,
			});
		}
		return this._postMetricsCache;
	}

	_updateCachedPostMetrics(postId, metrics) {
		const cache = this._getPostMetricsCache();
		const normalizedPostId = Number(postId);
		if (!Number.isSafeInteger(normalizedPostId) || !cache) return;
		cache.updateWhere(
			(_value, key) => Number(key) === normalizedPostId,
			(value) => ({ ...value, ...metrics, post_id: normalizedPostId }),
		);
	}

	_updateCachedPostReaction(postId, userId, type, active) {
		const cache = this._getPostMetricsCache();
		const normalizedPostId = Number(postId);
		const normalizedUserId = Number(userId);
		const cached = cache?.get(normalizedPostId);
		if (!cached || !cached.reactionStateReady || !Number.isSafeInteger(normalizedUserId)) return;
		const key = type === 'star' ? 'starredBy' : 'likedBy';
		const users = new Set(cached[key] || []);
		if (active) users.add(normalizedUserId);
		else users.delete(normalizedUserId);
		cache.set(normalizedPostId, { ...cached, [key]: [...users] });
	}

	async getPostById(id) {
		if (id == null) return null;
		const postId = Number(id);
		if (!Number.isSafeInteger(postId) || postId <= 0) return null;

		const cache = this._getPostCache();
		const cached = cache?.get(postId);
		if (cached) return cached;

		const { rows } = await this.pool.query(
			`SELECT p.*, u.id AS author_id, u.name AS author_name, u.scid AS author_scid, u.handle AS author_handle, u.icon_data AS author_icon_data, u.verify AS author_verify, u.admin AS author_admin, u.settings AS author_settings, u.block AS author_block, u.created_at AS author_created_at
			 FROM posts p
			 LEFT JOIN users u ON u.id = p.user_id
			 WHERE p.id = $1`,
			[postId],
		);
		const post = normalizePostRow(rows[0] || null);
		if (post) {
			if (post.author) this._setCachedUser(post.author);
			cache?.set(postId, post);
		}
		return post;
	}

	async getPostsByIds(postIds) {
		const ids = [...new Set((postIds || []).map(Number).filter(Number.isSafeInteger))];
		if (ids.length === 0) return [];

		const cache = this._getPostCache();
		const postMap = new Map();
		const missingIds = [];

		for (const id of ids) {
			const cached = cache?.get(id);
			if (cached) {
				postMap.set(id, cached);
			} else {
				missingIds.push(id);
			}
		}

		if (missingIds.length > 0) {
			const { rows } = await this.pool.query(
				`SELECT p.*, u.id AS author_id, u.name AS author_name, u.scid AS author_scid, u.handle AS author_handle, u.icon_data AS author_icon_data, u.verify AS author_verify, u.admin AS author_admin, u.settings AS author_settings, u.block AS author_block, u.created_at AS author_created_at
				 FROM posts p
				 LEFT JOIN users u ON u.id = p.user_id
				 WHERE p.id = ANY($1::int[])`,
				[missingIds],
			);
			for (const row of rows) {
				const post = normalizePostRow(row);
				if (post) {
					if (post.author) this._setCachedUser(post.author);
					cache?.set(post.id, post);
					postMap.set(post.id, post);
				}
			}
		}

		return ids.map((id) => postMap.get(id)).filter(Boolean);
	}

	/**
	 * WITH RECURSIVE で 1 クエリで祖先ポストを全取得。
	 * 返り値は [直接の親, ..., ルートポスト] の配列。
	 * PostgreSQL・CockroachDB 両方互換。
	 */
	async getPostAncestors(postId, maxDepth = 20) {
		const rootId = Number(postId);
		if (!Number.isSafeInteger(rootId) || rootId <= 0) return [];
		const limit = Math.min(50, Math.max(1, Number(maxDepth) || 20));

		// WITH RECURSIVE: 起点を direct parent、JOIN で上方向に再帰
		// p.* に depth 計算列を含める形ではなく、depth は CTE の独立列として管理し
		// 外側 SELECT では posts の実カラムのみを取得
		const { rows } = await this.pool.query(
			`WITH RECURSIVE ancestors(post_id, anc_depth) AS (
			   SELECT reply_to, 1
			   FROM posts
			   WHERE id = $1 AND reply_to IS NOT NULL
			 UNION ALL
			   SELECT p.reply_to, a.anc_depth + 1
			   FROM posts p
			   JOIN ancestors a ON p.id = a.post_id
			   WHERE p.reply_to IS NOT NULL AND a.anc_depth < $2
			 )
			 SELECT p.*, u.id AS author_id, u.name AS author_name, u.scid AS author_scid, u.handle AS author_handle, u.icon_data AS author_icon_data, u.verify AS author_verify, u.admin AS author_admin, u.settings AS author_settings, u.block AS author_block, u.created_at AS author_created_at
			 FROM posts p
			 JOIN ancestors a ON p.id = a.post_id
			 LEFT JOIN users u ON u.id = p.user_id
			 ORDER BY a.anc_depth`,
			[rootId, limit],
		);
		const cache = this._getPostCache();
		return rows.map((row) => {
			const post = normalizePostRow(row);
			if (post) {
				if (post.author) this._setCachedUser(post.author);
				cache?.set(post.id, post);
			}
			return post;
		}).filter(Boolean);
	}

	async getPostReferencesByIds(postIds, maxDepth = 2) {
		const rootIds = [...new Set((postIds || []).map(Number)
			.filter((id) => Number.isSafeInteger(id) && id > 0))];
		const normalizedMaxDepth = Math.min(4, Math.max(0, Number(maxDepth) || 0));
		if (rootIds.length === 0) return [];

		const cache = this._getPostCache();
		const resolved = new Map();
		let currentIds = rootIds;
		let depth = 0;

		while (currentIds.length > 0 && depth <= normalizedMaxDepth) {
			const nextIds = new Set();
			const uncachedIds = [];

			for (const id of currentIds) {
				if (resolved.has(id)) continue;
				const cached = cache?.get(id);
				if (cached) {
					resolved.set(cached.id, cached);
					if (depth < normalizedMaxDepth) {
						if (cached.replyTo && !resolved.has(cached.replyTo)) nextIds.add(cached.replyTo);
						if (cached.repostTo && !resolved.has(cached.repostTo)) nextIds.add(cached.repostTo);
					}
				} else {
					uncachedIds.push(id);
				}
			}

			if (uncachedIds.length > 0) {
				const { rows } = await this.pool.query(
					`SELECT p.*, u.id AS author_id, u.name AS author_name, u.scid AS author_scid, u.handle AS author_handle, u.icon_data AS author_icon_data, u.verify AS author_verify, u.admin AS author_admin, u.settings AS author_settings, u.block AS author_block, u.created_at AS author_created_at
					 FROM posts p
					 LEFT JOIN users u ON u.id = p.user_id
					 WHERE p.id = ANY($1::int[])`,
					[uncachedIds],
				);
				for (const row of rows) {
					const post = normalizePostRow(row);
					if (post) {
						if (post.author) this._setCachedUser(post.author);
						cache?.set(post.id, post);
						resolved.set(post.id, post);
						if (depth < normalizedMaxDepth) {
							if (post.replyTo && !resolved.has(post.replyTo)) nextIds.add(post.replyTo);
							if (post.repostTo && !resolved.has(post.repostTo)) nextIds.add(post.repostTo);
						}
					}
				}
			}

			currentIds = [...nextIds];
			depth += 1;
		}

		return Array.from(resolved.values());
	}

	async auditAndHealPostCounters(postId) {
		const id = Number(postId);
		if (!Number.isSafeInteger(id) || id <= 0) return null;

		return this._withTransaction(async (client) => {
			const { rows } = await client.query(
				`UPDATE posts
				 SET like_count = (SELECT COUNT(*)::int FROM likes WHERE post_id = $1),
				     star_count = (SELECT COUNT(*)::int FROM stars WHERE post_id = $1),
				     repost_count = (SELECT COUNT(*)::int FROM reposts WHERE post_id = $1),
				     reply_count = (SELECT COUNT(*)::int FROM posts WHERE reply_to = $1)
				 WHERE id = $1
				 RETURNING *`,
				[id],
			);
			const post = normalizePostRow(rows[0] || null);
			if (post) {
				this._getPostCache()?.set(post.id, post);
			}
			return post;
		});
	}

	async auditAndHealUserCounters(userId) {
		const id = Number(userId);
		if (!Number.isSafeInteger(id) || id <= 0) return null;

		const { rows } = await this.pool.query(
			`SELECT
				(SELECT COUNT(*)::bigint FROM follows WHERE following_id = $1) AS follower_count,
				(SELECT COUNT(*)::bigint FROM follows WHERE follower_id = $1) AS following_count,
				(SELECT COUNT(*)::bigint FROM posts WHERE user_id = $1 AND repost_to IS NULL) AS post_count`,
			[id],
		);

		return {
			userId: id,
			followerCount: Number(rows[0]?.follower_count || 0),
			followingCount: Number(rows[0]?.following_count || 0),
			postCount: Number(rows[0]?.post_count || 0),
		};
	}

	async getPostMetricsBatch(postIds, currentUserId = null) {
		const ids = [...new Set((postIds || []).map(Number)
			.filter((id) => Number.isSafeInteger(id) && id > 0))];
		if (ids.length === 0) return [];

		const parsedViewerId = Number(currentUserId);
		const viewerId = Number.isSafeInteger(parsedViewerId) && parsedViewerId > 0
			? parsedViewerId
			: null;

		const metricsCache = this._getPostMetricsCache();
		const metricsByPostId = new Map();
		const missingIds = [];
		const reactionOnlyIds = [];
		for (const id of ids) {
			const cached = metricsCache?.get(id);
			if (cached && viewerId == null) {
				metricsByPostId.set(id, {
					...cached,
					liked_by_me: false,
					starred_by_me: false,
				});
			} else if (cached?.reactionStateReady) {
				metricsByPostId.set(id, {
					...cached,
					liked_by_me: viewerId != null ? cached.likedBy?.includes(viewerId) : false,
					starred_by_me: viewerId != null ? cached.starredBy?.includes(viewerId) : false,
				});
			} else if (cached?.countersReady && viewerId != null) {
				metricsByPostId.set(id, {
					...cached,
					liked_by_me: false,
					starred_by_me: false,
				});
				reactionOnlyIds.push(id);
			} else {
				missingIds.push(id);
			}
		}

		if (reactionOnlyIds.length > 0) {
			const reactionQuery = `SELECT p.id AS post_id,
				(EXISTS (SELECT 1 FROM likes l_viewer WHERE l_viewer.post_id = p.id AND l_viewer.user_id = $2)) AS liked_by_me,
				(EXISTS (SELECT 1 FROM stars s_viewer WHERE s_viewer.post_id = p.id AND s_viewer.user_id = $2)) AS starred_by_me
				FROM posts p
				WHERE p.id = ANY($1::int[])`;
			const { rows: reactionRows } = await this.pool.query(reactionQuery, [reactionOnlyIds, viewerId]);
			for (const row of reactionRows) {
				const id = Number(row.post_id);
				const current = metricsByPostId.get(id);
				if (current) {
					metricsByPostId.set(id, {
						...current,
						liked_by_me: Boolean(row.liked_by_me),
						starred_by_me: Boolean(row.starred_by_me),
					});
				}
			}
		}
		if (missingIds.length === 0) return ids.map((id) => metricsByPostId.get(id));

		const viewerReactionColumns = viewerId == null
			? `FALSE AS liked_by_me, FALSE AS starred_by_me`
			: `(EXISTS (SELECT 1 FROM likes l_viewer WHERE l_viewer.post_id = p.id AND l_viewer.user_id = $2)) AS liked_by_me,
				(EXISTS (SELECT 1 FROM stars s_viewer WHERE s_viewer.post_id = p.id AND s_viewer.user_id = $2)) AS starred_by_me`;
		const query = `SELECT
				p.id AS post_id,
				COALESCE(p.like_count, 0)::int AS like_count,
				COALESCE(p.star_count, 0)::int AS star_count,
				COALESCE(p.repost_count, 0)::int AS repost_count,
				COALESCE(p.reply_count, 0)::int AS reply_count,
				${viewerReactionColumns}
			   FROM posts p
			   WHERE p.id = ANY($1::int[])`;

		const params = viewerId == null ? [missingIds] : [missingIds, viewerId];
		const { rows } = await this.pool.query(query, params);
		const rowMap = new Map(rows.map((r) => [Number(r.post_id), r]));
		for (const id of missingIds) {
			const row = rowMap.get(id);
			const value = {
				post_id: id,
				like_count: Math.max(0, Number(row?.like_count) || 0),
				star_count: Math.max(0, Number(row?.star_count) || 0),
				repost_count: Math.max(0, Number(row?.repost_count) || 0),
				reply_count: Math.max(0, Number(row?.reply_count) || 0),
				likedBy: [],
				starredBy: [],
				reactionStateReady: false,
				countersReady: true,
			};
			metricsByPostId.set(id, {
				...value,
				liked_by_me: viewerId != null ? Boolean(row?.liked_by_me) : false,
				starred_by_me: viewerId != null ? Boolean(row?.starred_by_me) : false,
			});
			metricsCache?.set(id, value);
		}
		return ids.map((id) => {
			return metricsByPostId.get(id);
		});
	}

	async getViewerPostReactions(postIds, currentUserId) {
		const ids = [...new Set((postIds || []).map(Number)
			.filter((id) => Number.isSafeInteger(id) && id > 0))];
		const viewerId = Number(currentUserId);
		if (ids.length === 0 || !Number.isSafeInteger(viewerId) || viewerId <= 0) return [];
		const { rows } = await this.pool.query(
			`SELECT requested.post_id,
				EXISTS (SELECT 1 FROM likes WHERE post_id = requested.post_id AND user_id = $2) AS liked_by_me,
				EXISTS (SELECT 1 FROM stars WHERE post_id = requested.post_id AND user_id = $2) AS starred_by_me
			 FROM unnest($1::int[]) AS requested(post_id)`,
			[ids, viewerId],
		);
		return rows;
	}

	async updatePost(postId, fields) {
		const sets = [];
		const values = [];
		if (fields.content !== undefined) {
			values.push(fields.content);
			sets.push(`content = $${values.length}`);
			const viewContent = fields.viewContent != null
				? String(fields.viewContent)
				: (fields.view_content != null ? String(fields.view_content) : extractViewContent(fields.content || ''));
			values.push(viewContent);
			sets.push(`view_content = $${values.length}`);
		} else if (fields.viewContent !== undefined || fields.view_content !== undefined) {
			const viewContent = String(fields.viewContent ?? fields.view_content ?? '');
			values.push(viewContent);
			sets.push(`view_content = $${values.length}`);
		}
		if (fields.tags !== undefined) {
			values.push(JSON.stringify(normalizePostTags(fields.tags)));
			sets.push(`tags = $${values.length}::jsonb`);
		}
		if (fields.tagsGeneratedAt !== undefined) {
			values.push(fields.tagsGeneratedAt ? toIsoString(fields.tagsGeneratedAt) : null);
			sets.push(`tags_generated_at = $${values.length}`);
		}
		if (fields.attachments !== undefined) {
			values.push(fields.attachments ? JSON.stringify(fields.attachments) : null);
			sets.push(`attachments = $${values.length}::jsonb`);
		}
		if (fields.mask !== undefined) {
			values.push(Boolean(fields.mask));
			sets.push(`mask = $${values.length}`);
		}
		if (fields.lock !== undefined) {
			values.push(Boolean(fields.lock));
			sets.push(`lock = $${values.length}`);
		}
		if (fields.reply_control !== undefined || fields.replyControl !== undefined) {
			values.push(String(fields.reply_control ?? fields.replyControl ?? 'everyone'));
			sets.push(`reply_control = $${values.length}`);
		}
		if (sets.length === 0) {
			return this.getPostById(postId);
		}
		return this._withTransaction(async (client) => {
			const existingResult = await client.query(
				'SELECT user_id, tags FROM posts WHERE id = $1 FOR UPDATE',
				[Number(postId)],
			);
			const existing = existingResult.rows[0];
			if (!existing) return null;
			const updateValues = [...values, Number(postId)];
			const { rows } = await client.query(
				`UPDATE posts SET ${sets.join(', ')} WHERE id = $${updateValues.length} RETURNING *`,
				updateValues,
			);
			const updated = normalizePostRow(rows[0] || null);
			if (updated && fields.tags !== undefined) {
				await this._adjustUserKeywordAffinitiesForTags(client, existing.user_id, existing.tags, -1);
				await this._adjustUserKeywordAffinitiesForTags(client, existing.user_id, updated.tags, 1);
			}
			if (updated) {
				this._getPostCache()?.set(updated.id, updated);
			}
			return updated;
		});
	}

	async deletePost(postId, userId) {
		const targetId = Number(postId);
		this._getPostCache()?.delete(targetId);
		this._getPostMetricsCache()?.delete(targetId);
		return this._withTransaction(async (client) => {
			const { rows } = await client.query('SELECT user_id, reply_to, repost_to FROM posts WHERE id = $1 FOR UPDATE', [targetId]);
			if (!rows[0] || Number(rows[0].user_id) !== Number(userId)) {
				return false;
			}
			const post = rows[0];
			if (post.reply_to) {
				const parentId = Number(post.reply_to);
				await client.query('UPDATE posts SET reply_count = GREATEST(0, reply_count - 1) WHERE id = $1', [parentId]);
				const cachedParent = this._getPostCache()?.get(parentId);
				if (cachedParent) {
					const replyCount = Math.max(0, (Number(cachedParent.reply_count ?? cachedParent.replyCount) || 0) - 1);
					this._getPostCache()?.set(parentId, { ...cachedParent, reply_count: replyCount, replyCount });
				}
				const cachedMetrics = this._getPostMetricsCache()?.get(parentId);
				if (cachedMetrics) {
					this._updateCachedPostMetrics(parentId, {
						reply_count: Math.max(0, (Number(cachedMetrics.reply_count) || 0) - 1),
					});
				}
			}
			if (post.repost_to) {
				const parentId = Number(post.repost_to);
				await client.query('UPDATE posts SET repost_count = GREATEST(0, repost_count - 1) WHERE id = $1', [parentId]);
				await client.query('DELETE FROM reposts WHERE user_id = $1 AND post_id = $2', [Number(userId), parentId]);
				const cachedParent = this._getPostCache()?.get(parentId);
				if (cachedParent) {
					const repostCount = Math.max(0, (Number(cachedParent.repost_count ?? cachedParent.repostCount) || 0) - 1);
					this._getPostCache()?.set(parentId, { ...cachedParent, repost_count: repostCount, repostCount });
				}
				const cachedMetrics = this._getPostMetricsCache()?.get(parentId);
				if (cachedMetrics) {
					this._updateCachedPostMetrics(parentId, {
						repost_count: Math.max(0, (Number(cachedMetrics.repost_count) || 0) - 1),
					});
				}
			}
			await client.query('UPDATE posts SET repost_to = NULL WHERE repost_to = $1', [targetId]);
			await client.query('DELETE FROM likes WHERE post_id = $1', [targetId]);
			await client.query('DELETE FROM stars WHERE post_id = $1', [targetId]);
			await client.query('DELETE FROM reposts WHERE post_id = $1', [targetId]);
			await client.query('DELETE FROM pinned_posts WHERE post_id = $1', [targetId]);
			const result = await client.query('DELETE FROM posts WHERE id = $1', [targetId]);
			if (result.rowCount > 0 && userId) {
				this._invalidateProfileStatsCache(userId);
			}
			return result.rowCount > 0;
		});
	}

	async adminDeletePost(postId) {
		const targetId = Number(postId);
		this._getPostCache()?.delete(targetId);
		this._getPostMetricsCache()?.delete(targetId);
		let authorId = null;
		return this._withTransaction(async (client) => {
			const { rows } = await client.query('SELECT user_id, reply_to, repost_to FROM posts WHERE id = $1 FOR UPDATE', [targetId]);
			if (rows[0]) {
				const post = rows[0];
				authorId = post.user_id ? Number(post.user_id) : null;
				if (post.reply_to) {
					const parentId = Number(post.reply_to);
					await client.query('UPDATE posts SET reply_count = GREATEST(0, reply_count - 1) WHERE id = $1', [parentId]);
					const cachedParent = this._getPostCache()?.get(parentId);
					if (cachedParent) {
						const replyCount = Math.max(0, (Number(cachedParent.reply_count ?? cachedParent.replyCount) || 0) - 1);
						this._getPostCache()?.set(parentId, { ...cachedParent, reply_count: replyCount, replyCount });
					}
					const cachedMetrics = this._getPostMetricsCache()?.get(parentId);
					if (cachedMetrics) {
						this._updateCachedPostMetrics(parentId, {
							reply_count: Math.max(0, (Number(cachedMetrics.reply_count) || 0) - 1),
						});
					}
				}
				if (post.repost_to) {
					const parentId = Number(post.repost_to);
					await client.query('UPDATE posts SET repost_count = GREATEST(0, repost_count - 1) WHERE id = $1', [parentId]);
					if (post.user_id) {
						await client.query('DELETE FROM reposts WHERE user_id = $1 AND post_id = $2', [Number(post.user_id), parentId]);
					}
					const cachedParent = this._getPostCache()?.get(parentId);
					if (cachedParent) {
						const repostCount = Math.max(0, (Number(cachedParent.repost_count ?? cachedParent.repostCount) || 0) - 1);
						this._getPostCache()?.set(parentId, { ...cachedParent, repost_count: repostCount, repostCount });
					}
					const cachedMetrics = this._getPostMetricsCache()?.get(parentId);
					if (cachedMetrics) {
						this._updateCachedPostMetrics(parentId, {
							repost_count: Math.max(0, (Number(cachedMetrics.repost_count) || 0) - 1),
						});
					}
				}
			}
			await client.query('UPDATE posts SET repost_to = NULL WHERE repost_to = $1', [Number(postId)]);
			await client.query('DELETE FROM likes WHERE post_id = $1', [Number(postId)]);
			await client.query('DELETE FROM stars WHERE post_id = $1', [Number(postId)]);
			await client.query('DELETE FROM reposts WHERE post_id = $1', [Number(postId)]);
			await client.query('DELETE FROM pinned_posts WHERE post_id = $1', [Number(postId)]);
			const result = await client.query('DELETE FROM posts WHERE id = $1', [Number(postId)]);
			if (result.rowCount > 0 && authorId) {
				this._invalidateProfileStatsCache(authorId);
			}
			return result.rowCount > 0;
		});
	}

	async getRecentPosts(limit = 30) {
		const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
		const { rows } = await this.pool.query(
			`SELECT * FROM posts WHERE group_id IS NULL AND reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT $1`,
			[safeLimit],
		);
		return rows.map(normalizePostRow);
	}

	async getPostsByUserId(userId, limit = 50, _currentUserId = null) {
		const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
		const { rows } = await this.pool.query(
			`SELECT * FROM posts WHERE user_id = $1 AND group_id IS NULL ORDER BY created_at DESC, id DESC LIMIT $2`,
			[Number(userId), safeLimit],
		);
		return rows.map(normalizePostRow);
	}

	async getTimelinePosts(params = {}) {
		const limit = Math.min(Math.max(Number(params.limit) || 30, 1), 100);
		const posts = await this.getRecentPosts(limit);
		return { posts, hasMore: posts.length === limit };
	}

	async getTimelinePostIds({ tab = 'foryou', followIds = [], viewerId = null, limit = 30, offset = 0, beforeId = null, cursor = null, cursorCreatedAt = null, cursorId = null } = {}) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
		const decodedCursor = cursorCreatedAt && cursorId
			? { createdAt: cursorCreatedAt, id: Number(cursorId) }
			: (typeof cursor === 'string' && cursor.trim() ? decodePostCursor(cursor.trim()) : null);
		const normalizedOffset = (decodedCursor || (Number.isInteger(Number(beforeId)) && Number(beforeId) > 0))
			? 0
			: Math.max(0, Number(offset) || 0);
		const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
			? Number(beforeId)
			: null;
		const parsedViewerId = Number(viewerId);
		const validViewerId = Number.isSafeInteger(parsedViewerId) && parsedViewerId > 0 ? parsedViewerId : null;
		const authorSelect = `u.id AS author_id, u.name AS author_name, u.scid AS author_scid, u.handle AS author_handle, u.icon_data AS author_icon_data, u.verify AS author_verify, u.admin AS author_admin, u.settings AS author_settings, u.block AS author_block, u.created_at AS author_created_at`;
		const outerSelect = validViewerId == null
			? `p.*, ${authorSelect}`
			: `p.*, ${authorSelect},
				(EXISTS (SELECT 1 FROM likes l_viewer WHERE l_viewer.post_id = p.id AND l_viewer.user_id = ${validViewerId})) AS liked_by_me,
				(EXISTS (SELECT 1 FROM stars s_viewer WHERE s_viewer.post_id = p.id AND s_viewer.user_id = ${validViewerId})) AS starred_by_me`;

		const wrapCte = (innerQuery) => `
			WITH top_posts AS (
				${innerQuery}
			)
			SELECT ${outerSelect}
			FROM top_posts p
			LEFT JOIN users u ON u.id = p.user_id
			ORDER BY p.created_at DESC, p.id DESC
		`;

		let query;
		let values;

		if (tab === 'following') {
			if (validViewerId != null) {
				if (decodedCursor) {
					query = wrapCte(`SELECT p.* FROM posts p
						WHERE p.group_id IS NULL AND p.reply_to IS NULL
						  AND p.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1)
						  AND (p.created_at, p.id) < ($2, $3)
						ORDER BY p.created_at DESC, p.id DESC LIMIT $4`);
					values = [validViewerId, decodedCursor.createdAt, decodedCursor.id, normalizedLimit + 1];
				} else if (normalizedBeforeId != null) {
					query = wrapCte(`SELECT p.* FROM posts p
						WHERE p.group_id IS NULL AND p.reply_to IS NULL
						  AND p.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1)
						  AND p.id < $2
						ORDER BY p.created_at DESC, p.id DESC LIMIT $3`);
					values = [validViewerId, normalizedBeforeId, normalizedLimit + 1];
				} else {
					query = wrapCte(`SELECT p.* FROM posts p
						WHERE p.group_id IS NULL AND p.reply_to IS NULL
						  AND p.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1)
						ORDER BY p.created_at DESC, p.id DESC LIMIT $2 OFFSET $3`);
					values = [validViewerId, normalizedLimit + 1, normalizedOffset];
				}
			} else {
				const ids = [...new Set((followIds || []).map(Number).filter(Number.isSafeInteger))];
				if (ids.length === 0) return { ids: [], posts: [], has_more: false, next_cursor: null };
				if (decodedCursor) {
					query = wrapCte(`SELECT p.* FROM posts p
						WHERE p.user_id = ANY($1::int[]) AND p.group_id IS NULL AND p.reply_to IS NULL
						  AND (p.created_at, p.id) < ($2, $3)
						ORDER BY p.created_at DESC, p.id DESC LIMIT $4`);
					values = [ids, decodedCursor.createdAt, decodedCursor.id, normalizedLimit + 1];
				} else if (normalizedBeforeId != null) {
					query = wrapCte(`SELECT p.* FROM posts p
						WHERE p.user_id = ANY($1::int[]) AND p.group_id IS NULL AND p.reply_to IS NULL AND p.id < $2
						ORDER BY p.created_at DESC, p.id DESC LIMIT $3`);
					values = [ids, normalizedBeforeId, normalizedLimit + 1];
				} else {
					query = wrapCte(`SELECT p.* FROM posts p
						WHERE p.user_id = ANY($1::int[]) AND p.group_id IS NULL AND p.reply_to IS NULL
						ORDER BY p.created_at DESC, p.id DESC LIMIT $2 OFFSET $3`);
					values = [ids, normalizedLimit + 1, normalizedOffset];
				}
			}
		} else if (tab === 'announce') {
			if (decodedCursor) {
				query = wrapCte(`SELECT p.* FROM posts p
					WHERE p.group_id IS NULL AND p.announcement = TRUE AND p.reply_to IS NULL
					AND (p.created_at, p.id) < ($1, $2) ORDER BY p.created_at DESC, p.id DESC LIMIT $3`);
				values = [decodedCursor.createdAt, decodedCursor.id, normalizedLimit + 1];
			} else if (normalizedBeforeId != null) {
				query = wrapCte(`SELECT p.* FROM posts p
					WHERE p.group_id IS NULL AND p.announcement = TRUE AND p.reply_to IS NULL
					AND p.id < $1 ORDER BY p.created_at DESC, p.id DESC LIMIT $2`);
				values = [normalizedBeforeId, normalizedLimit + 1];
			} else {
				query = wrapCte(`SELECT p.* FROM posts p
					WHERE p.group_id IS NULL AND p.announcement = TRUE AND p.reply_to IS NULL
					ORDER BY p.created_at DESC, p.id DESC LIMIT $1 OFFSET $2`);
				values = [normalizedLimit + 1, normalizedOffset];
			}
		} else if (decodedCursor) {
			query = wrapCte(`SELECT p.* FROM posts p
				WHERE p.group_id IS NULL AND p.reply_to IS NULL
				AND (p.created_at, p.id) < ($1, $2) ORDER BY p.created_at DESC, p.id DESC LIMIT $3`);
			values = [decodedCursor.createdAt, decodedCursor.id, normalizedLimit + 1];
		} else if (normalizedBeforeId != null) {
			query = wrapCte(`SELECT p.* FROM posts p
				WHERE p.group_id IS NULL AND p.reply_to IS NULL AND p.id < $1 ORDER BY p.created_at DESC, p.id DESC LIMIT $2`);
			values = [normalizedBeforeId, normalizedLimit + 1];
		} else {
			query = wrapCte(`SELECT p.* FROM posts p
				WHERE p.group_id IS NULL AND p.reply_to IS NULL ORDER BY p.created_at DESC, p.id DESC LIMIT $1 OFFSET $2`);
			values = [normalizedLimit + 1, normalizedOffset];
		}

		const { rows } = await this.pool.query(query, values);
		const normalizedRows = rows.map(normalizePostRow);
		for (const post of normalizedRows) {
			if (post?.author) {
				this._setCachedUser(post.author);
			}
		}
		const posts = normalizedRows.slice(0, normalizedLimit);
		const ids = posts.map((post) => Number(post.id));
		const lastPost = posts.length > 0 ? posts[posts.length - 1] : null;
		const nextCursor = rows.length > normalizedLimit && lastPost
			? (encodePostCursor(lastPost) || ids[ids.length - 1])
			: null;
		return {
			ids,
			posts,
			has_more: rows.length > normalizedLimit,
			next_cursor: nextCursor,
		};
	}

	async getRecommendedPostIds({ viewerId = null, limit = 30, offset = 0, beforeId = null, cursor = null, cursorCreatedAt = null, cursorId = null } = {}) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
		const decodedCursor = cursorCreatedAt && cursorId
			? { createdAt: cursorCreatedAt, id: Number(cursorId) }
			: (typeof cursor === 'string' && cursor.trim() ? decodePostCursor(cursor.trim()) : null);
		const normalizedOffset = decodedCursor ? 0 : Math.max(0, Number(offset) || 0);
		const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
			? Number(beforeId)
			: null;
		const parsedViewerId = Number(viewerId);
		const validViewerId = Number.isSafeInteger(parsedViewerId) && parsedViewerId > 0 ? parsedViewerId : null;

		const candidateLimit = Math.max(60, normalizedLimit * 2) + 1;
		const userExclusionClause = validViewerId != null ? 'AND p.user_id != $' : '';
		let query;
		let params;

		if (validViewerId != null) {
			if (decodedCursor) {
				query = `SELECT p.id, p.user_id, p.created_at, p.tags,
				          COALESCE(p.like_count, 0)::int AS like_count,
				          COALESCE(p.star_count, 0)::int AS star_count,
				          COALESCE(p.repost_count, 0)::int AS repost_count
				   FROM posts p
				   WHERE p.group_id IS NULL AND p.reply_to IS NULL AND p.user_id != $1
				     AND (p.created_at < $2 OR (p.created_at = $2 AND p.id < $3))
				   ORDER BY p.created_at DESC, p.id DESC
				   LIMIT $4`;
				params = [validViewerId, decodedCursor.createdAt, decodedCursor.id, candidateLimit];
			} else if (normalizedBeforeId != null) {
				query = `SELECT p.id, p.user_id, p.created_at, p.tags,
				          COALESCE(p.like_count, 0)::int AS like_count,
				          COALESCE(p.star_count, 0)::int AS star_count,
				          COALESCE(p.repost_count, 0)::int AS repost_count
				   FROM posts p
				   WHERE p.group_id IS NULL AND p.reply_to IS NULL AND p.user_id != $1 AND p.id < $2
				   ORDER BY p.created_at DESC, p.id DESC
				   LIMIT $3`;
				params = [validViewerId, normalizedBeforeId, candidateLimit];
			} else {
				query = `SELECT p.id, p.user_id, p.created_at, p.tags,
				          COALESCE(p.like_count, 0)::int AS like_count,
				          COALESCE(p.star_count, 0)::int AS star_count,
				          COALESCE(p.repost_count, 0)::int AS repost_count
				   FROM posts p
				   WHERE p.group_id IS NULL AND p.reply_to IS NULL AND p.user_id != $1
				   ORDER BY p.created_at DESC, p.id DESC
				   LIMIT $2 OFFSET $3`;
				params = [validViewerId, candidateLimit, normalizedOffset];
			}
		} else if (decodedCursor) {
			query = `SELECT p.id, p.user_id, p.created_at, p.tags,
			          COALESCE(p.like_count, 0)::int AS like_count,
			          COALESCE(p.star_count, 0)::int AS star_count,
			          COALESCE(p.repost_count, 0)::int AS repost_count
			   FROM posts p
			   WHERE p.group_id IS NULL AND p.reply_to IS NULL
			     AND (p.created_at < $1 OR (p.created_at = $1 AND p.id < $2))
			   ORDER BY p.created_at DESC, p.id DESC
			   LIMIT $3`;
			params = [decodedCursor.createdAt, decodedCursor.id, candidateLimit];
		} else if (normalizedBeforeId != null) {
			query = `SELECT p.id, p.user_id, p.created_at, p.tags,
			          COALESCE(p.like_count, 0)::int AS like_count,
			          COALESCE(p.star_count, 0)::int AS star_count,
			          COALESCE(p.repost_count, 0)::int AS repost_count
			   FROM posts p
			   WHERE p.group_id IS NULL AND p.reply_to IS NULL AND p.id < $1
			   ORDER BY p.created_at DESC, p.id DESC
			   LIMIT $2`;
			params = [normalizedBeforeId, candidateLimit];
		} else {
			query = `SELECT p.id, p.user_id, p.created_at, p.tags,
			          COALESCE(p.like_count, 0)::int AS like_count,
			          COALESCE(p.star_count, 0)::int AS star_count,
			          COALESCE(p.repost_count, 0)::int AS repost_count
			   FROM posts p
			   WHERE p.group_id IS NULL AND p.reply_to IS NULL
			   ORDER BY p.created_at DESC, p.id DESC
			   LIMIT $1 OFFSET $2`;
			params = [candidateLimit, normalizedOffset];
		}

		if (!this._affinityCache) this._affinityCache = new Map();
		if (!this._followCache) this._followCache = new Map();
		if (!this._reactionCache) this._reactionCache = new Map();
		if (!this._candidatePostsCache) this._candidatePostsCache = { posts: [], expiresAt: 0 };
		const now = Date.now();

		let keywordProfile = new Map();
		let directFollows = new Set();
		let reactedPostIds = new Set();

		const fetchTasks = [];

		if (validViewerId != null) {
			const cachedAffinity = this._affinityCache.get(validViewerId);
			if (cachedAffinity && cachedAffinity.expiresAt > now) {
				keywordProfile = cachedAffinity.profile;
			} else {
				fetchTasks.push(
					this.pool.query(
						'SELECT keyword, score FROM user_keyword_affinities WHERE user_id = $1 ORDER BY score DESC LIMIT 25',
						[validViewerId],
					).then(({ rows }) => {
						keywordProfile = new Map(rows.map((r) => [String(r.keyword).toLowerCase(), Number(r.score) || 0]));
						if (this._affinityCache.size >= 2000) this._affinityCache.clear();
						this._affinityCache.set(validViewerId, { profile: keywordProfile, expiresAt: Date.now() + 60000 });
					}).catch(() => {})
				);
			}

			const cachedFollows = this._followCache.get(validViewerId);
			if (cachedFollows && cachedFollows.expiresAt > now) {
				directFollows = cachedFollows.follows;
			} else {
				fetchTasks.push(
					this.pool.query(
						'SELECT following_id FROM follows WHERE follower_id = $1 LIMIT 100',
						[validViewerId],
					).then(({ rows }) => {
						directFollows = new Set(rows.map((r) => Number(r.following_id)));
						if (this._followCache.size >= 2000) this._followCache.clear();
						this._followCache.set(validViewerId, { follows: directFollows, expiresAt: Date.now() + 60000 });
					}).catch(() => {})
				);
			}

			const cachedReactions = this._reactionCache.get(validViewerId);
			if (cachedReactions && cachedReactions.expiresAt > now) {
				reactedPostIds = cachedReactions.posts;
			} else {
				fetchTasks.push(
					this.pool.query(
						`(SELECT post_id FROM likes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100)
						 UNION ALL
						 (SELECT post_id FROM stars WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100)
						 UNION ALL
						 (SELECT post_id FROM reposts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100)`,
						[validViewerId],
					).then(({ rows }) => {
						reactedPostIds = new Set(rows.map((r) => Number(r.post_id)));
						if (this._reactionCache.size >= 2000) this._reactionCache.clear();
						this._reactionCache.set(validViewerId, { posts: reactedPostIds, expiresAt: Date.now() + 60000 });
					}).catch(() => {})
				);
			}
		}

		let candidateRows = [];
		let hasMore = false;

		const candidateTask = (async () => {
			if (validViewerId == null && !decodedCursor && normalizedBeforeId == null && normalizedOffset === 0 && this._candidatePostsCache.expiresAt > now && this._candidatePostsCache.posts.length > 0) {
				candidateRows = this._candidatePostsCache.posts;
				hasMore = candidateRows.length >= candidateLimit;
			} else {
				const { rows } = await this.pool.query(query, params);
				hasMore = rows.length >= candidateLimit;
				candidateRows = rows.slice(0, candidateLimit - 1);
				if (validViewerId == null && !decodedCursor && normalizedBeforeId == null && normalizedOffset === 0) {
					this._candidatePostsCache = { posts: candidateRows, expiresAt: now + 300000 };
				}
			}
		})();

		fetchTasks.push(candidateTask);
		await Promise.all(fetchTasks);

		// Fast in-memory scoring on Node.js server
		const scored = scoreRecommendedPosts(candidateRows, {
			viewerId: validViewerId,
			keywordProfile,
			directFollows,
			reactedPostIds,
			limit: normalizedLimit,
		});

		const selectedIds = scored.map((s) => s.id);
		const lastCandidateId = candidateRows.length > 0 ? Number(candidateRows[candidateRows.length - 1].id) : null;
		return {
			ids: selectedIds,
			has_more: hasMore,
			next_cursor: hasMore && lastCandidateId
				? (encodePostCursor(candidateRows[candidateRows.length - 1]) || lastCandidateId)
				: null,
			next_offset: normalizedOffset + candidateRows.length,
			use_offset_pagination: normalizedBeforeId == null && !decodedCursor,
		};
	}

	async getProfilePostIds({ userId, subType = 'all', limit = 30, offset = 0, beforeId = null, cursor = null, cursorCreatedAt = null, cursorId = null } = {}) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
		const decodedCursor = cursorCreatedAt && cursorId
			? { createdAt: cursorCreatedAt, id: Number(cursorId) }
			: (typeof cursor === 'string' && cursor.trim() ? decodePostCursor(cursor.trim()) : null);
		const normalizedOffset = decodedCursor ? 0 : Math.max(0, Number(offset) || 0);
		const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
			? Number(beforeId)
			: null;
		const values = [Number(userId)];
		const clauses = ['user_id = $1', 'group_id IS NULL'];
		if (subType === 'posts_only') clauses.push('reply_to IS NULL');
		if (subType === 'replies_only') clauses.push('reply_to IS NOT NULL');
		if (decodedCursor) {
			values.push(decodedCursor.createdAt, decodedCursor.id);
			clauses.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
		} else if (normalizedBeforeId != null) {
			values.push(normalizedBeforeId);
			clauses.push(`id < $${values.length}`);
		}
		values.push(normalizedLimit + 1);
		const limitParam = values.length;
		let offsetSql = '';
		if (normalizedBeforeId == null && !decodedCursor) {
			values.push(normalizedOffset);
			offsetSql = ` OFFSET $${values.length}`;
		}
		const { rows } = await this.pool.query(
			`SELECT * FROM posts WHERE ${clauses.join(' AND ')}
			 ORDER BY created_at DESC, id DESC LIMIT $${limitParam}${offsetSql}`,
			values,
		);
		const normalizedRows = rows.map(normalizePostRow).filter(Boolean);
		const ids = normalizedRows.slice(0, normalizedLimit).map((post) => Number(post.id));
		return {
			ids,
			posts: normalizedRows.slice(0, normalizedLimit),
			has_more: rows.length > normalizedLimit,
			next_cursor: rows.length > normalizedLimit && ids.length > 0
				? (encodePostCursor(normalizedRows[normalizedLimit - 1]) || ids[ids.length - 1])
				: null,
		};
	}

	async searchPostIds(query, limit = 30, offset = 0, beforeId = null, _viewerId = null, options = {}) {
		const q = String(query || '').trim();
		if (!q) return { ids: [], has_more: false, next_cursor: null };
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
		const decodedCursor = options?.cursorCreatedAt && options?.cursorId
			? { createdAt: options.cursorCreatedAt, id: Number(options.cursorId) }
			: (typeof options?.cursor === 'string' && options.cursor.trim() ? decodePostCursor(options.cursor.trim()) : null);
		const normalizedOffset = decodedCursor ? 0 : Math.max(0, Number(offset) || 0);
		const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
			? Number(beforeId)
			: null;

		const pattern = `%${q}%`;
		const clauses = ['group_id IS NULL', '(view_content ILIKE $1 OR content ILIKE $1 OR tags::text ILIKE $1)'];
		const values = [pattern];

		if (decodedCursor) {
			values.push(decodedCursor.createdAt, decodedCursor.id);
			clauses.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
		} else if (normalizedBeforeId != null) {
			values.push(normalizedBeforeId);
			clauses.push(`id < $${values.length}`);
		}

		values.push(normalizedLimit + 1);
		const limitIdx = values.length;

		let offsetSql = '';
		if (normalizedBeforeId == null && !decodedCursor && normalizedOffset > 0) {
			values.push(normalizedOffset);
			offsetSql = ` OFFSET $${values.length}`;
		}

		const sql = `SELECT id, created_at FROM posts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${limitIdx}${offsetSql}`;
		const { rows } = await this.pool.query(sql, values);

		const hasMore = rows.length > normalizedLimit;
		const slice = rows.slice(0, normalizedLimit);
		const ids = slice.map((r) => Number(r.id));
		const lastRow = slice.length > 0 ? slice[slice.length - 1] : null;

		return {
			ids,
			has_more: hasMore,
			next_cursor: hasMore && lastRow
				? (encodePostCursor({ id: Number(lastRow.id), created_at: lastRow.created_at }) || ids[ids.length - 1])
				: null,
		};
	}

	async searchPosts(query, limit = 20) {
		const result = await this.searchPostIds(query, limit, 0);
		if (!result.ids.length) return [];
		const { rows } = await this.pool.query(
			'SELECT * FROM posts WHERE id = ANY($1::int[])',
			[result.ids],
		);
		const map = new Map(rows.map((r) => [Number(r.id), normalizePostRow(r)]));
		return result.ids.map((id) => map.get(id)).filter(Boolean);
	}

	async getReplyPostIds(parentPostId, limit = 50, offset = 0, options = {}) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
		const cursor = options?.cursor || null;
		const cursorCreatedAt = options?.cursorCreatedAt || null;
		const cursorId = options?.cursorId || null;
		const decodedCursor = cursorCreatedAt && cursorId
			? { createdAt: cursorCreatedAt, id: Number(cursorId) }
			: (typeof cursor === 'string' && cursor.trim() ? decodePostCursor(cursor.trim()) : null);

		if (decodedCursor) {
			const { rows } = await this.pool.query(
				`SELECT id, created_at FROM posts
				 WHERE reply_to = $1 AND (created_at, id) < ($2, $3)
				 ORDER BY created_at DESC, id DESC LIMIT $4`,
				[Number(parentPostId), decodedCursor.createdAt, decodedCursor.id, normalizedLimit + 1],
			);
			const selectedRows = rows.slice(0, normalizedLimit);
			const ids = selectedRows.map((row) => Number(row.id));
			const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null;
			const nextCursor = rows.length > normalizedLimit && lastRow
				? (encodePostCursor(lastRow) || ids[ids.length - 1])
				: null;
			return {
				ids,
				has_more: rows.length > normalizedLimit,
				next_cursor: nextCursor,
			};
		}

		const normalizedOffset = Math.max(0, Number(offset) || 0);
		const { rows } = await this.pool.query(
			`SELECT id, created_at FROM posts WHERE reply_to = $1
			 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
			[Number(parentPostId), normalizedLimit + 1, normalizedOffset],
		);
		const selectedRows = rows.slice(0, normalizedLimit);
		const ids = selectedRows.map((row) => Number(row.id));
		const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null;
		const nextCursor = rows.length > normalizedLimit && lastRow
			? (encodePostCursor(lastRow) || ids[ids.length - 1])
			: null;
		return {
			ids,
			has_more: rows.length > normalizedLimit,
			next_cursor: nextCursor,
		};
	}

	async getReplyCount(postId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int AS count FROM posts WHERE reply_to = $1',
			[Number(postId)],
		);
		return Number(rows[0]?.count || 0);
	}

	async getThreadReplyPostIds(parentPostId, limit = 50, offset = 0) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
		const normalizedOffset = Math.max(0, Number(offset) || 0);
		const { rows } = await this.pool.query(
			`WITH RECURSIVE reply_tree AS (
				SELECT id, reply_to, 0 AS depth, ARRAY[id] AS path
				FROM posts
				WHERE reply_to = $1
				UNION ALL
				SELECT child.id, child.reply_to, tree.depth + 1, tree.path || child.id
				FROM posts child
				JOIN reply_tree tree ON child.reply_to = tree.id
				WHERE tree.depth < 10 AND NOT child.id = ANY(tree.path)
			)
			SELECT id FROM reply_tree
			ORDER BY path
			LIMIT $2 OFFSET $3`,
			[Number(parentPostId), normalizedLimit + 1, normalizedOffset],
		);
		return {
			ids: rows.slice(0, normalizedLimit).map((row) => Number(row.id)),
			has_more: rows.length > normalizedLimit,
		};
	}

	async getPostDetail(id, currentUserId = null) {
		const { rows } = await this.pool.query(
			`SELECT p.*,
				author.id AS author_id,
				author.name AS author_name,
				author.scid AS author_scid,
				author.handle AS author_handle,
				author.icon_data AS author_icon_data,
				author.verify AS author_verify,
				author.admin AS author_admin,
				author.settings AS author_settings,
				author.block AS author_block,
				author.created_at AS author_created_at,
				parent.id AS parent_id,
				parent.content AS parent_content,
				parent_author.id AS parent_author_id,
				parent_author.name AS parent_author_name
			 FROM posts p
			 LEFT JOIN users author ON author.id = p.user_id
			 LEFT JOIN posts parent ON parent.id = p.reply_to
			 LEFT JOIN users parent_author ON parent_author.id = parent.user_id
			 WHERE p.id = $1`,
			[Number(id)],
		);
		const detail = rows[0];
		if (!detail) return null;
		const [metric] = await this.getPostMetricsBatch([Number(id)], currentUserId);

		const normalized = normalizePostRow(detail);
		return {
			...normalized,
			author: normalized.author,
			like_count: Number(metric?.like_count || 0),
			star_count: Number(metric?.star_count || 0),
			liked_by_me: Boolean(metric?.liked_by_me),
			starred_by_me: Boolean(metric?.starred_by_me),
			parent_post: detail.parent_id == null
				? null
				: {
					id: Number(detail.parent_id),
					content: detail.parent_content ? String(detail.parent_content).substring(0, 100) : '',
					author: detail.parent_author_id == null
						? null
						: { id: Number(detail.parent_author_id), name: detail.parent_author_name || '' },
				},
		};
	}

	async getTrendingPosts(limit = 20) {
		const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
		const { rows } = await this.pool.query(
			`WITH recent_posts AS (
				SELECT id, user_id, content, attachments, mask, lock, announcement, group_id, group_announcement, reply_to, repost_to, tags, tags_generated_at, created_at
				FROM posts
				WHERE group_id IS NULL
				  AND reply_to IS NULL
				  AND created_at >= NOW() - INTERVAL '3 days'
				ORDER BY created_at DESC, id DESC
				LIMIT 500
			), like_agg AS (
				SELECT l.post_id, COUNT(*)::int AS cnt
				FROM likes l
				JOIN recent_posts rp ON rp.id = l.post_id
				WHERE l.created_at >= NOW() - INTERVAL '3 days'
				GROUP BY l.post_id
			), star_agg AS (
				SELECT s.post_id, COUNT(*)::int AS cnt
				FROM stars s
				JOIN recent_posts rp ON rp.id = s.post_id
				WHERE s.created_at >= NOW() - INTERVAL '3 days'
				GROUP BY s.post_id
			), repost_agg AS (
				SELECT r.post_id, COUNT(*)::int AS cnt
				FROM reposts r
				JOIN recent_posts rp ON rp.id = r.post_id
				WHERE r.created_at >= NOW() - INTERVAL '3 days'
				GROUP BY r.post_id
			)
			SELECT rp.*,
				(COALESCE(la.cnt, 0) + COALESCE(sa.cnt, 0) * 2 + COALESCE(ra.cnt, 0) * 3) AS score
			FROM recent_posts rp
			LEFT JOIN like_agg la ON la.post_id = rp.id
			LEFT JOIN star_agg sa ON sa.post_id = rp.id
			LEFT JOIN repost_agg ra ON ra.post_id = rp.id
			ORDER BY score DESC, rp.created_at DESC, rp.id DESC
			LIMIT $1`,
			[safeLimit],
		);
		return rows.map(normalizePostRow);
	}

	async getTrendingHashtags(limit = 10, options = {}) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
		const { rows } = await this.pool.query(
			`SELECT user_id, content, view_content, tags
			 FROM posts
			 WHERE group_id IS NULL
			   AND created_at >= NOW() - INTERVAL '3 days'
			 ORDER BY created_at DESC
			 LIMIT 500`,
		);
		const hashtagUsers = new Map(); // tag -> Set<userId>
		const tagUsers = new Map();     // tag -> Set<userId>
		const wordUsers = new Map();    // word -> Set<userId>

		for (const row of rows) {
			const userId = row.user_id || 'anonymous';
			const content = row.view_content || extractViewContent(row.content || '');
			const hashtagMatches = content.match(/(?:#|＃)([\p{L}\p{N}_-]{1,48})/gu) || [];
			const postHashtags = new Set(
				hashtagMatches
					.map((m) => m.replace(/^[#＃]/, '').toLowerCase())
					.filter((tag) => tag.length > 2)
			);

			for (const tag of postHashtags) {
				const fullTag = `#${tag}`;
				if (!hashtagUsers.has(fullTag)) hashtagUsers.set(fullTag, new Set());
				hashtagUsers.get(fullTag).add(userId);
			}

			const rawTags = Array.isArray(row.tags)
				? row.tags
				: (typeof row.tags === 'string' ? parseJsonSafe(row.tags, []) : []);
			const postWords = new Set(
				rawTags
					.map((rawTag) => String(rawTag || '').trim().toLowerCase().replace(/^[#＃]/, ''))
					.filter((tag) => tag.length > 2 && !postHashtags.has(tag))
			);

			for (const word of postWords) {
				if (!wordUsers.has(word)) wordUsers.set(word, new Set());
				wordUsers.get(word).add(userId);
			}

			// tags: 「単語より1段階広い範囲」
			const sanitizedContent = content
				.replace(/https?:\/\/[^\s]+/giu, ' ')
				.replace(/@[\p{L}\p{N}_-]+/giu, ' ')
				.replace(/[#＃][\p{L}\p{N}_-]+/gu, ' ');
			const phraseMatches = sanitizedContent.match(/([\p{Script=Han}\p{Script=Katakana}a-zA-Z0-9_-]{2,10}(?:の[\p{Script=Han}\p{Script=Katakana}a-zA-Z0-9_-]{2,10}|[\p{Script=Han}\p{Script=Katakana}a-zA-Z0-9_-]{2,10}))/gu) || [];
			const postCompoundTags = new Set(
				phraseMatches
					.map((p) => p.trim().toLowerCase().replace(/^[#＃]/, ''))
					.filter((tag) => tag.length >= 3 && tag.length <= 30 && !postHashtags.has(tag) && !postWords.has(tag))
			);

			for (const tag of postCompoundTags) {
				if (!tagUsers.has(tag)) tagUsers.set(tag, new Set());
				tagUsers.get(tag).add(userId);
			}
		}

		const calculateTagSimilarity = (str1, str2) => {
			const s1 = String(str1 || '').trim().toLowerCase().replace(/^[#＃]/, '');
			const s2 = String(str2 || '').trim().toLowerCase().replace(/^[#＃]/, '');
			if (s1 === s2) return 1.0;
			if (!s1 || !s2) return 0.0;

			const len1 = s1.length;
			const len2 = s2.length;
			const maxLen = Math.max(len1, len2);
			const minLen = Math.min(len1, len2);

			const isSubstring = s1.includes(s2) || s2.includes(s1);
			const substringSim = isSubstring ? minLen / maxLen : 0;

			const d = Array.from({ length: len1 + 1 }, () => new Array(len2 + 1).fill(0));
			for (let i = 0; i <= len1; i++) d[i][0] = i;
			for (let j = 0; j <= len2; j++) d[0][j] = j;
			for (let i = 1; i <= len1; i++) {
				for (let j = 1; j <= len2; j++) {
					const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
					d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
				}
			}
			const levSim = 1 - d[len1][len2] / maxLen;

			let diceSim = 0;
			if (len1 >= 2 && len2 >= 2) {
				const bg1 = new Map();
				for (let i = 0; i < len1 - 1; i++) {
					const bg = s1.slice(i, i + 2);
					bg1.set(bg, (bg1.get(bg) || 0) + 1);
				}
				const bg2 = new Map();
				for (let i = 0; i < len2 - 1; i++) {
					const bg = s2.slice(i, i + 2);
					bg2.set(bg, (bg2.get(bg) || 0) + 1);
				}
				let intersection = 0;
				for (const [bg, count1] of bg1.entries()) {
					if (bg2.has(bg)) intersection += Math.min(count1, bg2.get(bg));
				}
				diceSim = (2 * intersection) / ((len1 - 1) + (len2 - 1));
			}

			return Math.max(substringSim, levSim, diceSim);
		};

		const mapToMergedSortedList = (userMap, threshold = 0.75) => {
			const sorted = Array.from(userMap.entries())
				.sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0], 'ja'));

			const clusters = [];
			for (const [tag, users] of sorted) {
				let merged = false;
				for (const cluster of clusters) {
					const isBothHashtags = cluster.representative.startsWith('#') && tag.startsWith('#');
					const isBothNonHashtags = !cluster.representative.startsWith('#') && !tag.startsWith('#');
					if (isBothHashtags || isBothNonHashtags) {
						const sim = calculateTagSimilarity(cluster.representative, tag);
						if (sim > threshold) {
							for (const u of users) cluster.users.add(u);
							merged = true;
							break;
						}
					}
				}
				if (!merged) {
					clusters.push({ representative: tag, users: new Set(users) });
				}
			}

			return clusters
				.sort((a, b) => b.users.size - a.users.size || a.representative.localeCompare(b.representative, 'ja'))
				.slice(0, normalizedLimit)
				.map((c) => ({
					tag_name: c.representative,
					occurrence_count: c.users.size,
				}));
		};

		const hashtagsList = mapToMergedSortedList(hashtagUsers);
		const wordsList = mapToMergedSortedList(wordUsers);
		const tagsList = mapToMergedSortedList(tagUsers);

		const type = typeof options === 'string' ? options : options?.type;
		if (type === 'hashtags') return hashtagsList;
		if (type === 'words') return wordsList;
		if (type === 'tags') return tagsList.length > 0 ? tagsList : wordsList;

		const mergedUsers = new Map();
		for (const [k, set] of hashtagUsers) {
			if (!mergedUsers.has(k)) mergedUsers.set(k, new Set());
			for (const u of set) mergedUsers.get(k).add(u);
		}
		for (const [k, set] of wordUsers) {
			if (!mergedUsers.has(k)) mergedUsers.set(k, new Set());
			for (const u of set) mergedUsers.get(k).add(u);
		}
		for (const [k, set] of tagUsers) {
			if (!mergedUsers.has(k)) mergedUsers.set(k, new Set());
			for (const u of set) mergedUsers.get(k).add(u);
		}
		const trendsList = mapToMergedSortedList(mergedUsers);

		if (options?.summary || options?.detailed) {
			return {
				trends: trendsList,
				hashtags: hashtagsList,
				tags: tagsList.length > 0 ? tagsList : wordsList,
				words: wordsList,
			};
		}

		return trendsList;
	}

	async getPostCount(userId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int AS count FROM posts WHERE user_id = $1',
			[Number(userId)],
		);
		return Number(rows[0]?.count || 0);
	}

	async getMediaCount(userId) {
		const { rows } = await this.pool.query(
			`SELECT COUNT(*)::int AS count FROM posts
			 WHERE user_id = $1
			   AND attachments IS NOT NULL
			   AND jsonb_typeof(attachments) = 'array'
			   AND jsonb_array_length(attachments) > 0`,
			[Number(userId)],
		);
		return Number(rows[0]?.count || 0);
	}

	async getMediaPosts(userId, limit = 15, offset = 0, type = null, options = {}) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 15, 100));
		const cursor = options?.cursor || null;
		const cursorCreatedAt = options?.cursorCreatedAt || null;
		const cursorId = options?.cursorId || null;
		const decodedCursor = cursorCreatedAt && cursorId
			? { createdAt: cursorCreatedAt, id: Number(cursorId), position: options?.cursorPosition != null ? Number(options.cursorPosition) : null }
			: (typeof cursor === 'string' && cursor.trim() ? decodePostCursor(cursor.trim()) : null);

		let query = `SELECT p.id AS post_id,
				p.created_at,
				attachment.position,
				attachment.file->>'id' AS file_id,
				COALESCE(attachment.file->>'type', 'file') AS file_type
		 FROM posts p
		 CROSS JOIN LATERAL jsonb_array_elements(p.attachments) WITH ORDINALITY AS attachment(file, position)
		 WHERE p.user_id = $1
		   AND p.attachments IS NOT NULL
		   AND jsonb_typeof(p.attachments) = 'array'
		   AND jsonb_array_length(p.attachments) > 0`;
		const params = [Number(userId)];
		if (type && (type === 'image' || type === 'video')) {
			query += ` AND COALESCE(attachment.file->>'type', 'file') = $${params.length + 1}`;
			params.push(type);
		}
		if (decodedCursor) {
			if (decodedCursor.position != null) {
				query += ` AND (p.created_at < $${params.length + 1} OR (p.created_at = $${params.length + 1} AND p.id < $${params.length + 2}) OR (p.created_at = $${params.length + 1} AND p.id = $${params.length + 2} AND attachment.position > $${params.length + 3}))`;
				params.push(decodedCursor.createdAt, decodedCursor.id, decodedCursor.position);
			} else {
				query += ` AND (p.created_at < $${params.length + 1} OR (p.created_at = $${params.length + 1} AND p.id < $${params.length + 2}))`;
				params.push(decodedCursor.createdAt, decodedCursor.id);
			}
			query += ` ORDER BY p.created_at DESC, p.id DESC, attachment.position ASC LIMIT $${params.length + 1}`;
			params.push(normalizedLimit + 1);
		} else {
			const normalizedOffset = Math.max(0, Number(offset) || 0);
			query += ` ORDER BY p.created_at DESC, p.id DESC, attachment.position ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
			params.push(normalizedLimit + 1, normalizedOffset);
		}

		const { rows } = await this.pool.query(query, params);
		const selectedRows = rows.slice(0, normalizedLimit);
		const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null;
		const nextCursor = rows.length > normalizedLimit && lastRow
			? encodePostCursor({ createdAt: lastRow.created_at, id: lastRow.post_id, position: lastRow.position })
			: null;

		const items = selectedRows.map((row) => ({
			post_id: Number(row.post_id),
			file_id: row.file_id,
			file_type: row.file_type || 'file',
			type: row.file_type || 'file',
		}));

		if (options?.withNextCursor || decodedCursor) {
			return {
				media_items: items,
				has_more: rows.length > normalizedLimit,
				next_cursor: nextCursor,
			};
		}
		items.next_cursor = nextCursor;
		items.has_more = rows.length > normalizedLimit;
		return items;
	}

	// ==================== Reactions ====================

	async _adjustUserKeywordAffinitiesForTags(client, userId, tags, delta) {
		const normalizedDelta = Number(delta);
		const normalizedTags = normalizePostTags(tags);
		if (!Number.isFinite(normalizedDelta) || normalizedDelta === 0 || normalizedTags.length === 0) return;
		if (normalizedDelta > 0) {
			await client.query(
				`INSERT INTO user_keyword_affinities (user_id, keyword, score, updated_at)
				 SELECT $1, keyword, $3::numeric, NOW() FROM unnest($2::text[]) AS keyword
				 ON CONFLICT (user_id, keyword) DO UPDATE
				 SET score = user_keyword_affinities.score + EXCLUDED.score,
					 updated_at = NOW()`,
				[Number(userId), normalizedTags, normalizedDelta],
			);
		} else {
			await client.query(
				`UPDATE user_keyword_affinities
				 SET score = GREATEST(0, score + $3::numeric),
					 updated_at = NOW()
				 WHERE user_id = $1 AND keyword = ANY($2::text[])`,
				[Number(userId), normalizedTags, normalizedDelta],
			);
			await client.query(
				'DELETE FROM user_keyword_affinities WHERE user_id = $1 AND score <= 0',
				[Number(userId)],
			);
		}
	}

	async _adjustUserKeywordAffinities(client, userId, postId, delta) {
		const { rows } = await client.query(
			'SELECT tags FROM posts WHERE id = $1 LIMIT 1',
			[Number(postId)],
		);
		await this._adjustUserKeywordAffinitiesForTags(client, userId, rows[0]?.tags, delta);
	}

	async dislikePost(userId, postId) {
		const uId = Number(userId);
		const pId = Number(postId);
		this._affinityCache?.delete(uId);
		return this._withTransaction(async (client) => {
			const { rows } = await client.query(
				'SELECT tags, content, view_content FROM posts WHERE id = $1 LIMIT 1',
				[pId],
			);
			const post = rows[0];
			if (!post) return false;
			let tags = normalizePostTags(post.tags);
			if (tags.length === 0) {
				const keywords = await extractPostKeywords(post.view_content || post.content || '');
				tags = normalizePostTags(keywords);
			}
			if (tags.length > 0) {
				await this._adjustUserKeywordAffinitiesForTags(client, uId, tags, -15);
			}
			return true;
		});
	}

	async toggleLike(userId, postId) {
		const uId = Number(userId);
		const pId = Number(postId);
		const now = new Date().toISOString();

		const result = await this._withTransaction(async (client) => {
			const delResult = await client.query(
				'DELETE FROM likes WHERE user_id = $1 AND post_id = $2 RETURNING 1',
				[uId, pId],
			);
			let liked = false;
			let count = 0;
			let tags = null;
			let changed = false;

			if (delResult.rowCount > 0) {
				const { rows } = await client.query(
					'UPDATE posts SET like_count = GREATEST(0, like_count - 1) WHERE id = $1 RETURNING like_count, tags',
					[pId],
				);
				liked = false;
				changed = true;
				count = Math.max(0, Number(rows[0]?.like_count) || 0);
				tags = rows[0]?.tags;
			} else {
				const insertResult = await client.query(
					'INSERT INTO likes (user_id, post_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING 1',
					[uId, pId, now],
				);
				if (insertResult.rowCount > 0) {
					const { rows } = await client.query(
						'UPDATE posts SET like_count = like_count + 1 WHERE id = $1 RETURNING like_count, tags',
						[pId],
					);
					liked = true;
					changed = true;
					count = Math.max(0, Number(rows[0]?.like_count) || 0);
					tags = rows[0]?.tags;
				} else {
					const { rows } = await client.query(
						'SELECT like_count, tags FROM posts WHERE id = $1',
						[pId],
					);
					liked = true;
					count = Math.max(0, Number(rows[0]?.like_count) || 0);
					tags = rows[0]?.tags;
				}
			}

			if (tags && changed) {
				const delta = liked ? 1 : -1;
				await this._adjustUserKeywordAffinitiesForTags(client, uId, tags, delta);
			}

			return { liked, count };
		});
		const cachedPost = this._getPostCache()?.get(pId);
		if (cachedPost) {
			this._getPostCache()?.set(pId, {
				...cachedPost,
				like_count: result.count,
				likeCount: result.count,
			});
		}
		this._updateCachedPostMetrics(pId, { like_count: result.count });
		this._updateCachedPostReaction(pId, uId, 'like', result.liked);
		return result;
	}

	async getLikeCount(postId) {
		const { rows } = await this.pool.query(
			'SELECT like_count FROM posts WHERE id = $1',
			[Number(postId)],
		);
		return Number(rows[0]?.like_count || 0);
	}

	async hasUserLikedPost(userId, postId) {
		const { rows } = await this.pool.query(
			'SELECT 1 FROM likes WHERE user_id = $1 AND post_id = $2 LIMIT 1',
			[Number(userId), Number(postId)],
		);
		return rows.length > 0;
	}

	async getLikeIds(userId) {
		const { rows } = await this.pool.query(
			'SELECT post_id FROM likes WHERE user_id = $1 ORDER BY created_at DESC',
			[Number(userId)],
		);
		return rows.map((row) => Number(row.post_id));
	}

	async toggleStar(userId, postId) {
		const uId = Number(userId);
		const pId = Number(postId);
		const now = new Date().toISOString();

		const result = await this._withTransaction(async (client) => {
			const delResult = await client.query(
				'DELETE FROM stars WHERE user_id = $1 AND post_id = $2 RETURNING 1',
				[uId, pId],
			);
			let starred = false;
			let count = 0;
			let tags = null;
			let changed = false;

			if (delResult.rowCount > 0) {
				const { rows } = await client.query(
					'UPDATE posts SET star_count = GREATEST(0, star_count - 1) WHERE id = $1 RETURNING star_count, tags',
					[pId],
				);
				starred = false;
				changed = true;
				count = Math.max(0, Number(rows[0]?.star_count) || 0);
				tags = rows[0]?.tags;
			} else {
				const insertResult = await client.query(
					'INSERT INTO stars (user_id, post_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING 1',
					[uId, pId, now],
				);
				if (insertResult.rowCount > 0) {
					const { rows } = await client.query(
						'UPDATE posts SET star_count = star_count + 1 WHERE id = $1 RETURNING star_count, tags',
						[pId],
					);
					starred = true;
					changed = true;
					count = Math.max(0, Number(rows[0]?.star_count) || 0);
					tags = rows[0]?.tags;
				} else {
					const { rows } = await client.query(
						'SELECT star_count, tags FROM posts WHERE id = $1',
						[pId],
					);
					starred = true;
					count = Math.max(0, Number(rows[0]?.star_count) || 0);
					tags = rows[0]?.tags;
				}
			}

			if (tags && changed) {
				const delta = starred ? 3 : -3;
				await this._adjustUserKeywordAffinitiesForTags(client, uId, tags, delta);
			}

			return { starred, count };
		});
		const cachedPost = this._getPostCache()?.get(pId);
		if (cachedPost) {
			this._getPostCache()?.set(pId, {
				...cachedPost,
				star_count: result.count,
				starCount: result.count,
			});
		}
		this._updateCachedPostMetrics(pId, { star_count: result.count });
		this._updateCachedPostReaction(pId, uId, 'star', result.starred);
		return result;
	}

	async getStarCount(postId) {
		const { rows } = await this.pool.query(
			'SELECT star_count FROM posts WHERE id = $1',
			[Number(postId)],
		);
		return Number(rows[0]?.star_count || 0);
	}

	async hasUserStarredPost(userId, postId) {
		const { rows } = await this.pool.query(
			'SELECT 1 FROM stars WHERE user_id = $1 AND post_id = $2 LIMIT 1',
			[Number(userId), Number(postId)],
		);
		return rows.length > 0;
	}

	async getStarIds(userId) {
		const { rows } = await this.pool.query(
			'SELECT post_id FROM stars WHERE user_id = $1 ORDER BY created_at DESC',
			[Number(userId)],
		);
		return rows.map((row) => Number(row.post_id));
	}

	async togglePin(userId, postId) {
		const result = await this._withTransaction(async (client) => {
			const post = await client.query(
				'SELECT user_id FROM posts WHERE id = $1',
				[Number(postId)],
			);
			if (!post.rows[0] || Number(post.rows[0].user_id) !== Number(userId)) {
				throw new Error('Cannot pin a post you do not own');
			}

			const existing = await client.query(
				'SELECT 1 FROM pinned_posts WHERE user_id = $1 AND post_id = $2',
				[Number(userId), Number(postId)],
			);
			if (existing.rows.length > 0) {
				await client.query(
					'DELETE FROM pinned_posts WHERE user_id = $1 AND post_id = $2',
					[Number(userId), Number(postId)],
				);
				return { pinned: false };
			}
			const now = new Date().toISOString();
			await client.query(
				'INSERT INTO pinned_posts (user_id, post_id, created_at) VALUES ($1, $2, $3)',
				[Number(userId), Number(postId), now],
			);
			return { pinned: true };
		});
		this._invalidateProfileStatsCache(userId);
		return result;
	}

	async getPinnedPosts(userId) {
		const { rows } = await this.pool.query(
			`SELECT p.* FROM posts p
			 JOIN pinned_posts pp ON pp.post_id = p.id
			 WHERE pp.user_id = $1
			 ORDER BY pp.created_at DESC`,
			[Number(userId)],
		);
		return rows.map(normalizePostRow);
	}

	async getPinnedPostId(userId) {
		const { rows } = await this.pool.query(
			`SELECT post_id FROM pinned_posts
			 WHERE user_id = $1
			 ORDER BY created_at DESC
			 LIMIT 1`,
			[Number(userId)],
		);
		return rows.length > 0 ? Number(rows[0].post_id) : null;
	}

	async repostPost(userId, postId) {
		return this._withTransaction(async (client) => {
			const original = await client.query('SELECT * FROM posts WHERE id = $1', [Number(postId)]);
			if (!original.rows[0]) throw new Error('Post not found');

			const existing = await client.query(
				'SELECT 1 FROM reposts WHERE user_id = $1 AND post_id = $2',
				[Number(userId), Number(postId)],
			);
			if (existing.rows.length > 0) throw new Error('Already reposted');

			const now = new Date().toISOString();
			await client.query(
				'INSERT INTO reposts (user_id, post_id, created_at) VALUES ($1, $2, $3)',
				[Number(userId), Number(postId), now],
			);
			await client.query(
				'UPDATE posts SET repost_count = repost_count + 1 WHERE id = $1',
				[Number(postId)],
			);

			const origRow = original.rows[0];
			const { rows: created } = await client.query(
				`INSERT INTO posts (user_id, content, attachments, mask, lock, repost_to, created_at)
				 VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
				 RETURNING *`,
				[
					Number(userId),
					origRow.content,
					origRow.attachments ? JSON.stringify(origRow.attachments) : null,
					origRow.mask,
					origRow.lock,
					Number(postId),
					now,
				],
			);
			const post = normalizePostRow(created[0]);
			if (post) {
				this._getPostCache()?.set(post.id, post);
			}
			const parentId = Number(postId);
			const cachedParent = this._getPostCache()?.get(parentId);
			if (cachedParent) {
				const repostCount = (Number(cachedParent.repost_count ?? cachedParent.repostCount) || 0) + 1;
				this._getPostCache()?.set(parentId, { ...cachedParent, repost_count: repostCount, repostCount });
			}
			const cachedMetrics = this._getPostMetricsCache()?.get(parentId);
			if (cachedMetrics) {
				this._updateCachedPostMetrics(parentId, {
					repost_count: (Number(cachedMetrics.repost_count) || 0) + 1,
				});
			}
			return post;
		});
	}

	async getReposts(userId) {
		const { rows } = await this.pool.query(
			`SELECT p.* FROM posts p
			 JOIN reposts r ON r.post_id = p.repost_to
			 WHERE r.user_id = $1
			 ORDER BY r.created_at DESC`,
			[Number(userId)],
		);
		return rows.map(normalizePostRow);
	}

	async getRepostsOfPost(postId, limit = 50) {
		const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
		const { rows } = await this.pool.query(
			`SELECT u.id as user_id, u.name, u.handle, u.icon_data, u.verify, u.admin, u.bio, r.created_at as reposted_at
			 FROM reposts r
			 JOIN users u ON u.id = r.user_id
			 WHERE r.post_id = $1
			 ORDER BY r.created_at DESC
			 LIMIT $2`,
			[Number(postId), safeLimit],
		);
		return rows.map((r) => ({
			user_id: Number(r.user_id),
			id: Number(r.user_id),
			name: r.name,
			handle: r.handle,
			icon_data: r.icon_data,
			verify: Boolean(r.verify),
			admin: Boolean(r.admin),
			bio: r.bio,
			reposted_at: toIsoString(r.reposted_at),
		}));
	}

	async getLikesOfPost(postId, limit = 50) {
		const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
		const { rows } = await this.pool.query(
			`SELECT u.id as user_id, u.name, u.handle, u.icon_data, u.verify, u.admin, u.bio, l.created_at as liked_at
			 FROM likes l
			 JOIN users u ON u.id = l.user_id
			 WHERE l.post_id = $1
			 ORDER BY l.created_at DESC
			 LIMIT $2`,
			[Number(postId), safeLimit],
		);
		return rows.map((r) => ({
			user_id: Number(r.user_id),
			id: Number(r.user_id),
			name: r.name,
			handle: r.handle,
			icon_data: r.icon_data,
			verify: Boolean(r.verify),
			admin: Boolean(r.admin),
			bio: r.bio,
			liked_at: toIsoString(r.liked_at),
		}));
	}

	async getStarsOfPost(postId, limit = 50) {
		const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
		const { rows } = await this.pool.query(
			`SELECT u.id as user_id, u.name, u.handle, u.icon_data, u.verify, u.admin, u.bio, s.created_at as starred_at
			 FROM stars s
			 JOIN users u ON u.id = s.user_id
			 WHERE s.post_id = $1
			 ORDER BY s.created_at DESC
			 LIMIT $2`,
			[Number(postId), safeLimit],
		);
		return rows.map((r) => ({
			user_id: Number(r.user_id),
			id: Number(r.user_id),
			name: r.name,
			handle: r.handle,
			icon_data: r.icon_data,
			verify: Boolean(r.verify),
			admin: Boolean(r.admin),
			bio: r.bio,
			starred_at: toIsoString(r.starred_at),
		}));
	}

	async getQuotesOfPost(postId, limit = 50) {
		const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
		const { rows } = await this.pool.query(
			`SELECT * FROM posts
			 WHERE repost_to = $1 AND content IS NOT NULL AND content != ''
			 ORDER BY created_at DESC
			 LIMIT $2`,
			[Number(postId), safeLimit],
		);
		return rows.map(normalizePostRow);
	}

	async getRepostCount(postId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int as count FROM reposts WHERE post_id = $1',
			[Number(postId)],
		);
		return Number(rows[0]?.count || 0);
	}

	// ==================== Direct Messages ====================

	async getDmList(userId) {
		const { rows } = await this.pool.query(
			'SELECT * FROM dm_channels WHERE $1::int = ANY(participants)',
			[Number(userId)],
		);
		return rows.map((r) => ({
			id: r.id,
			participants: (r.participants || []).map(Number),
			created_at: toIsoString(r.created_at),
		}));
	}

	async getOrCreateDmChannel(userId1, userId2) {
		const u1 = Math.min(Number(userId1), Number(userId2));
		const u2 = Math.max(Number(userId1), Number(userId2));
		const channelId = `${u1}:${u2}`;
		const now = new Date().toISOString();

		const { rows } = await this.pool.query(
			`INSERT INTO dm_channels (id, participants, created_at)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (id) DO NOTHING
			 RETURNING *`,
			[channelId, [u1, u2], now],
		);

		if (rows.length > 0) {
			return {
				id: rows[0].id,
				participants: (rows[0].participants || []).map(Number),
				created_at: toIsoString(rows[0].created_at),
			};
		}

		const existing = await this.pool.query('SELECT * FROM dm_channels WHERE id = $1', [channelId]);
		return existing.rows[0] ? {
			id: existing.rows[0].id,
			participants: (existing.rows[0].participants || []).map(Number),
			created_at: toIsoString(existing.rows[0].created_at),
		} : null;
	}

	async getDmMessages(channelId, limit = 50, offset = 0) {
		const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
		const safeOffset = Math.max(Number(offset) || 0, 0);
		const { rows } = await this.pool.query(
			`SELECT * FROM dm_messages
			 WHERE channel_id = $1
			 ORDER BY sent_at DESC
			 LIMIT $2 OFFSET $3`,
			[String(channelId), safeLimit, safeOffset],
		);
		return rows.map((r) => ({
			id: Number(r.id),
			channelId: r.channel_id,
			channel_id: r.channel_id,
			senderId: Number(r.sender_id),
			sender_id: Number(r.sender_id),
			content: r.content,
			sentAt: toIsoString(r.sent_at),
			sent_at: toIsoString(r.sent_at),
			readAt: toIsoString(r.read_at),
			read_at: toIsoString(r.read_at),
		}));
	}

	async sendDmMessage(channelId, senderId, content, meta = {}) {
		const now = meta?.sentAt ? toIsoString(meta.sentAt) : new Date().toISOString();
		const hasExplicitId = meta?.id != null && Number.isSafeInteger(Number(meta.id)) && Number(meta.id) > 0;

		const values = [String(channelId), Number(senderId), String(content || ''), now];
		const insertQuery = hasExplicitId
			? `INSERT INTO dm_messages (id, channel_id, sender_id, content, sent_at)
			   VALUES ($5, $1, $2, $3, $4)
			   RETURNING *`
			: `INSERT INTO dm_messages (channel_id, sender_id, content, sent_at)
			   VALUES ($1, $2, $3, $4)
			   RETURNING *`;

		if (hasExplicitId) {
			values.push(Number(meta.id));
		}

		const { rows } = await this.pool.query(insertQuery, values);
		const row = rows[0];
		return row ? {
			id: Number(row.id),
			channelId: row.channel_id,
			channel_id: row.channel_id,
			senderId: Number(row.sender_id),
			sender_id: Number(row.sender_id),
			content: row.content,
			sentAt: toIsoString(row.sent_at),
			sent_at: toIsoString(row.sent_at),
			readAt: toIsoString(row.read_at),
			read_at: toIsoString(row.read_at),
		} : null;
	}

	async markDmMessagesAsRead(channelId, userId) {
		const now = new Date().toISOString();
		await this.pool.query(
			`UPDATE dm_messages SET read_at = $3
			 WHERE channel_id = $1 AND sender_id != $2 AND read_at IS NULL`,
			[String(channelId), Number(userId), now],
		);
	}

	async getUnreadDmCount(userId) {
		const { rows } = await this.pool.query(
			`SELECT COUNT(*)::int as count FROM dm_messages m
			 JOIN dm_channels c ON c.id = m.channel_id
			 WHERE $1::int = ANY(c.participants)
			   AND m.sender_id != $1
			   AND m.read_at IS NULL`,
			[Number(userId)],
		);
		return Number(rows[0]?.count || 0);
	}

	async getGroupDmsForUser(userId, { limit = 50, offset = 0 } = {}) {
		const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
		const safeOffset = Math.max(Number(offset) || 0, 0);
		const { rows } = await this.pool.query(
			`SELECT * FROM group_dms WHERE $1::INTEGER = ANY(member)
			 ORDER BY time DESC LIMIT $2 OFFSET $3`,
			[Number(userId), safeLimit, safeOffset],
		);
		return rows.map((row) => normalizeGroupDmRow(row, Number(userId)));
	}

	async getGroupDmVisibilityDataForUser(userId) {
		const { rows } = await this.pool.query(
			`SELECT id, member, unread FROM group_dms WHERE $1::INTEGER = ANY(member)`,
			[Number(userId)],
		);
		return rows.map((row) => ({
			id: String(row.id),
			member: (row.member || []).map(Number),
			unread: typeof row.unread === 'object' && row.unread !== null ? row.unread : parseJsonSafe(row.unread, {}),
		}));
	}

	async getGroupDm(dmId) {
		if (!dmId) return null;
		const { rows } = await this.pool.query(
			'SELECT * FROM group_dms WHERE id = $1 LIMIT 1',
			[String(dmId)],
		);
		return normalizeGroupDmRow(rows[0] || null);
	}

	async createGroupDm(dmData) {
		const hostId = Number(dmData.hostId);
		const member = Array.from(new Set((dmData.member || [hostId]).map(Number).filter(Number.isInteger)));
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const title = String(dmData.title || '');
		const unreadObj = dmData.unread && typeof dmData.unread === 'object' ? { ...dmData.unread } : {};
		if (Array.isArray(dmData.accepted)) {
			unreadObj._accepted = dmData.accepted.map(Number).filter(Number.isInteger);
		}

		const { rows } = await this.pool.query(
			`INSERT INTO group_dms (id, host_id, title, member, post, unread, time, created_at)
			 VALUES ($1, $2, $3, $4::int[], '[]'::jsonb, $5::jsonb, $6, $6)
			 RETURNING *`,
			[id, hostId, title, member, JSON.stringify(unreadObj), now],
		);
		return normalizeGroupDmRow(rows[0], hostId);
	}

	async updateGroupDm(dmId, updates) {
		const sets = [];
		const values = [];
		let i = 1;

		if (updates.title !== undefined) {
			sets.push(`title = $${i++}`);
			values.push(String(updates.title));
		}
		if (updates.member !== undefined) {
			const memberSet = Array.from(new Set(updates.member.map(Number).filter(Number.isInteger)));
			sets.push(`member = $${i++}::int[]`);
			values.push(memberSet);
		}
		if (updates.host_id !== undefined || updates.hostId !== undefined) {
			sets.push(`host_id = $${i++}`);
			values.push(Number(updates.host_id ?? updates.hostId));
		}
		if (updates.post !== undefined) {
			sets.push(`post = $${i++}::jsonb`);
			values.push(JSON.stringify(updates.post));
		}
		if (updates.unread !== undefined) {
			sets.push(`unread = $${i++}::jsonb`);
			values.push(JSON.stringify(updates.unread));
		} else if (updates.accepted !== undefined) {
			const existing = await this.getGroupDm(dmId);
			const unreadObj = existing?.unread && typeof existing.unread === 'object' ? { ...existing.unread } : {};
			unreadObj._accepted = Array.from(new Set(updates.accepted.map(Number).filter(Number.isInteger)));
			sets.push(`unread = $${i++}::jsonb`);
			values.push(JSON.stringify(unreadObj));
		}
		if (updates.time !== undefined) {
			sets.push(`time = $${i++}`);
			values.push(toIsoString(updates.time));
		}

		if (sets.length === 0) {
			return this.getGroupDm(dmId);
		}

		values.push(String(dmId));
		const { rows } = await this.pool.query(
			`UPDATE group_dms SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
			values,
		);
		if (!rows[0]) return null;
		return normalizeGroupDmRow(rows[0]);
	}

	async appendToGroupDm(dmId, message, senderId = null) {
		return this._withTransaction(async (client) => {
			const { rows: existingRows } = await client.query(
				'SELECT * FROM group_dms WHERE id = $1 FOR UPDATE',
				[String(dmId)],
			);
			const row = existingRows[0];
			if (!row) return null;

			const time = message.time ? toIsoString(message.time) : new Date().toISOString();
			const posts = Array.isArray(row.post) ? row.post : parseJsonSafe(row.post, []);
			posts.push(message);

		const unread = { ...(typeof row.unread === 'object' && row.unread !== null ? row.unread : parseJsonSafe(row.unread, {})) };
		if (senderId !== null) {
			unread[String(senderId)] = 0;
			for (const memberId of row.member || []) {
					const normalizedMemberId = Number(memberId);
					if (normalizedMemberId === Number(senderId)) continue;
					const key = String(normalizedMemberId);
					unread[key] = Number(unread[key] || 0) + 1;
				}
			}

			const { rows } = await client.query(
				`UPDATE group_dms
				 SET post = $1::jsonb,
				     time = $2,
				     unread = $3::jsonb
				 WHERE id = $4
				 RETURNING *`,
				[JSON.stringify(posts), time, JSON.stringify(unread), String(dmId)],
			);
			return normalizeGroupDmRow(rows[0], senderId);
		});
	}

	async markGroupDmRead(dmId, userId) {
		return this._withTransaction(async (client) => {
			const { rows } = await client.query('SELECT unread FROM group_dms WHERE id = $1 FOR UPDATE', [String(dmId)]);
			if (!rows[0]) return;
			const unread = { ...(typeof rows[0].unread === 'object' && rows[0].unread !== null ? rows[0].unread : parseJsonSafe(rows[0].unread, {})) };
			unread[String(userId)] = 0;
			await client.query('UPDATE group_dms SET unread = $2::jsonb WHERE id = $1', [String(dmId), JSON.stringify(unread)]);
		});
	}

	async getGroupDmUnreadCounts(userId) {
		const { rows } = await this.pool.query(
			'SELECT id, member, unread FROM group_dms WHERE $1::int = ANY(member)',
			[Number(userId)],
		);
		const counts = [];
		for (const r of rows) {
			const unread = typeof r.unread === 'object' && r.unread !== null ? r.unread : parseJsonSafe(r.unread, {});
			counts.push({ dm_id: r.id, unread_count: Number(unread[String(userId)] || 0) });
		}
		return counts;
	}

	async getGroupDmUnreadTotal(userId) {
		const { rows } = await this.pool.query(
			`SELECT COALESCE(SUM(COALESCE((unread ->> $2)::int, 0)), 0)::int AS total
			 FROM group_dms WHERE $1::int = ANY(member)`,
			[Number(userId), String(userId)],
		);
		return Number(rows[0]?.total || 0);
	}

	async deleteGroupDm(dmId) {
		const { rowCount } = await this.pool.query('DELETE FROM group_dms WHERE id = $1', [String(dmId)]);
		return rowCount > 0;
	}

	async leaveGroupDm(dmId, userId) {
		return this._withTransaction(async (client) => {
			const { rows } = await client.query('SELECT member, unread FROM group_dms WHERE id = $1 FOR UPDATE', [String(dmId)]);
			if (!rows[0]) return false;

			const members = (rows[0].member || []).map(Number).filter((id) => id !== Number(userId));
			const unread = { ...(typeof rows[0].unread === 'object' && rows[0].unread !== null ? rows[0].unread : parseJsonSafe(rows[0].unread, {})) };
			delete unread[String(userId)];

			await client.query(
				'UPDATE group_dms SET member = $2::int[], unread = $3::jsonb WHERE id = $1',
				[String(dmId), members, JSON.stringify(unread)],
			);
			return true;
		});
	}

	async findGroupDmByMembers(memberIds) {
		const target = Array.from(new Set(memberIds.map(Number).filter(Number.isInteger))).sort((a, b) => a - b);
		if (target.length === 0) return null;
		const { rows } = await this.pool.query(
			`SELECT * FROM group_dms
			 WHERE cardinality(member) = $1
			   AND member @> $2::int[] AND member <@ $2::int[]`,
			[target.length, target],
		);
		if (!rows[0]) return null;
		return normalizeGroupDmRow(rows[0]);
	}

	async getDmPublicKeys(userIds) {
		const ids = Array.from(
			new Set((userIds || []).map(Number).filter((id) => Number.isInteger(id) && id >= 0)),
		);
		if (ids.length === 0) return [];
		const { rows } = await this.pool.query(
			'SELECT user_id, public_key FROM dm_e2e_keys WHERE user_id = ANY($1::int[])',
			[ids],
		);
		return rows.map((row) => ({ user_id: Number(row.user_id), public_key: String(row.public_key) }));
	}

	async setDmPublicKey(userId, publicKey) {
		const now = new Date().toISOString();
		await this.pool.query(
			`INSERT INTO dm_e2e_keys (user_id, public_key, created_at, updated_at)
			 VALUES ($1, $2, $3, $3)
			 ON CONFLICT (user_id)
			 DO UPDATE SET public_key = EXCLUDED.public_key, updated_at = EXCLUDED.updated_at`,
			[Number(userId), String(publicKey), now],
		);
	}

	// ==================== Follows ====================

	async toggleFollow(followerId, followingId) {
		const u1 = Number(followerId);
		const u2 = Number(followingId);
		if (u1 === u2) {
			throw new Error('Cannot follow yourself');
		}

		const now = new Date().toISOString();
		const result = await this._withTransaction(async (client) => {
			const delResult = await client.query(
				'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2 RETURNING 1',
				[u1, u2],
			);
			if (delResult.rowCount > 0) {
				return { following: false };
			}
			await client.query(
				'INSERT INTO follows (follower_id, following_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
				[u1, u2, now],
			);
			return { following: true };
		});
		const followCache = this._followCache?.get(u1);
		if (followCache?.follows instanceof Set) {
			if (result.following) followCache.follows.add(u2);
			else followCache.follows.delete(u2);
			this._followCache.set(u1, followCache);
		}
		this._invalidateProfileStatsCache(u1);
		this._invalidateProfileStatsCache(u2);
		return result;
	}

	async toggleBlock(userId, targetUserId) {
		const u1 = Number(userId);
		const u2 = Number(targetUserId);
		if (!Number.isInteger(u1) || !Number.isInteger(u2) || u1 <= 0 || u2 <= 0) {
			throw new Error('Invalid user ID');
		}
		if (u1 === u2) {
			throw new Error('Cannot block yourself');
		}

		return this._withTransaction(async (client) => {
			const userRes = await client.query('SELECT id, "block" FROM users WHERE id = $1 FOR UPDATE', [u1]);
			if (userRes.rows.length === 0) {
				throw new Error('User not found');
			}
			const rawBlock = parseJsonSafe(userRes.rows[0].block, []);
			const currentBlock = normalizeBlockList(rawBlock, u1);
			const isBlocked = currentBlock.includes(u2);
			const newBlock = isBlocked
				? currentBlock.filter((id) => id !== u2)
				: [...currentBlock, u2];
			const normalized = normalizeBlockList(newBlock, u1);
			await client.query('UPDATE users SET "block" = $2::jsonb WHERE id = $1', [u1, JSON.stringify(normalized)]);

			if (!isBlocked) {
				await client.query(
					'DELETE FROM follows WHERE (follower_id = $1 AND following_id = $2) OR (follower_id = $2 AND following_id = $1)',
					[u1, u2],
				);
				this._followCache?.delete(u1);
				this._followCache?.delete(u2);
			}

			this._updateCachedUser(u1, { block: normalized });
			this._invalidateProfileStatsCache(u1);
			this._invalidateProfileStatsCache(u2);

			return {
				blocked: !isBlocked,
				block: normalized,
			};
		});
	}

	async isFollowing(followerId, followingId) {
		const { rows } = await this.pool.query(
			'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2 LIMIT 1',
			[Number(followerId), Number(followingId)],
		);
		return rows.length > 0;
	}

	async getPublicProfileStats(userId) {
		const targetUserId = Number(userId);
		if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
			return {
				followingCount: 0, followerCount: 0, postCount: 0, mediaCount: 0, pinnedPostId: null,
				following_count: 0, follower_count: 0, post_count: 0, media_count: 0, pinned_post_id: null,
			};
		}

		const cache = this._getProfileStatsCache();
		const cached = cache?.get(targetUserId);
		if (cached) return cached;

		const { rows } = await this.pool.query(
			`SELECT
				(SELECT COUNT(*)::int FROM follows WHERE follower_id = $1) AS following_count,
				(SELECT COUNT(*)::int FROM follows WHERE following_id = $1) AS follower_count,
				(SELECT COUNT(*)::int FROM posts WHERE user_id = $1 AND group_id IS NULL) AS post_count,
				(SELECT COUNT(*)::int FROM posts
					WHERE user_id = $1 AND group_id IS NULL
						AND attachments IS NOT NULL
						AND jsonb_typeof(attachments) = 'array'
						AND jsonb_array_length(attachments) > 0) AS media_count,
				(SELECT post_id FROM pinned_posts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1) AS pinned_post_id,
				COALESCE((
					SELECT jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'icon_data', g.icon_data))
					FROM (
						SELECT g.id, g.name, g.icon_data
						FROM group_memberships gm
						JOIN groups g ON g.id = gm.group_id
						WHERE gm.user_id = $1 AND gm.status = 'active'
						  AND g.deleted_at IS NULL AND g.icon_data IS NOT NULL AND g.icon_data <> ''
						  AND g.visibility IN ('open', 'open_invite')
						ORDER BY gm.joined_at DESC NULLS LAST, g.created_at DESC
						LIMIT 5
					) g
				), '[]'::jsonb) AS group_badges`,
			[targetUserId],
		);
		const row = rows[0] || {};
		const groupBadges = Array.isArray(row.group_badges)
			? row.group_badges
			: (typeof row.group_badges === 'string' ? JSON.parse(row.group_badges || '[]') : []);
		const stats = {
			followingCount: Math.max(0, Number(row.following_count) || 0),
			followerCount: Math.max(0, Number(row.follower_count) || 0),
			postCount: Math.max(0, Number(row.post_count) || 0),
			mediaCount: Math.max(0, Number(row.media_count) || 0),
			pinnedPostId: row.pinned_post_id != null ? Number(row.pinned_post_id) : null,
			following_count: Math.max(0, Number(row.following_count) || 0),
			follower_count: Math.max(0, Number(row.follower_count) || 0),
			post_count: Math.max(0, Number(row.post_count) || 0),
			media_count: Math.max(0, Number(row.media_count) || 0),
			pinned_post_id: row.pinned_post_id != null ? Number(row.pinned_post_id) : null,
			groupBadges,
			group_badges: groupBadges,
		};
		cache?.set(targetUserId, stats);
		return stats;
	}

	async getFollowing(userId, limit = 100, offset = 0, { cursor = null, withNextCursor = false } = {}) {
		const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
		const decodedCursor = typeof cursor === 'string' && cursor.trim() ? decodePostCursor(cursor.trim()) : null;
		const fetchLimit = safeLimit + 1;
		let query;
		let params;

		if (decodedCursor) {
			query = `SELECT u.*, f.created_at AS follow_created_at FROM follows f
			 JOIN users u ON u.id = f.following_id
			 WHERE f.follower_id = $1 AND (f.created_at < $2 OR (f.created_at = $2 AND f.following_id < $3))
			 ORDER BY f.created_at DESC, f.following_id DESC
			 LIMIT $4`;
			params = [Number(userId), decodedCursor.createdAt, decodedCursor.id, fetchLimit];
		} else {
			const safeOffset = Math.max(Number(offset) || 0, 0);
			query = `SELECT u.*, f.created_at AS follow_created_at FROM follows f
			 JOIN users u ON u.id = f.following_id
			 WHERE f.follower_id = $1
			 ORDER BY f.created_at DESC, f.following_id DESC
			 LIMIT $2 OFFSET $3`;
			params = [Number(userId), fetchLimit, safeOffset];
		}

		const { rows } = await this.pool.query(query, params);
		const hasMore = rows.length > safeLimit;
		const slice = rows.slice(0, safeLimit);
		const lastRow = slice.length > 0 ? slice[slice.length - 1] : null;
		const nextCursor = hasMore && lastRow
			? encodePostCursor({ id: lastRow.id, created_at: lastRow.follow_created_at })
			: null;
		const users = slice.map(normalizeUserRow);

		if (withNextCursor) {
			return { users, has_more: hasMore, next_cursor: nextCursor };
		}
		return users;
	}

	async getFollowers(userId, limit = 100, offset = 0, { cursor = null, withNextCursor = false } = {}) {
		const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
		const decodedCursor = typeof cursor === 'string' && cursor.trim() ? decodePostCursor(cursor.trim()) : null;
		const fetchLimit = safeLimit + 1;
		let query;
		let params;

		if (decodedCursor) {
			query = `SELECT u.*, f.created_at AS follow_created_at FROM follows f
			 JOIN users u ON u.id = f.follower_id
			 WHERE f.following_id = $1 AND (f.created_at < $2 OR (f.created_at = $2 AND f.follower_id < $3))
			 ORDER BY f.created_at DESC, f.follower_id DESC
			 LIMIT $4`;
			params = [Number(userId), decodedCursor.createdAt, decodedCursor.id, fetchLimit];
		} else {
			const safeOffset = Math.max(Number(offset) || 0, 0);
			query = `SELECT u.*, f.created_at AS follow_created_at FROM follows f
			 JOIN users u ON u.id = f.follower_id
			 WHERE f.following_id = $1
			 ORDER BY f.created_at DESC, f.follower_id DESC
			 LIMIT $2 OFFSET $3`;
			params = [Number(userId), fetchLimit, safeOffset];
		}

		const { rows } = await this.pool.query(query, params);
		const hasMore = rows.length > safeLimit;
		const slice = rows.slice(0, safeLimit);
		const lastRow = slice.length > 0 ? slice[slice.length - 1] : null;
		const nextCursor = hasMore && lastRow
			? encodePostCursor({ id: lastRow.id, created_at: lastRow.follow_created_at })
			: null;
		const users = slice.map(normalizeUserRow);

		if (withNextCursor) {
			return { users, has_more: hasMore, next_cursor: nextCursor };
		}
		return users;
	}

	async getFollowIds(userId) {
		const { rows } = await this.pool.query(
			`SELECT following_id FROM follows
			 WHERE follower_id = $1
			 ORDER BY created_at DESC, following_id ASC`,
			[Number(userId)],
		);
		return rows.map((row) => Number(row.following_id));
	}

	async getFollowRelationshipSnapshot(userId, candidateUserIds) {
		const normalizedUserId = Number(userId);
		const ids = [...new Set((candidateUserIds || [])
			.map(Number)
			.filter((id) => Number.isInteger(id) && id !== normalizedUserId))].slice(0, 500);
		if (!Number.isSafeInteger(normalizedUserId) || ids.length === 0) {
			return { followingIds: [], followerIds: [] };
		}
		const { rows } = await this.pool.query(
			`SELECT following_id AS user_id, 'following' AS direction
			 FROM follows
			 WHERE follower_id = $1 AND following_id = ANY($2::int[])
			 UNION ALL
			 SELECT follower_id AS user_id, 'follower' AS direction
			 FROM follows
			 WHERE following_id = $1 AND follower_id = ANY($2::int[])`,
			[normalizedUserId, ids],
		);
		const followingIds = [];
		const followerIds = [];
		for (const row of rows) {
			if (row.direction === 'following') followingIds.push(Number(row.user_id));
			if (row.direction === 'follower') followerIds.push(Number(row.user_id));
		}
		return { followingIds, followerIds };
	}

	async getFollowingCount(userId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int AS count FROM follows WHERE follower_id = $1',
			[Number(userId)],
		);
		return Number(rows[0]?.count || 0);
	}

	async getFollowerCount(userId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int AS count FROM follows WHERE following_id = $1',
			[Number(userId)],
		);
		return Number(rows[0]?.count || 0);
	}

	// ==================== Notifications ====================

	async createNotification(notificationData) {
		const target = normalizeTarget(notificationData.target, {
			postId: notificationData.postId,
			open: notificationData.open,
		});
		const now = notificationData.createdAt ? toIsoString(notificationData.createdAt) : new Date().toISOString();
		const hasExplicitId = notificationData.id != null && Number.isSafeInteger(Number(notificationData.id)) && Number(notificationData.id) > 0;

		const values = [
			Number(notificationData.userId),
			String(notificationData.type),
			notificationData.fromUserId != null ? Number(notificationData.fromUserId) : null,
			target?.kind === 'post' ? Number(target.id) : (notificationData.postId != null ? Number(notificationData.postId) : null),
			target ? JSON.stringify(target) : null,
			typeof notificationData.message === 'string' ? notificationData.message : null,
			now,
		];

		const insertQuery = hasExplicitId
			? `INSERT INTO notifications
				 (id, user_id, type, from_user_id, post_id, target, message, read, clicked, created_at)
				 VALUES ($8, $1, $2, $3, $4, $5::jsonb, $6, false, false, $7)
			   RETURNING *`
			: `INSERT INTO notifications
				 (user_id, type, from_user_id, post_id, target, message, read, clicked, created_at)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6, false, false, $7)
			   RETURNING *`;

		if (hasExplicitId) {
			values.push(Number(notificationData.id));
		}

		const { rows } = await this.pool.query(insertQuery, values);
		const row = rows[0];
		if (!row) return null;
		return {
			id: Number(row.id),
			userId: Number(row.user_id),
			user_id: Number(row.user_id),
			type: row.type,
			fromUserId: row.from_user_id != null ? Number(row.from_user_id) : null,
			from_user_id: row.from_user_id != null ? Number(row.from_user_id) : null,
			postId: row.post_id != null ? Number(row.post_id) : null,
			post_id: row.post_id != null ? Number(row.post_id) : null,
			target: parseJsonSafe(row.target, null),
			message: row.message || null,
			read: Boolean(row.read),
			clicked: Boolean(row.clicked),
			createdAt: toIsoString(row.created_at),
			created_at: toIsoString(row.created_at),
		};
	}

	async getNotifications(userId, limit = 50, offset = 0) {
		const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
		const safeOffset = Math.max(Number(offset) || 0, 0);
		const { rows } = await this.pool.query(
			`SELECT n.*,
			        u.id AS from_user_id, u.name AS from_user_name, u.scid AS from_user_scid, u.handle AS from_user_handle, u.icon_data AS from_user_icon_data, u.settings AS from_user_settings, u.block AS from_user_block, u.created_at AS from_user_created_at,
			        p.id AS target_post_id, p.content AS target_post_content, p.view_content AS target_post_view_content, p.created_at AS target_post_created_at
			 FROM notifications n
			 LEFT JOIN users u ON u.id = n.from_user_id
			 LEFT JOIN posts p ON p.id = n.post_id
			 WHERE n.user_id = $1
			 ORDER BY n.created_at DESC, n.id DESC
			 LIMIT $2 OFFSET $3`,
			[Number(userId), safeLimit, safeOffset],
		);
		return rows.map((r) => {
			const fromUser = r.from_user_id != null ? {
				id: Number(r.from_user_id),
				name: r.from_user_name,
				scid: r.from_user_scid,
				handle: r.from_user_handle,
				icon_data: r.from_user_icon_data,
				settings: r.from_user_settings,
				block: r.from_user_block,
				created_at: toIsoString(r.from_user_created_at),
			} : null;
			const targetPost = r.target_post_id != null ? {
				id: Number(r.target_post_id),
				content: r.target_post_content,
				view_content: r.target_post_view_content,
				created_at: toIsoString(r.target_post_created_at),
			} : null;
			return {
				id: Number(r.id),
				userId: Number(r.user_id),
				user_id: Number(r.user_id),
				type: r.type,
				fromUserId: r.from_user_id != null ? Number(r.from_user_id) : null,
				from_user_id: r.from_user_id != null ? Number(r.from_user_id) : null,
				fromUser,
				postId: r.post_id != null ? Number(r.post_id) : null,
				post_id: r.post_id != null ? Number(r.post_id) : null,
				targetPost,
				target: parseJsonSafe(r.target, null),
				message: r.message || null,
				read: Boolean(r.read),
				clicked: Boolean(r.clicked),
				createdAt: toIsoString(r.created_at),
				created_at: toIsoString(r.created_at),
			};
		});
	}

	async markNotificationAsRead(notificationId) {
		await this.pool.query(
			'UPDATE notifications SET read = true WHERE id = $1',
			[Number(notificationId)],
		);
		return { success: true };
	}

	async markNotificationAsClicked(notificationId) {
		await this.pool.query(
			'UPDATE notifications SET clicked = true WHERE id = $1',
			[Number(notificationId)],
		);
		return { success: true };
	}

	async getNotificationById(notificationId) {
		const { rows } = await this.pool.query(
			'SELECT * FROM notifications WHERE id = $1',
			[Number(notificationId)],
		);
		const r = rows[0];
		if (!r) return null;
		return {
			id: Number(r.id),
			userId: Number(r.user_id),
			user_id: Number(r.user_id),
			type: r.type,
			fromUserId: r.from_user_id != null ? Number(r.from_user_id) : null,
			from_user_id: r.from_user_id != null ? Number(r.from_user_id) : null,
			postId: r.post_id != null ? Number(r.post_id) : null,
			post_id: r.post_id != null ? Number(r.post_id) : null,
			target: parseJsonSafe(r.target, null),
			message: r.message || null,
			read: Boolean(r.read),
			clicked: Boolean(r.clicked),
			createdAt: toIsoString(r.created_at),
			created_at: toIsoString(r.created_at),
		};
	}

	async markAllNotificationsAsRead(userId) {
		await this.pool.query(
			'UPDATE notifications SET read = true WHERE user_id = $1 AND read = false',
			[Number(userId)],
		);
		return { success: true };
	}

	async markAllNotificationsAsClicked(userId) {
		await this.pool.query(
			'UPDATE notifications SET read = true, clicked = true WHERE user_id = $1 AND (read = false OR clicked = false)',
			[Number(userId)],
		);
		return { success: true };
	}

	async deleteNotification(notificationId) {
		const { rowCount } = await this.pool.query(
			'DELETE FROM notifications WHERE id = $1',
			[Number(notificationId)],
		);
		return rowCount > 0;
	}

	async getUnreadNotificationCount(userId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int as count FROM notifications WHERE user_id = $1 AND read = false',
			[Number(userId)],
		);
		return Number(rows[0]?.count || 0);
	}

	// ==================== Moderation Reports ====================

	async createModerationReport(reportData) {
		const now = reportData.createdAt ? toIsoString(reportData.createdAt) : new Date().toISOString();
		const assignmentType = ['freeze_appeal', 'verification_application'].includes(reportData.assignmentType)
			? reportData.assignmentType
			: 'report';
		const hasExplicitId = reportData.id != null && Number.isSafeInteger(Number(reportData.id)) && Number(reportData.id) > 0;

		const values = [
			Number(reportData.reporterUserId),
			String(reportData.targetKind),
			String(reportData.targetId),
			String(reportData.description || ''),
			JSON.stringify(reportData.targetSnapshot || {}),
			assignmentType,
			now,
		];

		const insertQuery = hasExplicitId
			? `INSERT INTO moderation_reports
				(id, reporter_user_id, target_kind, target_id, description, target_snapshot, assignment_type, status, excluded_admin_ids, created_at)
			   VALUES ($8, $1, $2, $3, $4, $5::jsonb, $6, 'pending', '[]'::jsonb, $7)
			   RETURNING *`
			: `INSERT INTO moderation_reports
				(reporter_user_id, target_kind, target_id, description, target_snapshot, assignment_type, status, excluded_admin_ids, created_at)
			   VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'pending', '[]'::jsonb, $7)
			   RETURNING *`;

		if (hasExplicitId) {
			values.push(Number(reportData.id));
		}

		const { rows } = await this.pool.query(insertQuery, values);
		return normalizeModerationReportRow(rows[0]);
	}

	async getOpenModerationAppealByUserId(userId) {
		const { rows } = await this.pool.query(
			`SELECT * FROM moderation_reports
			 WHERE reporter_user_id = $1 AND assignment_type = 'freeze_appeal' AND status <> 'resolved'
			 ORDER BY created_at DESC LIMIT 1`,
			[Number(userId)],
		);
		return normalizeModerationReportRow(rows[0]);
	}

	async getOpenModerationVerificationByUserId(userId) {
		const { rows } = await this.pool.query(
			`SELECT * FROM moderation_reports
			 WHERE reporter_user_id = $1 AND assignment_type = 'verification_application' AND status <> 'resolved'
			 ORDER BY created_at DESC LIMIT 1`,
			[Number(userId)],
		);
		return normalizeModerationReportRow(rows[0]);
	}

	async getModerationReportById(reportId) {
		const { rows } = await this.pool.query(
			'SELECT * FROM moderation_reports WHERE id = $1 LIMIT 1',
			[Number(reportId)],
		);
		return normalizeModerationReportRow(rows[0]);
	}

	async listModerationReportsForAdmin(adminId, options = {}) {
		const status = options.status || 'assigned';
		const limit = Math.max(1, Math.min(Number(options.limit) || 50, 100));
		const offset = Math.max(0, Number(options.offset) || 0);
		const { rows } = await this.pool.query(
			`SELECT * FROM moderation_reports
			 WHERE assigned_admin_id = $1
			   AND ($2::text IS NULL OR status = $2)
			 ORDER BY COALESCE(assigned_at, created_at) DESC, id DESC
			 LIMIT $3 OFFSET $4`,
			[Number(adminId), status || null, limit, offset],
		);
		return rows.map(normalizeModerationReportRow);
	}

	async getModerationAdminWorkloads(excludedAdminIds = []) {
		const excluded = [...new Set((excludedAdminIds || []).map(Number).filter(Number.isInteger))];
		const { rows } = await this.pool.query(
			`SELECT u.id AS admin_id, COUNT(r.id)::int AS active_count
			 FROM users u
			 LEFT JOIN moderation_reports r
			   ON r.assigned_admin_id = u.id AND r.status = 'assigned'
			 WHERE u.admin = TRUE
			   AND COALESCE(u."freeze", '') = ''
			   AND NOT (u.id = ANY($1::int[]))
			 GROUP BY u.id`,
			[excluded],
		);
		return rows.map((row) => ({
			adminId: Number(row.admin_id),
			activeCount: Number(row.active_count || 0),
		}));
	}

	async assignModerationReport(reportId, assignment = {}) {
		return this._withTransaction(async (client) => {
			const existingRes = await client.query('SELECT * FROM moderation_reports WHERE id = $1 FOR UPDATE', [Number(reportId)]);
			const existing = existingRes.rows[0];
			if (!existing || existing.status === 'resolved') return null;

			if (Object.prototype.hasOwnProperty.call(assignment, 'expectedAdminId') &&
				existing.assigned_admin_id !== null &&
				Number(existing.assigned_admin_id) !== Number(assignment.expectedAdminId)) {
				return null;
			}

			const rawExistingExcluded = Array.isArray(existing.excluded_admin_ids) ? existing.excluded_admin_ids : parseJsonSafe(existing.excluded_admin_ids, []);
			const excluded = [...new Set((Array.isArray(assignment.excludedAdminIds) ? assignment.excludedAdminIds : rawExistingExcluded)
				.map(Number)
				.filter(Number.isInteger))];
			const assignedAt = assignment.assignedAt ? toIsoString(assignment.assignedAt) : new Date().toISOString();

			const { rows } = await client.query(
				`UPDATE moderation_reports
				 SET status = 'assigned', assigned_admin_id = $2,
					 assigned_at = $3,
					 excluded_admin_ids = $4::jsonb
				 WHERE id = $1
				 RETURNING *`,
				[Number(reportId), Number(assignment.adminId), assignedAt, JSON.stringify(excluded)],
			);
			return normalizeModerationReportRow(rows[0]);
		});
	}

	async getOverdueModerationReports(cutoff) {
		const cutoffIso = toIsoString(cutoff);
		const { rows } = await this.pool.query(
			`SELECT * FROM moderation_reports
			 WHERE status = 'assigned' AND assigned_at IS NOT NULL AND assigned_at <= $1::timestamptz
			 ORDER BY assigned_at ASC`,
			[cutoffIso],
		);
		return rows.map(normalizeModerationReportRow);
	}

	async getUnassignedModerationReports(limit = 100) {
		const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
		const { rows } = await this.pool.query(
			`SELECT * FROM moderation_reports
			 WHERE status = 'pending'
			 ORDER BY created_at ASC, id ASC LIMIT $1`,
			[safeLimit],
		);
		return rows.map(normalizeModerationReportRow);
	}

	async resolveModerationReport(reportId, adminId, resolution) {
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`UPDATE moderation_reports
			 SET status = 'resolved', resolution = $3::jsonb, resolved_at = $4
			 WHERE id = $1 AND assigned_admin_id = $2 AND status = 'assigned'
			 RETURNING *`,
			[Number(reportId), Number(adminId), JSON.stringify(resolution || {}), now],
		);
		return normalizeModerationReportRow(rows[0]);
	}

	async deleteModerationReport(reportId) {
		const result = await this.pool.query(
			'DELETE FROM moderation_reports WHERE id = $1',
			[Number(reportId)],
		);
		return result.rowCount > 0;
	}

	// ==================== Push Subscriptions ====================

	async upsertPushSubscription(userId, subscription) {
		const now = new Date().toISOString();
		const expTime = subscription.expirationTime ? new Date(Number(subscription.expirationTime)).toISOString() : null;
		const { rows } = await this.pool.query(
			`INSERT INTO push_subscriptions
				(user_id, endpoint, expiration_time, p256dh, auth, session_token, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
			 ON CONFLICT (user_id, endpoint)
			 DO UPDATE SET
				expiration_time = EXCLUDED.expiration_time,
				p256dh = EXCLUDED.p256dh,
				auth = EXCLUDED.auth,
				session_token = COALESCE(EXCLUDED.session_token, push_subscriptions.session_token),
				updated_at = EXCLUDED.updated_at
			 RETURNING *`,
			[
				Number(userId),
				String(subscription.endpoint),
				expTime,
				String(subscription.keys?.p256dh || ''),
				String(subscription.keys?.auth || ''),
				subscription.sessionToken ? String(subscription.sessionToken) : null,
				now,
			],
		);
		const r = rows[0];
		if (!r) return null;
		return {
			userId: Number(r.user_id),
			endpoint: r.endpoint,
			expirationTime: r.expiration_time ? new Date(r.expiration_time).getTime() : null,
			keys: { p256dh: r.p256dh, auth: r.auth },
			sessionToken: r.session_token || null,
		};
	}

	async getPushSubscriptions(userId) {
		const { rows } = await this.pool.query(
			`SELECT endpoint, expiration_time, p256dh, auth, session_token
			 FROM push_subscriptions
			 WHERE user_id = $1`,
			[Number(userId)],
		);
		return rows.map((row) => ({
			endpoint: row.endpoint,
			expirationTime: row.expiration_time ? new Date(row.expiration_time).getTime() : null,
			keys: { p256dh: row.p256dh, auth: row.auth },
			sessionToken: row.session_token || null,
		}));
	}

	async deletePushSubscription(userId, endpoint) {
		const result = await this.pool.query(
			'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
			[Number(userId), String(endpoint)],
		);
		return result.rowCount > 0;
	}

	// ==================== User Account State & Batch Profile Data ====================

	async getUserAccountState(userId) {
		const { rows } = await this.pool.query(
			`SELECT
				COALESCE((
					SELECT array_agg(following_id ORDER BY created_at DESC, following_id ASC)
					FROM follows WHERE follower_id = $1
				), ARRAY[]::INTEGER[]) AS follow_ids,
				COALESCE((
					SELECT array_agg(post_id ORDER BY created_at DESC)
					FROM likes WHERE user_id = $1
				), ARRAY[]::INTEGER[]) AS like_ids,
				COALESCE((
					SELECT array_agg(post_id ORDER BY created_at DESC)
					FROM stars WHERE user_id = $1
				), ARRAY[]::INTEGER[]) AS star_ids,
				(
					SELECT post_id FROM pinned_posts WHERE user_id = $1
					ORDER BY created_at DESC LIMIT 1
				) AS pinned_post_id`,
			[Number(userId)],
		);
		const normalizeIds = (values) => (Array.isArray(values) ? values : [])
			.map(Number)
			.filter((id) => Number.isSafeInteger(id) && id > 0);
		const state = rows[0] || {};
		const result = {
			follow: normalizeIds(state.follow_ids),
			like: normalizeIds(state.like_ids),
			star: normalizeIds(state.star_ids),
			pin: state.pinned_post_id != null && Number.isSafeInteger(Number(state.pinned_post_id))
				? Number(state.pinned_post_id)
				: null,
		};
		return result;
	}

	async getUserBootstrapData(userId, notificationLimit = 200) {
		const normalizedLimit = Math.min(Math.max(Number(notificationLimit) || 200, 1), 200);
		const { rows } = await this.pool.query(
			`WITH notification_rows AS (
				SELECT * FROM notifications
				WHERE user_id = $1
				ORDER BY created_at DESC, id DESC
				LIMIT $2
			), notification_users AS (
				SELECT DISTINCT u.*
				FROM users u
				JOIN notification_rows n ON n.from_user_id = u.id
			), notification_posts AS (
				SELECT DISTINCT p.id, p.content
				FROM posts p
				JOIN notification_rows n ON n.post_id = p.id
			)
			SELECT
				COALESCE((
					SELECT array_agg(following_id ORDER BY created_at DESC, following_id ASC)
					FROM follows WHERE follower_id = $1
				), ARRAY[]::INTEGER[]) AS follow_ids,
				COALESCE((
					SELECT array_agg(post_id ORDER BY created_at DESC)
					FROM likes WHERE user_id = $1
				), ARRAY[]::INTEGER[]) AS like_ids,
				COALESCE((
					SELECT array_agg(post_id ORDER BY created_at DESC)
					FROM stars WHERE user_id = $1
				), ARRAY[]::INTEGER[]) AS star_ids,
				(
					SELECT post_id FROM pinned_posts WHERE user_id = $1
					ORDER BY created_at DESC LIMIT 1
				) AS pinned_post_id,
				(SELECT COUNT(*)::int FROM notifications WHERE user_id = $1 AND read = false)
					AS unread_notification_count,
				COALESCE((
					SELECT jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'icon_data', g.icon_data))
					FROM (
						SELECT g.id, g.name, g.icon_data
						FROM group_memberships gm
						JOIN groups g ON g.id = gm.group_id
						WHERE gm.user_id = $1 AND gm.status = 'active'
						  AND g.deleted_at IS NULL AND g.icon_data IS NOT NULL AND g.icon_data <> ''
						  AND g.visibility IN ('open', 'open_invite')
						ORDER BY gm.joined_at DESC NULLS LAST, g.created_at DESC
						LIMIT 5
					) g
				), '[]'::jsonb) AS group_badges,
				COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.created_at DESC, n.id DESC) FROM notification_rows n), '[]'::jsonb)
					AS notifications,
				COALESCE((SELECT jsonb_agg(to_jsonb(u)) FROM notification_users u), '[]'::jsonb)
					AS notification_users,
				COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM notification_posts p), '[]'::jsonb)
					AS notification_posts`,
			[Number(userId), normalizedLimit],
		);
		const normalizeIds = (values) => (Array.isArray(values) ? values : [])
			.map(Number)
			.filter((id) => Number.isSafeInteger(id) && id > 0);
		const result = rows[0] || {};
		const rawNotifs = Array.isArray(result.notifications) ? result.notifications : parseJsonSafe(result.notifications, []);
		const rawUsers = Array.isArray(result.notification_users) ? result.notification_users : parseJsonSafe(result.notification_users, []);
		const rawPosts = Array.isArray(result.notification_posts) ? result.notification_posts : parseJsonSafe(result.notification_posts, []);
		const rawBadges = Array.isArray(result.group_badges) ? result.group_badges : parseJsonSafe(result.group_badges, []);

		return {
			follow: normalizeIds(result.follow_ids),
			like: normalizeIds(result.like_ids),
			star: normalizeIds(result.star_ids),
			pin: result.pinned_post_id != null && Number.isSafeInteger(Number(result.pinned_post_id))
				? Number(result.pinned_post_id)
				: null,
			unreadCount: Math.max(0, Number(result.unread_notification_count) || 0),
			group_badges: rawBadges.map((gb) => ({
				id: String(gb.id),
				name: String(gb.name || ''),
				icon_data: gb.icon_data,
			})),
			notifications: rawNotifs.map((r) => ({
				id: Number(r.id),
				userId: Number(r.user_id),
				user_id: Number(r.user_id),
				type: r.type,
				fromUserId: r.from_user_id != null ? Number(r.from_user_id) : null,
				from_user_id: r.from_user_id != null ? Number(r.from_user_id) : null,
				postId: r.post_id != null ? Number(r.post_id) : null,
				post_id: r.post_id != null ? Number(r.post_id) : null,
				target: parseJsonSafe(r.target, null),
				message: r.message || null,
				read: Boolean(r.read),
				clicked: Boolean(r.clicked),
				createdAt: toIsoString(r.created_at),
				created_at: toIsoString(r.created_at),
			})),
			notificationUsers: rawUsers.map(normalizeUserRow).filter(Boolean),
			notificationPosts: rawPosts.filter(Boolean),
		};
	}

	// ==================== Rankings ====================

	async getRanking(type, limit = 50) {
		const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
		let query;
		if (type === 'followers') {
			query = `WITH top_users AS (
				SELECT following_id AS user_id, COUNT(*)::int AS follower_count
				FROM follows
				GROUP BY following_id
				ORDER BY follower_count DESC, following_id ASC
				LIMIT $1
			)
			SELECT u.id AS user_id, u.name, u.scid, u.icon_data, tu.follower_count
			FROM top_users tu
			JOIN users u ON u.id = tu.user_id
			ORDER BY tu.follower_count DESC, tu.user_id ASC`;
		} else if (type === 'posts') {
			query = `WITH top_users AS (
				SELECT user_id, COUNT(*)::int AS post_count
				FROM posts
				WHERE group_id IS NULL
				GROUP BY user_id
				ORDER BY post_count DESC, user_id ASC
				LIMIT $1
			)
			SELECT u.id AS user_id, u.name, u.scid, u.icon_data, tu.post_count
			FROM top_users tu
			JOIN users u ON u.id = tu.user_id
			ORDER BY tu.post_count DESC, tu.user_id ASC`;
		} else if (type === 'likes') {
			query = `WITH top_users AS (
				SELECT p.user_id, COUNT(*)::int AS like_count
				FROM likes l
				JOIN posts p ON p.id = l.post_id
				GROUP BY p.user_id
				ORDER BY like_count DESC, p.user_id ASC
				LIMIT $1
			)
			SELECT u.id AS user_id, u.name, u.scid, u.icon_data, tu.like_count
			FROM top_users tu
			JOIN users u ON u.id = tu.user_id
			ORDER BY tu.like_count DESC, tu.user_id ASC`;
		} else if (type === 'stars') {
			query = `WITH top_users AS (
				SELECT p.user_id, COUNT(*)::int AS star_count
				FROM stars s
				JOIN posts p ON p.id = s.post_id
				GROUP BY p.user_id
				ORDER BY star_count DESC, p.user_id ASC
				LIMIT $1
			)
			SELECT u.id AS user_id, u.name, u.scid, u.icon_data, tu.star_count
			FROM top_users tu
			JOIN users u ON u.id = tu.user_id
			ORDER BY tu.star_count DESC, tu.user_id ASC`;
		} else {
			throw new Error('Invalid ranking type');
		}
		const { rows } = await this.pool.query(query, [safeLimit]);
		return rows.map((r) => ({
			user_id: Number(r.user_id),
			name: r.name,
			scid: r.scid || null,
			icon_data: r.icon_data || null,
			...(r.follower_count !== undefined ? { follower_count: Number(r.follower_count) } : {}),
			...(r.post_count !== undefined ? { post_count: Number(r.post_count) } : {}),
			...(r.like_count !== undefined ? { like_count: Number(r.like_count) } : {}),
			...(r.star_count !== undefined ? { star_count: Number(r.star_count) } : {}),
		}));
	}

	async getUserRanking(type, userId) {
		const targetId = Number(userId);
		let query;
		if (type === 'followers') {
			query = `WITH my_count AS (
				SELECT COUNT(*)::int AS cnt FROM follows WHERE following_id = $1
			), higher AS (
				SELECT COUNT(*)::int AS rank_offset
				FROM (
					SELECT following_id, COUNT(*)::int AS c
					FROM follows
					GROUP BY following_id
					HAVING COUNT(*)::int > (SELECT cnt FROM my_count)
				) h
			)
			SELECT (SELECT cnt FROM my_count) AS follower_count,
			       (SELECT rank_offset + 1 FROM higher) AS rank`;
		} else if (type === 'posts') {
			query = `WITH my_count AS (
				SELECT COUNT(*)::int AS cnt FROM posts WHERE user_id = $1 AND group_id IS NULL
			), higher AS (
				SELECT COUNT(*)::int AS rank_offset
				FROM (
					SELECT user_id, COUNT(*)::int AS c
					FROM posts
					WHERE group_id IS NULL
					GROUP BY user_id
					HAVING COUNT(*)::int > (SELECT cnt FROM my_count)
				) h
			)
			SELECT (SELECT cnt FROM my_count) AS post_count,
			       (SELECT rank_offset + 1 FROM higher) AS rank`;
		} else if (type === 'likes') {
			query = `WITH my_count AS (
				SELECT COUNT(*)::int AS cnt
				FROM likes l JOIN posts p ON p.id = l.post_id
				WHERE p.user_id = $1
			), higher AS (
				SELECT COUNT(*)::int AS rank_offset
				FROM (
					SELECT p.user_id, COUNT(*)::int AS c
					FROM likes l JOIN posts p ON p.id = l.post_id
					GROUP BY p.user_id
					HAVING COUNT(*)::int > (SELECT cnt FROM my_count)
				) h
			)
			SELECT (SELECT cnt FROM my_count) AS like_count,
			       (SELECT rank_offset + 1 FROM higher) AS rank`;
		} else if (type === 'stars') {
			query = `WITH my_count AS (
				SELECT COUNT(*)::int AS cnt
				FROM stars s JOIN posts p ON p.id = s.post_id
				WHERE p.user_id = $1
			), higher AS (
				SELECT COUNT(*)::int AS rank_offset
				FROM (
					SELECT p.user_id, COUNT(*)::int AS c
					FROM stars s JOIN posts p ON p.id = s.post_id
					GROUP BY p.user_id
					HAVING COUNT(*)::int > (SELECT cnt FROM my_count)
				) h
			)
			SELECT (SELECT cnt FROM my_count) AS star_count,
			       (SELECT rank_offset + 1 FROM higher) AS rank`;
		} else {
			throw new Error('Invalid ranking type');
		}
		const { rows } = await this.pool.query(query, [targetId]);
		const metricField = type === 'followers' ? 'follower_count' : (type === 'posts' ? 'post_count' : (type === 'likes' ? 'like_count' : 'star_count'));
		return rows[0] ? {
			rank: Number(rows[0].rank || 1),
			[metricField]: Number(rows[0][metricField] || 0),
		} : { rank: null, [metricField]: 0 };
	}

	// ==================== Logs ====================

	async addLog(entry) {
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`INSERT INTO logs (scratch_id, nyaitter_id, masked_ip_uuid, log_time)
			 VALUES ($1, $2, $3, $4)
			 RETURNING id`,
			[entry.scratch_id || '', entry.nyaitter_id != null ? Number(entry.nyaitter_id) : null, entry.masked_ip_uuid || '', now],
		);
		return rows[0] ? { id: Number(rows[0].id) } : { success: true };
	}

	async getLogs(limit = 20, offset = 0) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
		const normalizedOffset = Math.max(0, Number(offset) || 0);
		const { rows } = await this.pool.query(
			`SELECT * FROM logs
			 ORDER BY log_time DESC, id DESC
			 LIMIT $1 OFFSET $2`,
			[normalizedLimit, normalizedOffset],
		);
		return rows.map((r) => ({
			id: Number(r.id),
			scratch_id: r.scratch_id,
			nyaitter_id: r.nyaitter_id != null ? Number(r.nyaitter_id) : null,
			masked_ip_uuid: r.masked_ip_uuid,
			log_time: toIsoString(r.log_time),
		}));
	}

	async getUserPostSubscribers(authorUserId) {
		const { rows } = await this.pool.query(
			`SELECT id, settings->'user_notifications'->>$1 AS mode
			 FROM users
			 WHERE settings->'user_notifications'->>$1 IN ('important', 'media', 'all')`,
			[String(authorUserId)],
		);
		return rows.map((r) => ({
			userId: Number(r.id),
			mode: r.mode,
		}));
	}

	// ==================== Polls ====================

	_formatPoll(pollRow, voteRows = [], currentUserId = null) {
		if (!pollRow) return null;
		const parsedUserId = currentUserId != null ? String(currentUserId).trim() : null;
		const validUserId = parsedUserId && /^[A-Za-z0-9_-]+$/.test(parsedUserId) ? parsedUserId : null;
		let rawOptions = [];
		if (Array.isArray(pollRow.options)) {
			rawOptions = pollRow.options;
		} else if (typeof pollRow.options === 'string') {
			try {
				rawOptions = JSON.parse(pollRow.options);
			} catch (_) {
				rawOptions = [];
			}
		}
		
		// 票の集計
		const voteCounts = new Map();
		const otherVotes = [];
		const myVotes = [];
		let myOtherText = null;
		const uniqueVoters = new Set();

		for (const vote of voteRows) {
			const vUserId = String(vote.user_id);
			uniqueVoters.add(vUserId);
			const optId = Number(vote.option_id);
			voteCounts.set(optId, (voteCounts.get(optId) || 0) + 1);

			if (optId === -1 && vote.other_text) {
				otherVotes.push({
					text: String(vote.other_text),
					userId: vUserId,
				});
			}

			if (validUserId && vUserId === validUserId) {
				myVotes.push(optId);
				if (optId === -1 && vote.other_text) {
					myOtherText = String(vote.other_text);
				}
			}
		}

		const totalVotesCount = voteRows.length;
		const totalVotersCount = uniqueVoters.size;

		const options = rawOptions.map((opt) => {
			const id = Number(opt.id);
			const count = voteCounts.get(id) || 0;
			return {
				id,
				text: String(opt.text || ''),
				votes_count: count,
				percentage: totalVotesCount > 0 ? Math.round((count / totalVotesCount) * 100) : 0,
			};
		});

		const otherCount = voteCounts.get(-1) || 0;
		const isExpired = Boolean(pollRow.expires_at && new Date(pollRow.expires_at) <= new Date()) || Boolean(pollRow.closed);
		const hasVoted = myVotes.length > 0;
		const showResultsBeforeVoting = Boolean(pollRow.show_results_before_voting);

		return {
			id: String(pollRow.id),
			post_id: String(pollRow.post_id),
			user_id: String(pollRow.user_id),
			title: String(pollRow.title || ''),
			options,
			allow_multiple: Boolean(pollRow.allow_multiple),
			allow_other: Boolean(pollRow.allow_other),
			show_results_before_voting: showResultsBeforeVoting,
			other_count: otherCount,
			other_percentage: totalVotesCount > 0 ? Math.round((otherCount / totalVotesCount) * 100) : 0,
			other_votes: isExpired || hasVoted || showResultsBeforeVoting ? otherVotes : [],
			total_votes: totalVotesCount,
			total_voters: totalVotersCount,
			my_votes: myVotes,
			my_other_text: myOtherText,
			has_voted: hasVoted,
			expires_at: pollRow.expires_at ? toIsoString(pollRow.expires_at) : null,
			is_expired: isExpired,
			closed: Boolean(pollRow.closed),
			created_at: toIsoString(pollRow.created_at),
		};
	}

	async createPoll({
		id = null,
		postId,
		userId,
		title,
		options,
		allowMultiple = false,
		allowOther = false,
		showResultsBeforeVoting = true,
		expiresAt = null,
	}) {
		const normOptions = Array.isArray(options) ? options.map((opt, idx) => ({
			id: Number(opt.id ?? idx + 1),
			text: String(opt.text ?? opt).trim(),
		})).filter((opt) => opt.text.length > 0) : [];

		if (normOptions.length < 2) {
			throw new Error('投票には最低2つの選択肢が必要です');
		}

		const pollId = id != null
			? (Number(id) || String(id).trim())
			: Number(`${Date.now() % 1000000000}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`);
		const pId = Number(postId) || String(postId).trim();
		const uId = Number(userId) || String(userId).trim();

		const { rows } = await this.pool.query(
			`INSERT INTO polls (id, post_id, user_id, title, options, allow_multiple, allow_other, show_results_before_voting, expires_at)
			 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
			 RETURNING *`,
			[
				pollId,
				pId,
				uId,
				String(title || '').trim() || '投票',
				JSON.stringify(normOptions),
				Boolean(allowMultiple),
				Boolean(allowOther),
				Boolean(showResultsBeforeVoting),
				expiresAt ? toIsoString(expiresAt) : null,
			],
		);
		return this._formatPoll(rows[0], [], uId);
	}

	async getPollByPostId(postId, currentUserId = null) {
		const pId = postId != null ? String(postId).trim() : '';
		if (!/^[A-Za-z0-9_-]+$/.test(pId)) return null;

		const { rows: pollRows } = await this.pool.query(
			'SELECT * FROM polls WHERE post_id::text = $1',
			[pId],
		);
		if (!pollRows[0]) return null;

		const { rows: voteRows } = await this.pool.query(
			'SELECT * FROM poll_votes WHERE poll_id::text = $1',
			[String(pollRows[0].id)],
		);

		return this._formatPoll(pollRows[0], voteRows, currentUserId);
	}

	async getPollById(pollId, currentUserId = null) {
		const pId = pollId != null ? String(pollId).trim() : '';
		if (!/^[A-Za-z0-9_-]+$/.test(pId)) return null;

		const { rows: pollRows } = await this.pool.query(
			'SELECT * FROM polls WHERE id::text = $1',
			[pId],
		);
		if (!pollRows[0]) return null;

		const { rows: voteRows } = await this.pool.query(
			'SELECT * FROM poll_votes WHERE poll_id::text = $1',
			[String(pollRows[0].id)],
		);

		return this._formatPoll(pollRows[0], voteRows, currentUserId);
	}

	async getPollsByPostIds(postIds, currentUserId = null) {
		const ids = [...new Set((postIds || []).map((id) => String(id).trim()).filter((id) => /^[A-Za-z0-9_-]+$/.test(id)))];
		if (ids.length === 0) return new Map();

		const { rows: pollRows } = await this.pool.query(
			'SELECT * FROM polls WHERE post_id::text = ANY($1::text[])',
			[ids],
		);
		if (pollRows.length === 0) return new Map();

		const pollIds = pollRows.map((r) => String(r.id));
		const { rows: voteRows } = await this.pool.query(
			'SELECT * FROM poll_votes WHERE poll_id::text = ANY($1::text[])',
			[pollIds],
		);

		const votesByPollId = new Map();
		for (const v of voteRows) {
			const pId = String(v.poll_id);
			if (!votesByPollId.has(pId)) votesByPollId.set(pId, []);
			votesByPollId.get(pId).push(v);
		}

		const map = new Map();
		for (const pollRow of pollRows) {
			const formatted = this._formatPoll(pollRow, votesByPollId.get(String(pollRow.id)) || [], currentUserId);
			if (formatted) map.set(Number(pollRow.post_id) || pollRow.post_id, formatted);
		}
		return map;
	}

	async votePoll({ pollId, userId, optionIds = [], otherText = null }) {
		const pId = pollId != null ? String(pollId).trim() : '';
		const uId = userId != null ? String(userId).trim() : '';
		if (!/^[A-Za-z0-9_-]+$/.test(pId) || !/^[A-Za-z0-9_-]+$/.test(uId)) {
			throw new Error('無効なパラメータです');
		}

		return this._withTransaction(async (client) => {
			const { rows: pollRows } = await client.query(
				'SELECT * FROM polls WHERE id::text = $1 FOR UPDATE',
				[pId],
			);
			const poll = pollRows[0];
			if (!poll) throw new Error('投票が見つかりません');

			const isExpired = Boolean(poll.expires_at && new Date(poll.expires_at) <= new Date()) || Boolean(poll.closed);
			if (isExpired) throw new Error('この投票は既に終了しています');

			let rawOptions = [];
			if (Array.isArray(poll.options)) {
				rawOptions = poll.options;
			} else if (typeof poll.options === 'string') {
				try {
					rawOptions = JSON.parse(poll.options);
				} catch (_) {
					rawOptions = [];
				}
			}

			const validOptionIds = new Set(rawOptions.map((o) => Number(o.id)));
			if (poll.allow_other) {
				validOptionIds.add(-1); // その他用のID
			}

			let targetOptionIds = [...new Set((optionIds || []).map(Number).filter((id) => validOptionIds.has(id)))];
			const isOtherSelected = targetOptionIds.includes(-1);
			const sanitizedOtherText = isOtherSelected && typeof otherText === 'string' ? otherText.trim().slice(0, 200) : null;

			if (targetOptionIds.length === 0) {
				throw new Error('選択肢を1つ以上選択してください');
			}

			if (!poll.allow_multiple && targetOptionIds.length > 1) {
				targetOptionIds = [targetOptionIds[0]];
			}

			// 既存の投票を削除
			await client.query(
				'DELETE FROM poll_votes WHERE poll_id::text = $1 AND user_id::text = $2',
				[String(poll.id), uId],
			);

			// 新規投票を挿入
			const now = new Date().toISOString();
			for (const optId of targetOptionIds) {
				const voteId = Number(`${Date.now() % 1000000000}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`);
				await client.query(
					`INSERT INTO poll_votes (id, poll_id, user_id, option_id, other_text, created_at)
					 VALUES ($1, $2, $3, $4, $5, $6)`,
					[voteId, poll.id, Number(uId) || uId, optId, optId === -1 ? sanitizedOtherText : null, now],
				);
			}

			// 更新後の全票を取得
			const { rows: voteRows } = await client.query(
				'SELECT * FROM poll_votes WHERE poll_id::text = $1',
				[String(poll.id)],
			);

			return this._formatPoll(poll, voteRows, uId);
		});
	}

	async getExpiredUnnotifiedPolls() {
		const { rows } = await this.pool.query(
			`SELECT * FROM polls
			 WHERE expires_at IS NOT NULL AND expires_at <= NOW() AND closed_notified = FALSE
			 LIMIT 50`,
		);
		return rows;
	}

	async markPollClosedNotified(pollId) {
		const pId = Number(pollId);
		if (!Number.isFinite(pId) || pId <= 0) return;

		await this.pool.query(
			'UPDATE polls SET closed = TRUE, closed_notified = TRUE WHERE id = $1',
			[pId],
		);
	}

	async getPollVoters(pollId) {
		const pId = pollId != null ? String(pollId).trim() : '';
		if (!/^[A-Za-z0-9_-]+$/.test(pId)) return [];

		const { rows } = await this.pool.query(
			'SELECT DISTINCT user_id FROM poll_votes WHERE poll_id::text = $1',
			[pId],
		);
		return rows.map((r) => String(r.user_id)).filter((id) => /^[A-Za-z0-9_-]+$/.test(id));
	}
}

module.exports = PostgresAdapter;
