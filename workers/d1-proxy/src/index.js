function json(data, status = 200, headers = {}) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			...headers,
		},
	});
}

function badRequest(message = 'Bad Request') {
	return json({ error: message }, 400);
}

function unauthorized(message = 'Unauthorized') {
	return json({ error: message }, 401);
}

function notFound(message = 'Not Found') {
	return json({ error: message }, 404);
}

function internalError(error) {
	console.error('[d1-proxy] Internal Error:', error);
	// D1/SQLiteの詳細や内部実装を呼び出し元へ露出しない。
	return json({ error: 'Internal Server Error' }, 500);
}

function formatNyaitterId(id) {
	const num = Number(id);
	if (!Number.isSafeInteger(num) || num < 0) return '#0000';
	return `#${String(num).padStart(4, '0')}`;
}

async function secureTokenEqual(provided, expected) {
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest('SHA-256', enc.encode(String(provided))),
		crypto.subtle.digest('SHA-256', enc.encode(String(expected))),
	]);
	const aBytes = new Uint8Array(a);
	const bBytes = new Uint8Array(b);
	let diff = 0;
	for (let i = 0; i < aBytes.length; i += 1) {
		diff |= aBytes[i] ^ bBytes[i];
	}
	return diff === 0;
}

function encodePostCursor(post) {
	if (!post) return null;
	const id = Number(post.id ?? post.i);
	if (!Number.isInteger(id) || id <= 0) return null;
	const rawDate = post.createdAt ?? post.created_at ?? post.c;
	const parsedDate = rawDate ? new Date(rawDate) : null;
	if (!parsedDate || Number.isNaN(parsedDate.getTime())) return null;

	const payload = JSON.stringify([parsedDate.toISOString(), id]);
	if (typeof Buffer !== 'undefined') {
		return Buffer.from(payload, 'utf8').toString('base64url');
	}
	return btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodePostCursor(cursor) {
	if (!cursor || typeof cursor !== 'string') return null;
	try {
		let raw;
		if (typeof Buffer !== 'undefined') {
			raw = Buffer.from(cursor.trim(), 'base64url').toString('utf8');
		} else {
			const b64 = cursor.trim().replace(/-/g, '+').replace(/_/g, '/');
			raw = atob(b64);
		}
		let createdAt = null;
		let id = null;

		if (raw.startsWith('[') && raw.endsWith(']')) {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed) && parsed.length >= 2) {
				createdAt = parsed[0];
				id = Number(parsed[1]);
			}
		} else if (raw.startsWith('{') && raw.endsWith('}')) {
			const parsed = JSON.parse(raw);
			createdAt = parsed.c || parsed.createdAt || parsed.created_at;
			id = Number(parsed.i || parsed.id);
		} else if (raw.includes('_')) {
			const parts = raw.split('_');
			createdAt = parts[0];
			id = Number(parts[1]);
		}

		if (!createdAt || !Number.isInteger(id) || id <= 0) return null;
		const parsedDate = new Date(createdAt);
		if (Number.isNaN(parsedDate.getTime())) return null;

		return {
			createdAt: parsedDate.toISOString(),
			id,
		};
	} catch {
		return null;
	}
}

// Fail-closed: when AUTH_TOKEN is not configured the proxy must refuse all
// requests. A token that was never set must never be treated as "no auth".
async function requireAuth(request, env) {
	const expected = env.AUTH_TOKEN;
	if (!expected) {
		return false;
	}
	const authHeader = request.headers.get('Authorization') || '';
	const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
	if (!token) {
		return false;
	}
	return secureTokenEqual(token, expected);
}

function parseJsonSafe(value, fallback = null) {
	if (!value) return fallback;
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch (_) {
		return fallback;
	}
}

function normalizePostTags(value) {
	const rawTags = parseJsonSafe(value, Array.isArray(value) ? value : []);
	if (!Array.isArray(rawTags)) return [];
	return [...new Set(rawTags
		.map((tag) => String(tag || '').trim().toLocaleLowerCase('ja-JP'))
		.filter((tag) => tag.length > 0 && tag.length <= 48))]
		.slice(0, 10);
}

function normalizePostEventRow(row) {
	if (!row) return null;
	let payload = {};
	try {
		payload = typeof row.payload === 'object' && row.payload !== null ? row.payload : JSON.parse(row.payload || '{}');
	} catch (_) {
		payload = {};
	}
	return {
		id: Number(row.id),
		event_type: row.event_type,
		post_id: row.post_id == null ? null : Number(row.post_id),
		payload,
		status: row.status,
		attempts: Number(row.attempts || 0),
		worker_id: row.worker_id || null,
		available_at: row.available_at,
		locked_at: row.locked_at || null,
		processed_at: row.processed_at || null,
		last_error: row.last_error || null,
		created_at: row.created_at,
	};
}

function calculateStringSimilarity(str1, str2) {
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
		let intersection = 0;
		for (let i = 0; i < len2 - 1; i++) {
			const bg = s2.slice(i, i + 2);
			if (bg1.has(bg) && bg1.get(bg) > 0) {
				intersection++;
				bg1.set(bg, bg1.get(bg) - 1);
			}
		}
		diceSim = (2 * intersection) / ((len1 - 1) + (len2 - 1));
	}

	return Math.max(substringSim, levSim, diceSim);
}

function isFuzzyMatch(text, query, threshold = 0.8) {
	const target = String(text || '').trim().toLowerCase();
	const q = String(query || '').trim().toLowerCase().replace(/^[#＃]/, '');
	if (!target || !q) return false;
	if (target.includes(q)) return true;

	const qLen = q.length;
	if (qLen <= 1) return false;

	for (const windowLen of [qLen, qLen - 1, qLen + 1]) {
		if (windowLen <= 0 || windowLen > target.length) continue;
		for (let i = 0; i <= target.length - windowLen; i++) {
			const sub = target.slice(i, i + windowLen);
			const sim = calculateStringSimilarity(sub, q);
			if (sim >= threshold) return true;
		}
	}

	return false;
}

function createAttachmentReplacementMap(replacements) {
	const replacementMap = new Map();
	for (const replacement of Array.isArray(replacements) ? replacements : []) {
		const sourceKey = typeof replacement?.sourceKey === 'string' ? replacement.sourceKey : null;
		const destinationKey = typeof replacement?.destinationKey === 'string' ? replacement.destinationKey : null;
		if (!sourceKey || !destinationKey) continue;
		replacementMap.set(sourceKey, { destinationKey, url: replacement.url ?? null });
	}
	return replacementMap;
}

function rewriteAttachmentReferences(attachments, replacementMap) {
	if (!Array.isArray(attachments) || replacementMap.size === 0) {
		return { attachments: Array.isArray(attachments) ? attachments : [], changed: false };
	}
	let changed = false;
	const rewritten = attachments.map((attachment) => {
		if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return attachment;
		const sourceKey = typeof attachment.id === 'string'
			? attachment.id
			: (typeof attachment.key === 'string' ? attachment.key : null);
		const replacement = sourceKey ? replacementMap.get(sourceKey) : null;
		if (!replacement) return attachment;
		changed = true;
		const next = { ...attachment };
		if (typeof attachment.id === 'string') next.id = replacement.destinationKey;
		if (typeof attachment.key === 'string') next.key = replacement.destinationKey;
		if (Object.prototype.hasOwnProperty.call(next, 'url')) next.url = replacement.url;
		return next;
	});
	return { attachments: rewritten, changed };
}

function formatD1PollRow(poll, voteRows = [], currentUserId = null) {
	if (!poll) return null;
	const isExpired = Boolean(poll.expires_at && new Date(poll.expires_at) <= new Date()) || Boolean(poll.closed);
	let rawOptions = [];
	try {
		rawOptions = typeof poll.options === 'string' ? JSON.parse(poll.options) : (poll.options || []);
	} catch (_) {
		rawOptions = [];
	}

	const votes = voteRows || [];
	const totalVotesCount = votes.length;
	const voterIds = new Set(votes.map((v) => Number(v.user_id)));
	const totalVotersCount = voterIds.size;

	const myVotes = [];
	let myOtherText = null;
	const votesByOption = new Map();
	let otherCount = 0;
	const otherVotes = [];

	for (const v of votes) {
		const optId = Number(v.option_id);
		const vUserId = Number(v.user_id);
		if (currentUserId != null && vUserId === Number(currentUserId)) {
			myVotes.push(optId);
			if (optId === -1 && v.other_text) {
				myOtherText = v.other_text;
			}
		}

		if (optId === -1) {
			otherCount += 1;
			if (v.other_text) {
				otherVotes.push({
					user_id: vUserId,
					text: v.other_text,
					created_at: v.created_at,
				});
			}
		} else {
			votesByOption.set(optId, (votesByOption.get(optId) || 0) + 1);
		}
	}

	const hasVoted = currentUserId != null && myVotes.length > 0;
	const showResultsBeforeVoting = Boolean(poll.show_results_before_voting);

	const formattedOptions = rawOptions.map((opt) => {
		const count = votesByOption.get(Number(opt.id)) || 0;
		const percentage = totalVotesCount > 0 ? Math.round((count / totalVotesCount) * 100) : 0;
		return {
			id: Number(opt.id),
			text: String(opt.text || ''),
			votes_count: count,
			percentage,
		};
	});

	return {
		id: poll.id,
		post_id: poll.post_id,
		user_id: poll.user_id,
		title: poll.title,
		options: formattedOptions,
		allow_multiple: Boolean(poll.allow_multiple),
		allow_other: Boolean(poll.allow_other),
		show_results_before_voting: showResultsBeforeVoting,
		other_votes_count: otherCount,
		other_percentage: totalVotesCount > 0 ? Math.round((otherCount / totalVotesCount) * 100) : 0,
		other_votes: isExpired || hasVoted || showResultsBeforeVoting ? otherVotes : [],
		total_votes: totalVotesCount,
		total_voters: totalVotersCount,
		my_votes: myVotes,
		my_other_text: myOtherText,
		has_voted: hasVoted,
		expires_at: poll.expires_at || null,
		is_expired: isExpired,
		closed: Boolean(poll.closed),
		created_at: poll.created_at,
	};
}

const MIGRATION_TABLES = [
	'users', 'sessions', 'trusted_login_ips', 'login_approvals', 'bot_tokens', 'posts',
	'likes', 'stars', 'reposts', 'pinned_posts', 'follows', 'dm_channels', 'dm_messages',
		'group_dms', 'dm_e2e_keys', 'notifications', 'push_subscriptions', 'moderation_reports', 'logs',
		'groups', 'group_roles', 'group_memberships', 'group_invites', 'group_join_requests',
		'user_keyword_affinities', 'polls', 'poll_votes',
];
const MIGRATION_COLUMNS = {
	users: ['id', 'scid', 'name', 'handle', 'nyaitter_address', 'auth_provider', 'provider_domain', 'external_id', 'external_profile', 'uuid', 'settings', 'bio', 'header_image', 'icon_data', 'verify', 'freeze', 'admin', 'shadow', 'block', 'account_operation', 'created_at'],
	sessions: ['session_id', 'token', 'user_id', 'ip_hash', 'ip_masked', 'user_agent', 'expires_at', 'created_at'],
	trusted_login_ips: ['user_id', 'ip_hash', 'ip_masked', 'created_at', 'last_used_at'],
	login_approvals: ['id', 'user_id', 'ip_hash', 'ip_masked', 'user_agent', 'poll_token_hash', 'status', 'created_at', 'expires_at', 'decided_at', 'consumed_at'],
	bot_tokens: ['token_id', 'token_hash', 'user_id', 'name', 'created_at', 'last_used_at'],
	posts: ['id', 'user_id', 'content', 'attachments', 'mask', 'lock', 'announcement', 'reply_to', 'repost_to', 'tags', 'tags_generated_at', 'group_id', 'group_announcement', 'created_at'],
	likes: ['user_id', 'post_id', 'created_at'],
	stars: ['user_id', 'post_id', 'created_at'],
	reposts: ['user_id', 'post_id', 'created_at'],
	pinned_posts: ['user_id', 'post_id', 'created_at'],
	follows: ['follower_id', 'following_id', 'created_at'],
	dm_channels: ['id', 'participants', 'created_at'],
	dm_messages: ['id', 'channel_id', 'sender_id', 'content', 'sent_at', 'read_at'],
	group_dms: ['id', 'host_id', 'title', 'member', 'post', 'unread', 'time', 'created_at'],
	dm_e2e_keys: ['user_id', 'public_key', 'created_at', 'updated_at'],
	notifications: ['id', 'user_id', 'type', 'from_user_id', 'post_id', 'target', 'message', 'read', 'clicked', 'created_at'],
	push_subscriptions: ['user_id', 'endpoint', 'expiration_time', 'p256dh', 'auth', 'session_token', 'created_at', 'updated_at'],
	moderation_reports: ['id', 'reporter_user_id', 'target_kind', 'target_id', 'description', 'target_snapshot', 'assignment_type', 'status', 'assigned_admin_id', 'assigned_at', 'excluded_admin_ids', 'resolution', 'created_at', 'resolved_at'],
	logs: ['id', 'scratch_id', 'nyaitter_id', 'masked_ip_uuid', 'log_time'],
	groups: ['id', 'owner_id', 'name', 'description', 'icon_data', 'header_image', 'visibility', 'deleted_at', 'created_at', 'updated_at'],
	group_roles: ['id', 'group_id', 'name', 'permissions', 'is_system', 'sort_order', 'created_at', 'updated_at'],
	group_memberships: ['group_id', 'user_id', 'role_id', 'status', 'joined_at', 'updated_at'],
	group_invites: ['id', 'group_id', 'inviter_id', 'invitee_id', 'status', 'created_at', 'responded_at'],
	group_join_requests: ['id', 'group_id', 'user_id', 'status', 'reviewed_by', 'created_at', 'reviewed_at'],
	user_keyword_affinities: ['user_id', 'keyword', 'score', 'updated_at'],
	polls: ['id', 'post_id', 'user_id', 'title', 'options', 'allow_multiple', 'allow_other', 'show_results_before_voting', 'expires_at', 'closed', 'closed_notified', 'created_at'],
	poll_votes: ['id', 'poll_id', 'user_id', 'option_id', 'other_text', 'created_at'],
};
const MIGRATION_JSON_COLUMNS = new Set(['external_profile', 'settings', 'block', 'attachments', 'tags', 'participants', 'member', 'post', 'unread', 'target', 'target_snapshot', 'excluded_admin_ids', 'resolution', 'permissions', 'options']);
const MIGRATION_BOOLEAN_COLUMNS = new Set(['verify', 'admin', 'shadow', 'mask', 'lock', 'announcement', 'group_announcement', 'is_system', 'read', 'clicked']);
const MIGRATION_INSERT_ORDER = ['users', 'groups', 'group_roles', 'group_memberships', 'group_invites', 'group_join_requests', 'posts', 'dm_channels', 'group_dms', 'dm_e2e_keys', 'sessions', 'trusted_login_ips', 'login_approvals', 'bot_tokens', 'follows', 'likes', 'stars', 'reposts', 'pinned_posts', 'user_keyword_affinities', 'dm_messages', 'notifications', 'push_subscriptions', 'moderation_reports', 'logs'];

function migrationValue(column, value) {
	if (value == null) return null;
	if (MIGRATION_JSON_COLUMNS.has(column)) return JSON.stringify(value);
	if (MIGRATION_BOOLEAN_COLUMNS.has(column)) return value ? 1 : 0;
	return value;
}

function safeMigrationIdentifier(value) {
	return /^[a-z_][a-z0-9_]*$/.test(value) ? value : null;
}

async function exportMigrationSnapshot(db) {
	const tables = {};
	for (const table of MIGRATION_TABLES) {
		const { results } = await db.prepare(`SELECT * FROM ${table}`).all();
		tables[table] = results || [];
	}
	return { version: 1, created_at: new Date().toISOString(), source_adapter: 'd1', tables };
}

async function importMigrationSnapshot(db, snapshot) {
	if (!snapshot || Number(snapshot.version) !== 1 || !snapshot.tables || typeof snapshot.tables !== 'object') {
		throw new Error('Invalid migration snapshot');
	}
	for (const table of MIGRATION_INSERT_ORDER.slice().reverse()) {
		await db.prepare(`DELETE FROM ${table}`).run();
	}
	for (const table of MIGRATION_INSERT_ORDER) {
		const columns = MIGRATION_COLUMNS[table];
		const rows = Array.isArray(snapshot.tables[table]) ? snapshot.tables[table] : [];
		for (const originalRow of rows) {
			const row = table === 'posts'
				? { ...originalRow, reply_to: null, repost_to: null }
				: originalRow;
			const placeholders = columns.map(() => '?').join(', ');
			await db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
				.bind(...columns.map((column) => migrationValue(column, row[column])))
				.run();
		}
	}
	for (const row of (snapshot.tables.posts || [])) {
		if (row.reply_to == null && row.repost_to == null) continue;
		await db.prepare('UPDATE posts SET reply_to = ?, repost_to = ? WHERE id = ?')
			.bind(row.reply_to ?? null, row.repost_to ?? null, row.id)
			.run();
	}
	return Object.fromEntries(MIGRATION_TABLES.map((table) => [table, Array.isArray(snapshot.tables[table]) ? snapshot.tables[table].length : 0]));
}

function normalizeBlockUserId(value) {
	if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
		return null;
	}
	const id = Number(value);
	return Number.isInteger(id) && id >= 0 ? id : null;
}

function normalizeBlockList(value, ownerUserId = null) {
	const ownerId = normalizeBlockUserId(ownerUserId);
	if (!Array.isArray(value)) return [];
	return [...new Set(value
		.map(normalizeBlockUserId)
		.filter((id) => id !== null && id !== ownerId))]
		.sort((left, right) => left - right);
}

function normalizeUserRow(row) {
	if (!row) return null;
	return {
		id: row.id,
		account_operation: row.account_operation || null,
		scid: row.scid || null,
		name: row.name || '',
		handle: row.handle || formatNyaitterId(row.id),
		nyaitter_address: row.nyaitter_address || null,
		auth_provider: row.auth_provider || 'local',
		provider_domain: row.provider_domain || null,
		external_id: row.external_id || null,
		external_profile: parseJsonSafe(row.external_profile, null),
		uuid: row.uuid || null,
		settings: parseJsonSafe(row.settings, {}),
		bio: row.bio || '',
		me: row.bio || '',
		header_image: row.header_image || null,
		icon_data: row.icon_data || null,
		verify: Boolean(row.verify),
		admin: Boolean(row.admin),
		freeze: row.freeze || null,
		shadow: Boolean(row.shadow),
		block: normalizeBlockList(parseJsonSafe(row.block, []), row.id),
		created_at: row.created_at,
	};
}

function normalizeGroupRow(row) {
	if (!row) return null;
	const ownerId = Number(row.owner_id);
	return {
		id: String(row.id), ownerId, owner_id: ownerId, name: row.name || '', description: row.description || '',
		iconData: row.icon_data ?? null, icon_data: row.icon_data ?? null, headerImage: row.header_image ?? null,
		header_image: row.header_image ?? null, visibility: row.visibility || 'open',
		memberCount: Number(row.member_count) || 0, member_count: Number(row.member_count) || 0,
		deletedAt: row.deleted_at ?? null, deleted_at: row.deleted_at ?? null, createdAt: row.created_at ?? null,
		created_at: row.created_at ?? null, updatedAt: row.updated_at ?? null, updated_at: row.updated_at ?? null,
	};
}

function normalizeGroupRoleRow(row) {
	if (!row) return null;
	const permissions = parseJsonSafe(row.permissions, []);
	return { id: String(row.id), groupId: String(row.group_id), group_id: String(row.group_id), name: row.name || '',
		permissions: Array.isArray(permissions) ? permissions.map(String) : [], isSystem: Boolean(row.is_system), is_system: Boolean(row.is_system),
		sortOrder: Number(row.sort_order) || 0, sort_order: Number(row.sort_order) || 0,
		createdAt: row.created_at ?? null, created_at: row.created_at ?? null, updatedAt: row.updated_at ?? null, updated_at: row.updated_at ?? null };
}

function normalizeGroupMembershipRow(row) {
	if (!row) return null;
	return { groupId: String(row.group_id), group_id: String(row.group_id), userId: Number(row.user_id), user_id: Number(row.user_id),
		roleId: row.role_id ?? null, role_id: row.role_id ?? null, status: row.status || 'active',
		joinedAt: row.joined_at ?? null, joined_at: row.joined_at ?? null, updatedAt: row.updated_at ?? null, updated_at: row.updated_at ?? null };
}

function normalizeGroupInviteRow(row) {
	if (!row) return null;
	return { id: String(row.id), groupId: String(row.group_id), group_id: String(row.group_id), inviterId: Number(row.inviter_id), inviter_id: Number(row.inviter_id),
		inviteeId: Number(row.invitee_id), invitee_id: Number(row.invitee_id), status: row.status || 'pending',
		createdAt: row.created_at ?? null, created_at: row.created_at ?? null, respondedAt: row.responded_at ?? null, responded_at: row.responded_at ?? null };
}

function normalizeGroupJoinRequestRow(row) {
	if (!row) return null;
	return { id: String(row.id), groupId: String(row.group_id), group_id: String(row.group_id), userId: Number(row.user_id), user_id: Number(row.user_id),
		status: row.status || 'pending', reviewedBy: row.reviewed_by ?? null, reviewed_by: row.reviewed_by ?? null,
		createdAt: row.created_at ?? null, created_at: row.created_at ?? null, reviewedAt: row.reviewed_at ?? null, reviewed_at: row.reviewed_at ?? null };
}

function normalizePostRow(row) {
	if (!row) return null;
	return {
		id: row.id,
		userId: row.user_id,
		user_id: row.user_id,
		content: row.content || '',
		tags: normalizePostTags(row.tags),
		tagsGeneratedAt: row.tags_generated_at || null,
		tags_generated_at: row.tags_generated_at || null,
		attachments: parseJsonSafe(row.attachments, []),
		mask: Boolean(row.mask),
		lock: Boolean(row.lock),
		announcement: Boolean(row.announcement),
		groupId: row.group_id ?? null,
		group_id: row.group_id ?? null,
		groupAnnouncement: Boolean(row.group_announcement),
		group_announcement: Boolean(row.group_announcement),
		replyTo: row.reply_to || null,
		reply_to: row.reply_to || null,
		repostTo: row.repost_to || null,
		repost_to: row.repost_to || null,
		...(row.like_count !== undefined ? { like_count: Number(row.like_count) || 0 } : {}),
		...(row.star_count !== undefined ? { star_count: Number(row.star_count) || 0 } : {}),
		...(row.repost_count !== undefined ? { repost_count: Number(row.repost_count) || 0 } : {}),
		...(row.reply_count !== undefined ? { reply_count: Number(row.reply_count) || 0 } : {}),
		...(row.liked_by_me !== undefined ? { liked_by_me: Boolean(row.liked_by_me) } : {}),
		...(row.starred_by_me !== undefined ? { starred_by_me: Boolean(row.starred_by_me) } : {}),
		createdAt: row.created_at,
		created_at: row.created_at,
	};
}

// 一覧レスポンス用。投稿本体を返す場合だけ、本人リアクションを1クエリで付与する。
// 件数はpostsの非正規化カウンターをそのまま利用し、一覧ごとの集計クエリを発生させない。
async function attachInlinePostMetrics(db, rows, currentUserId) {
	const posts = Array.isArray(rows) ? rows : [];
	const viewerId = Number(currentUserId);
	if (!Number.isSafeInteger(viewerId) || viewerId <= 0 || posts.length === 0) return posts;

	const ids = [...new Set(posts.map((row) => Number(row?.id)).filter((id) => Number.isSafeInteger(id) && id > 0))];
	if (ids.length === 0) return posts;
	const placeholders = ids.map(() => '?').join(', ');
	const { results } = await db.prepare(
		`SELECT post_id, 'like' AS kind FROM likes
		 WHERE user_id = ? AND post_id IN (${placeholders})
		 UNION ALL
		 SELECT post_id, 'star' AS kind FROM stars
		 WHERE user_id = ? AND post_id IN (${placeholders})`
	).bind(viewerId, ...ids, viewerId, ...ids).all();
	const liked = new Set();
	const starred = new Set();
	for (const row of results || []) {
		if (row.kind === 'like') liked.add(Number(row.post_id));
		if (row.kind === 'star') starred.add(Number(row.post_id));
	}
	return posts.map((row) => ({
		...row,
		liked_by_me: liked.has(Number(row.id)),
		starred_by_me: starred.has(Number(row.id)),
	}));
}

async function adjustUserKeywordAffinitiesForTags(db, userId, tags, delta) {
	const normalizedDelta = Number(delta);
	const normalizedTags = normalizePostTags(tags);
	if (!Number.isFinite(normalizedDelta) || normalizedDelta === 0 || normalizedTags.length === 0) return;
	const now = new Date().toISOString();
	const statements = normalizedTags.map((keyword) => db.prepare(
		`INSERT INTO user_keyword_affinities (user_id, keyword, score, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(user_id, keyword) DO UPDATE SET
		 score = MAX(0, user_keyword_affinities.score + excluded.score),
		 updated_at = excluded.updated_at`,
	).bind(Number(userId), keyword, normalizedDelta, now));
	if (statements.length > 0) await db.batch(statements);
	await db.prepare('DELETE FROM user_keyword_affinities WHERE user_id = ? AND score <= 0')
		.bind(Number(userId)).run();
}

async function adjustUserKeywordAffinities(db, userId, postId, delta) {
	const post = await db.prepare('SELECT tags FROM posts WHERE id = ?').bind(Number(postId)).first();
	await adjustUserKeywordAffinitiesForTags(db, userId, post?.tags, delta);
}

function normalizeGroupDmRow(row, viewerId = null) {
	if (!row) return null;
	const member = parseJsonSafe(row.member, []);
	const unread = parseJsonSafe(row.unread, {});
	const post = parseJsonSafe(row.post, []);
	const res = {
		id: row.id,
		host_id: row.host_id,
		title: row.title || '',
		member: Array.isArray(member) ? member.map(Number) : [],
		unread,
		post: Array.isArray(post) ? post : [],
		time: row.time,
		created_at: row.created_at,
	};
	if (viewerId != null) {
		res.unread_count = Number(unread[viewerId] ?? unread[String(viewerId)] ?? 0);
	}
	return res;
}

function normalizeModerationReportRow(row) {
	if (!row) return null;
	return {
		id: Number(row.id),
		reporterUserId: Number(row.reporter_user_id),
		targetKind: row.target_kind,
		targetId: String(row.target_id),
		description: row.description || '',
		targetSnapshot: parseJsonSafe(row.target_snapshot, {}),
		assignmentType: row.assignment_type || 'report',
		status: row.status,
		assignedAdminId: row.assigned_admin_id == null ? null : Number(row.assigned_admin_id),
		assignedAt: row.assigned_at || null,
		excludedAdminIds: Array.isArray(parseJsonSafe(row.excluded_admin_ids, []))
			? parseJsonSafe(row.excluded_admin_ids, []).map(Number).filter(Number.isInteger)
			: [],
		resolution: row.resolution ? parseJsonSafe(row.resolution, null) : null,
		createdAt: row.created_at,
		resolvedAt: row.resolved_at || null,
	};
}

export default {
	async fetch(request, env, ctx) {
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization',
				},
			});
		}

		if (!(await requireAuth(request, env))) {
			return unauthorized('Authentication required');
		}

		const db = env.DB;
		if (!db) {
			return internalError(new Error('D1 binding DB is not configured'));
		}

		const url = new URL(request.url);
		const pathname = url.pathname;
		const method = request.method;

					try {
				if (method === 'GET' && pathname === '/migration/snapshot') {
					return json(await exportMigrationSnapshot(db));
				}

				if (method === 'POST' && pathname === '/migration/snapshot/import') {
					const body = await request.json();
					if (body?.replace !== true) return badRequest('replace must be true');
					return json({ counts: await importMigrationSnapshot(db, body.snapshot) });
				}

				if (method === 'POST' && pathname === '/sessions') {

				const body = await request.json();
				const userId = Number(body.userId);
				const token = body.token || crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
				const sessionId = body.sessionId || crypto.randomUUID();
				const expiresAt = body.expiresAt || new Date(Date.now() + 30 * 86400000).toISOString();
				const ipHash = body.ipHash || null;
				const ipMasked = body.ipMasked || '不明なIPアドレス';
				const userAgent = body.userAgent || '不明な端末';
				const createdAt = new Date().toISOString();

				await db.prepare(
					`INSERT INTO sessions (session_id, token, user_id, ip_hash, ip_masked, user_agent, expires_at, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				).bind(sessionId, token, userId, ipHash, ipMasked, userAgent, expiresAt, createdAt).run();

				return json({
					session_id: sessionId,
					token,
					user_id: userId,
					ip_hash: ipHash,
					ip_masked: ipMasked,
					user_agent: userAgent,
					expires_at: expiresAt,
					created_at: createdAt,
				});
			}

			if (method === 'GET' && pathname.startsWith('/sessions/token/')) {
				const token = decodeURIComponent(pathname.slice('/sessions/token/'.length));
				const now = new Date().toISOString();
				const row = await db.prepare(
					`SELECT * FROM sessions WHERE token = ? AND expires_at > ? LIMIT 1`
				).bind(token, now).first();

				if (!row) {
					// Clean up expired sessions asynchronously
					ctx?.waitUntil?.(db.prepare('DELETE FROM sessions WHERE token = ? AND expires_at <= ?').bind(token, now).run());
					return json(null);
				}
				return json(row);
			}

			if (method === 'GET' && pathname.startsWith('/sessions/token-user/')) {
				const token = decodeURIComponent(pathname.slice('/sessions/token-user/'.length));
				const now = new Date().toISOString();
				const row = await db.prepare(
					`SELECT s.session_id, s.token, s.user_id, s.ip_hash, s.ip_masked,
							s.user_agent, s.expires_at, s.created_at,
							u.*
					 FROM sessions s INNER JOIN users u ON u.id = s.user_id
					 WHERE s.token = ? AND s.expires_at > ? LIMIT 1`
				).bind(token, now).first();
				if (!row) {
					ctx?.waitUntil?.(db.prepare('DELETE FROM sessions WHERE token = ? AND expires_at <= ?').bind(token, now).run());
					return json(null);
				}
				return json({
					session: {
						session_id: row.session_id,
						token: row.token,
						user_id: row.user_id,
						expires_at: row.expires_at,
						created_at: row.created_at,
						ip_hash: row.ip_hash,
						ip_masked: row.ip_masked,
						user_agent: row.user_agent,
					},
					user: normalizeUserRow(row),
				});
			}

			if (method === 'POST' && pathname === '/sessions/invalidate') {
				const body = await request.json();
				const token = String(body.token || '');
				const res = await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/sessions$/)) {
				const userId = Number(pathname.split('/')[2]);
				const now = new Date().toISOString();
				const { results } = await db.prepare(
					`SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC`
				).bind(userId, now).all();
				return json(results || []);
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/sessions\/invalidate-all$/)) {
				const userId = Number(pathname.split('/')[2]);
				const res = await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
				return json({ count: res.meta.changes });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/sessions\/invalidate-ip$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const ipHash = String(body.ipHash || '');
				const res = await db.prepare('DELETE FROM sessions WHERE user_id = ? AND ip_hash = ?').bind(userId, ipHash).run();
				return json({ count: res.meta.changes });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/trusted-ips$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const ipHash = String(body.ipHash);
				const ipMasked = String(body.ipMasked || '不明なIPアドレス');
				const now = new Date().toISOString();

				await db.prepare(
					`INSERT INTO trusted_login_ips (user_id, ip_hash, ip_masked, created_at, last_used_at)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT(user_id, ip_hash) DO UPDATE SET ip_masked = excluded.ip_masked, last_used_at = excluded.last_used_at`
				).bind(userId, ipHash, ipMasked, now, now).run();

				return json({ userId, ipHash, ipMasked, createdAt: now, lastUsedAt: now });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/trusted-ips\/count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM trusted_login_ips WHERE user_id = ?').bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/trusted-ips\/([^/]+)$/)) {
				const parts = pathname.split('/');
				const userId = Number(parts[2]);
				const ipHash = decodeURIComponent(parts[4]);
				const row = await db.prepare('SELECT * FROM trusted_login_ips WHERE user_id = ? AND ip_hash = ?').bind(userId, ipHash).first();
				if (!row) return json(null);
				return json({ userId: row.user_id, ipHash: row.ip_hash, ipMasked: row.ip_masked, createdAt: row.created_at, lastUsedAt: row.last_used_at });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/trusted-ips\/([^/]+)\/revoke$/)) {
				const parts = pathname.split('/');
				const userId = Number(parts[2]);
				const ipHash = decodeURIComponent(parts[4]);
				const res = await db.prepare('DELETE FROM trusted_login_ips WHERE user_id = ? AND ip_hash = ?').bind(userId, ipHash).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'POST' && pathname === '/login-approvals') {
				const body = await request.json();
				const id = body.id || crypto.randomUUID();
				const userId = Number(body.userId);
				const ipHash = body.ipHash || null;
				const ipMasked = body.ipMasked || '不明なIPアドレス';
				const userAgent = body.userAgent || '不明な端末';
				const pollTokenHash = String(body.pollTokenHash);
				const expiresAt = body.expiresAt || new Date(Date.now() + 10 * 60000).toISOString();
				const createdAt = new Date().toISOString();

				await db.prepare(
					`INSERT INTO login_approvals (id, user_id, ip_hash, ip_masked, user_agent, poll_token_hash, status, expires_at, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
				).bind(id, userId, ipHash, ipMasked, userAgent, pollTokenHash, expiresAt, createdAt).run();

				return json({ id, userId, ipHash, ipMasked, userAgent, pollTokenHash, status: 'pending', expiresAt, createdAt });
			}

			if (method === 'GET' && pathname.match(/^\/login-approvals\/([^/]+)$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const now = new Date().toISOString();
				await db.prepare("UPDATE login_approvals SET status = 'expired' WHERE id = ? AND status = 'pending' AND expires_at <= ?").bind(id, now).run();
				const row = await db.prepare('SELECT * FROM login_approvals WHERE id = ?').bind(id).first();
				return json(row || null);
			}

			if (method === 'POST' && pathname.match(/^\/login-approvals\/([^/]+)\/poll$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const now = new Date().toISOString();
				await db.prepare("UPDATE login_approvals SET status = 'expired' WHERE id = ? AND status = 'pending' AND expires_at <= ?").bind(id, now).run();
				const row = await db.prepare('SELECT * FROM login_approvals WHERE id = ? AND poll_token_hash = ?').bind(id, String(body.pollTokenHash)).first();
				return json(row || null);
			}

			if (method === 'POST' && pathname.match(/^\/login-approvals\/([^/]+)\/decision$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);
				const decision = body.decision === 'approve' ? 'approved' : 'denied';
				const now = new Date().toISOString();

				const res = await db.prepare(
					`UPDATE login_approvals SET status = ?, decided_at = ?
					 WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at > ?`
				).bind(decision, now, id, userId, now).run();

				if (res.meta.changes > 0) {
					const row = await db.prepare('SELECT * FROM login_approvals WHERE id = ?').bind(id).first();
					return json(row);
				}
				const existing = await db.prepare('SELECT * FROM login_approvals WHERE id = ?').bind(id).first();
				return json(existing && Number(existing.user_id) === userId ? existing : null);
			}

			if (method === 'POST' && pathname.match(/^\/login-approvals\/([^/]+)\/consume$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const now = new Date().toISOString();

				await db.prepare(
					`UPDATE login_approvals SET status = 'consumed', consumed_at = ?
					 WHERE id = ? AND poll_token_hash = ? AND status = 'approved' AND expires_at > ?`
				).bind(now, id, String(body.pollTokenHash), now).run();

				const row = await db.prepare('SELECT * FROM login_approvals WHERE id = ?').bind(id).first();
				return json(row || null);
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/bot-tokens$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const tokenId = String(body.tokenId);
				const tokenHash = String(body.tokenHash);
				const name = String(body.name || '');
				const createdAt = new Date().toISOString();

				await db.prepare(
					`INSERT INTO bot_tokens (token_id, token_hash, user_id, name, created_at)
					 VALUES (?, ?, ?, ?, ?)`
				).bind(tokenId, tokenHash, userId, name, createdAt).run();

				return json({ tokenId, tokenHash, userId, name, createdAt, lastUsedAt: null });
			}

			if (method === 'GET' && pathname.startsWith('/bot-tokens/')) {
				const tokenId = decodeURIComponent(pathname.slice('/bot-tokens/'.length));
				const row = await db.prepare('SELECT * FROM bot_tokens WHERE token_id = ?').bind(tokenId).first();
				return json(row ? { tokenId: row.token_id, tokenHash: row.token_hash, userId: row.user_id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at } : null);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/bot-tokens$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT * FROM bot_tokens WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all();
				return json((results || []).map((r) => ({ tokenId: r.token_id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at })));
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/bot-tokens\/([^/]+)\/revoke$/)) {
				const parts = pathname.split('/');
				const userId = Number(parts[2]);
				const tokenId = decodeURIComponent(parts[4]);
				const res = await db.prepare('DELETE FROM bot_tokens WHERE user_id = ? AND token_id = ?').bind(userId, tokenId).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'POST' && pathname.match(/^\/bot-tokens\/([^/]+)\/last-used$/)) {
				const tokenId = decodeURIComponent(pathname.split('/')[2]);
				const now = new Date().toISOString();
				await db.prepare('UPDATE bot_tokens SET last_used_at = ? WHERE token_id = ?').bind(now, tokenId).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname.startsWith('/users/scid/')) {
				const scid = decodeURIComponent(pathname.slice('/users/scid/'.length));
				const row = await db.prepare('SELECT * FROM users WHERE LOWER(scid) = LOWER(?) LIMIT 1').bind(scid).first();
				return json(normalizeUserRow(row));
			}

			if (method === 'GET' && pathname.startsWith('/users/address/')) {
				const address = decodeURIComponent(pathname.slice('/users/address/'.length));
				const row = await db.prepare('SELECT * FROM users WHERE nyaitter_address = ? LIMIT 1').bind(address).first();
				return json(normalizeUserRow(row));
			}

			if (method === 'POST' && pathname === '/users/external') {
				const body = await request.json();
				const providerDomain = body.providerDomain;
				const externalId = String(body.externalId);
				const profile = body.profile || {};
				const address = `#${externalId}@${providerDomain}`;

				let row = await db.prepare('SELECT * FROM users WHERE nyaitter_address = ? LIMIT 1').bind(address).first();
				if (row) return json(normalizeUserRow(row));

				const handle = formatNyaitterId(externalId);
				const countRow = await db.prepare('SELECT COUNT(*) as count FROM users').first();
				const count = Number(countRow?.count || 0);
				const digits = Math.max(4, String(Math.max(count, 1)).length);
				const id = Math.floor(Math.random() * (10 ** digits));
				const now = new Date().toISOString();

				await db.prepare(
						`INSERT INTO users (id, scid, name, handle, nyaitter_address, auth_provider, provider_domain, external_id, external_profile, block, bio, header_image, icon_data, created_at)
								 VALUES (?, ?, ?, ?, ?, 'nyaitter', ?, ?, ?, ?, ?, ?, ?, ?)`

					).bind(
						id, profile.name || handle, handle, address, providerDomain, externalId,
						JSON.stringify(profile.external_profile || profile),
						JSON.stringify(normalizeBlockList(profile.block, id)),
						profile.bio || profile.me || '', profile.header_image || null,
						profile.icon_data || null, now
					).run();

				const created = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
				return json(normalizeUserRow(created));
			}

			if (method === 'POST' && pathname === '/users') {
				const userData = await request.json();
				const provider = userData.auth_provider || 'local';

				for (let attempt = 0; attempt < 20; attempt += 1) {
					const countRow = await db.prepare('SELECT COUNT(*) as count FROM users').first();
					const count = Number(countRow?.count || 0);
					const digits = Math.max(4, String(Math.max(count, 1)).length);
						const id = Math.floor(Math.random() * (10 ** digits));
						const handle = provider === 'nyaitter' && userData.external_id != null
							? formatNyaitterId(userData.external_id)
							: formatNyaitterId(id);

					const address = userData.nyaitter_address || null;
					const now = new Date().toISOString();

					try {
						await db.prepare(
								`INSERT INTO users (id, scid, name, handle, nyaitter_address, auth_provider, provider_domain, external_id, external_profile, uuid, settings, block, bio, header_image, icon_data, created_at)
									 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

						).bind(
															id, userData.scid || null, userData.name || userData.scid || handle, handle, address,

							provider, userData.provider_domain || null, userData.external_id || null,
							userData.external_profile ? JSON.stringify(userData.external_profile) : null,
							userData.uuid || null, userData.settings ? JSON.stringify(userData.settings) : '{}',
							JSON.stringify(normalizeBlockList(userData.block, id)),
							userData.bio || userData.me || '', userData.header_image || null,
							userData.icon_data || null, now
						).run();

						const created = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
						return json(normalizeUserRow(created));
					} catch (err) {
						if (String(err).includes('UNIQUE') || String(err).includes('PRIMARY KEY')) continue;
						throw err;
					}
				}
				return badRequest('Could not allocate unique Nyaitter ID');
			}

			if (method === 'GET' && pathname === '/users/search') {
				const q = url.searchParams.get('q') || '';
				const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
				const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
				const withNextCursor = url.searchParams.get('withNextCursor') === 'true';
				const queryPattern = `%${q.toLowerCase()}%`;
				const digits = q.replace(/^#/, '').replace(/\D/g, '');
				const fetchLimit = limit + 1;

				let query;
				let bindings;
				if (decodedCursor) {
					query = `SELECT id, name, scid, handle, nyaitter_address, auth_provider, provider_domain, external_id, icon_data, created_at
						 FROM users
						 WHERE id > ? AND (
						    LOWER(COALESCE(scid, '')) LIKE ?
						    OR LOWER(COALESCE(name, '')) LIKE ?
						    OR LOWER(COALESCE(handle, '')) LIKE ?
						    OR CAST(id AS TEXT) LIKE ?
						 )
						 ORDER BY id ASC LIMIT ?`;
					bindings = [decodedCursor.id, queryPattern, queryPattern, queryPattern, digits ? `%${digits}%` : queryPattern, fetchLimit];
				} else {
					const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
					query = `SELECT id, name, scid, handle, nyaitter_address, auth_provider, provider_domain, external_id, icon_data, created_at
						 FROM users
						 WHERE LOWER(COALESCE(scid, '')) LIKE ?
						    OR LOWER(COALESCE(name, '')) LIKE ?
						    OR LOWER(COALESCE(handle, '')) LIKE ?
						    OR CAST(id AS TEXT) LIKE ?
						 ORDER BY id ASC LIMIT ? OFFSET ?`;
					bindings = [queryPattern, queryPattern, queryPattern, digits ? `%${digits}%` : queryPattern, fetchLimit, offset];
				}

				const { results } = await db.prepare(query).bind(...bindings).all();
				const rows = results || [];
				const hasMore = rows.length > limit;
				const slice = rows.slice(0, limit);
				const lastRow = slice.length > 0 ? slice[slice.length - 1] : null;
				const nextCursor = hasMore && lastRow
					? encodePostCursor({ id: Number(lastRow.id), created_at: lastRow.created_at || new Date(0).toISOString() })
					: null;
				const users = slice.map(normalizeUserRow);

				if (withNextCursor) {
					return json({
						users,
						has_more: hasMore,
						next_cursor: nextCursor,
					});
				}
				return json(users);
			}

			if (method === 'POST' && pathname === '/users/batch') {
				const body = await request.json();
				const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isSafeInteger) : [];
				if (ids.length === 0) return json([]);

				const placeholders = ids.map(() => '?').join(', ');
				const columns = body.projection === 'post_author'
					? 'id, auth_provider, external_id, name, scid, icon_data, verify, admin, settings, block'
					: '*';
				const { results } = await db.prepare(
					`SELECT ${columns} FROM users WHERE id IN (${placeholders})`
				).bind(...ids).all();

				return json((results || []).map(normalizeUserRow));
			}

			if (method === 'GET' && pathname === '/users') {
				const { results } = await db.prepare('SELECT * FROM users ORDER BY id ASC').all();
				return json((results || []).map(normalizeUserRow));
			}

							if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/account-operation\/begin$/)) {
					const userId = Number(pathname.split('/')[2]);
					const body = await request.json();
					const operation = String(body.operation || '');
					if (!['reassigning', 'deleting'].includes(operation)) return badRequest('Invalid account operation');
					const result = await db.prepare(
						`UPDATE users SET account_operation = ?
						 WHERE id = ? AND auth_provider <> 'nyaitter' AND account_operation IS NULL`
					).bind(operation, userId).run();
					if (result.meta.changes === 0) return json(null);
					return json(normalizeUserRow(await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first()));
				}

				if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/account-operation\/finish$/)) {
					const userId = Number(pathname.split('/')[2]);
					const body = await request.json();
					const operation = String(body.operation || '');
					const result = await db.prepare('UPDATE users SET account_operation = NULL WHERE id = ? AND account_operation = ?')
						.bind(userId, operation).run();
					if (result.meta.changes === 0) return json(null);
					return json(normalizeUserRow(await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first()));
				}

					if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/nyaitter-id\/reassign$/)) {
						const previousId = Number(pathname.split('/')[2]);
						const user = await db.prepare(
							`SELECT * FROM users WHERE id = ? AND auth_provider <> 'nyaitter' AND account_operation = 'reassigning'`
						).bind(previousId).first();
						if (!user) return json(null);

						const countRow = await db.prepare('SELECT COUNT(*) AS count FROM users').first();
						const upperBound = 10 ** Math.max(4, String(Math.max(Number(countRow?.count) || 1, 1)).length);
						let nextId = null;
						for (let attempt = 0; attempt < 100; attempt += 1) {
							const candidate = Math.floor(Math.random() * upperBound);
							if (candidate === previousId) continue;
							const collision = await db.prepare('SELECT 1 FROM users WHERE id = ? LIMIT 1').bind(candidate).first();
							if (!collision) {
								nextId = candidate;
								break;
							}
						}
						if (nextId == null) throw new Error('Could not allocate a unique Nyaitter ID');

													const [{ results: channels }, { results: groups }, { results: blockedUsers }, { results: reports }] = await db.batch([
								db.prepare('SELECT id, participants FROM dm_channels WHERE participants LIKE ?').bind(`%${previousId}%`),
								db.prepare('SELECT id, host_id, member, post, unread FROM group_dms WHERE host_id = ? OR member LIKE ? OR unread LIKE ?').bind(previousId, `%${previousId}%`, `%\"${previousId}\"%`),
								db.prepare('SELECT id, block FROM users WHERE block LIKE ?').bind(`%${previousId}%`),
								db.prepare('SELECT id, target_kind, target_id, target_snapshot, excluded_admin_ids FROM moderation_reports'),
							]);

						const statements = [
							db.prepare(
								`INSERT INTO users (id, scid, name, handle, nyaitter_address, auth_provider, provider_domain, external_id, external_profile, uuid, settings, block, bio, header_image, icon_data, verify, admin, freeze, shadow, created_at, account_operation)
								 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
							).bind(
								nextId, user.scid, user.name, formatNyaitterId(nextId), user.nyaitter_address,
								user.auth_provider, user.provider_domain, user.external_id, user.external_profile,
								user.uuid, user.settings, user.block, user.bio, user.header_image, user.icon_data,
								user.verify, user.admin, user.freeze, user.shadow, user.created_at, user.account_operation,
							),
							db.prepare('UPDATE sessions SET user_id = ? WHERE user_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE trusted_login_ips SET user_id = ? WHERE user_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE login_approvals SET user_id = ? WHERE user_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE bot_tokens SET user_id = ? WHERE user_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE posts SET user_id = ? WHERE user_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE likes SET user_id = ? WHERE user_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE stars SET user_id = ? WHERE user_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE reposts SET user_id = ? WHERE user_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE pinned_posts SET user_id = ? WHERE user_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE dm_messages SET sender_id = ? WHERE sender_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE follows SET follower_id = ? WHERE follower_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE follows SET following_id = ? WHERE following_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE dm_e2e_keys SET user_id = ? WHERE user_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE notifications SET user_id = ? WHERE user_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE notifications SET from_user_id = ? WHERE from_user_id = ?').bind(nextId, previousId),
							db.prepare(`UPDATE notifications SET target = json_set(target, '$.id', ?)
								WHERE json_extract(target, '$.kind') = 'user' AND CAST(json_extract(target, '$.id') AS INTEGER) = ?`).bind(nextId, previousId),
							db.prepare('UPDATE push_subscriptions SET user_id = ? WHERE user_id = ?').bind(nextId, previousId),

							// groups and memberships
							db.prepare('UPDATE groups SET owner_id = ? WHERE owner_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE group_memberships SET user_id = ? WHERE user_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE group_invites SET inviter_id = ? WHERE inviter_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE group_invites SET invitee_id = ? WHERE invitee_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE group_join_requests SET user_id = ? WHERE user_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE group_join_requests SET reviewed_by = ? WHERE reviewed_by = ?').bind(nextId, previousId),

							// authorized apps and affinities
							db.prepare('UPDATE authorized_apps SET user_id = ? WHERE user_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE user_keyword_affinities SET user_id = ? WHERE user_id = ?').bind(nextId, previousId),

							db.prepare('UPDATE moderation_reports SET reporter_user_id = ? WHERE reporter_user_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE moderation_reports SET assigned_admin_id = ? WHERE assigned_admin_id = ?').bind(nextId, previousId),
							db.prepare('UPDATE logs SET nyaitter_id = ? WHERE nyaitter_id = ?').bind(nextId, previousId),
						];
						for (const channel of channels || []) {
							const participants = parseJsonSafe(channel.participants, []).map((id) => Number(id) === previousId ? nextId : Number(id));
							statements.push(db.prepare('UPDATE dm_channels SET participants = ? WHERE id = ?').bind(JSON.stringify(participants), channel.id));
						}
						for (const group of groups || []) {
							const member = parseJsonSafe(group.member, []).map((id) => Number(id) === previousId ? nextId : Number(id));
							const post = parseJsonSafe(group.post, []).map((message) => (
								Number(message?.userid) === previousId ? { ...message, userid: nextId } : message
							));
							const unread = { ...parseJsonSafe(group.unread, {}) };
							if (Object.prototype.hasOwnProperty.call(unread, String(previousId))) {
								unread[String(nextId)] = unread[String(previousId)];
								delete unread[String(previousId)];
							}
							statements.push(
								db.prepare('UPDATE group_dms SET host_id = ?, member = ?, post = ?, unread = ? WHERE id = ?')
									.bind(Number(group.host_id) === previousId ? nextId : Number(group.host_id), JSON.stringify(member), JSON.stringify(post), JSON.stringify(unread), group.id),
							);
						}
						for (const blockedUser of blockedUsers || []) {
							const block = normalizeBlockList(parseJsonSafe(blockedUser.block, []).map((id) => Number(id) === previousId ? nextId : id), Number(blockedUser.id) === previousId ? nextId : blockedUser.id);
							statements.push(db.prepare('UPDATE users SET block = ? WHERE id = ?').bind(JSON.stringify(block), blockedUser.id));
						}
													for (const report of reports || []) {
								const targetSnapshot = parseJsonSafe(report.target_snapshot, {});
								let snapshotChanged = false;
								if (Number(targetSnapshot?.subjectUser?.id) === previousId) {
									targetSnapshot.subjectUser.id = nextId;
									snapshotChanged = true;
								}
								for (const member of targetSnapshot?.dm?.members || []) {
									if (Number(member?.id) !== previousId) continue;
									member.id = nextId;
									snapshotChanged = true;
								}
								const targetId = report.target_kind === 'user' && Number(report.target_id) === previousId
									? String(nextId)
									: report.target_id;
								const excluded = parseJsonSafe(report.excluded_admin_ids, []).map((id) => Number(id) === previousId ? nextId : Number(id));
								const excludedChanged = excluded.some((id, index) => Number(id) !== Number(parseJsonSafe(report.excluded_admin_ids, [])[index]));
								if (!snapshotChanged && targetId === report.target_id && !excludedChanged) continue;
								statements.push(
									db.prepare('UPDATE moderation_reports SET target_id = ?, target_snapshot = ?, excluded_admin_ids = ? WHERE id = ?')
										.bind(targetId, JSON.stringify(targetSnapshot), JSON.stringify(excluded), report.id),
								);
							}

						statements.push(db.prepare('DELETE FROM users WHERE id = ? AND account_operation = ?').bind(previousId, 'reassigning'));
						await db.batch(statements);
						return json(normalizeUserRow(await db.prepare('SELECT * FROM users WHERE id = ?').bind(nextId).first()));
					}

					if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/account\/attachments\/rewrite$/)) {
						const userId = Number(pathname.split('/')[2]);
						const body = await request.json();
						const replacementMap = createAttachmentReplacementMap(body?.replacements);
						if (replacementMap.size === 0) return json({ updatedCount: 0 });
						const { results } = await db.prepare('SELECT id, attachments FROM posts WHERE user_id = ?').bind(userId).all();
						const statements = [];
						for (const row of results || []) {
							const { attachments, changed } = rewriteAttachmentReferences(parseJsonSafe(row.attachments, []), replacementMap);
							if (!changed) continue;
							statements.push(db.prepare('UPDATE posts SET attachments = ? WHERE id = ?').bind(JSON.stringify(attachments), row.id));
						}
						if (statements.length > 0) await db.batch(statements);
						return json({ updatedCount: statements.length });
					}

					if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/account\/attachments$/)) {
						const userId = Number(pathname.split('/')[2]);
						const { results } = await db.prepare('SELECT attachments FROM posts WHERE user_id = ?').bind(userId).all();
						const keys = new Set();
						for (const row of results || []) {
							for (const attachment of parseJsonSafe(row.attachments, [])) {
								const key = attachment?.id || attachment?.key;
								if (typeof key === 'string' && key.startsWith('attachments/')) keys.add(key);
							}
						}
						return json([...keys]);
					}

				if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/account\/delete$/)) {
					const userId = Number(pathname.split('/')[2]);
					const user = await db.prepare("SELECT id FROM users WHERE id = ? AND account_operation = 'deleting'").bind(userId).first();
					if (!user) return json({ success: false });
					const { results: posts } = await db.prepare('SELECT id FROM posts WHERE user_id = ?').bind(userId).all();
					const postIds = (posts || []).map((row) => Number(row.id));
					const { results: channels } = await db.prepare('SELECT * FROM dm_channels WHERE participants LIKE ?').bind(`%${userId}%`).all();
					const { results: groups } = await db.prepare('SELECT * FROM group_dms WHERE host_id = ? OR member LIKE ?').bind(userId, `%${userId}%`).all();
					const { results: users } = await db.prepare('SELECT id, block FROM users WHERE block LIKE ?').bind(`%${userId}%`).all();
					const statements = [];
					if (postIds.length > 0) {
						const placeholders = postIds.map(() => '?').join(',');
						statements.push(db.prepare(`UPDATE posts SET repost_to = NULL WHERE repost_to IN (${placeholders})`).bind(...postIds));
					}
					for (const channel of channels || []) {
						const participants = parseJsonSafe(channel.participants, []).map(Number).filter((id) => id !== userId);
						if (participants.length < 2) statements.push(db.prepare('DELETE FROM dm_channels WHERE id = ?').bind(channel.id));
						else statements.push(db.prepare('UPDATE dm_channels SET participants = ? WHERE id = ?').bind(JSON.stringify(participants), channel.id));
					}
					for (const group of groups || []) {
						const members = parseJsonSafe(group.member, []).map(Number).filter((id) => id !== userId);
						if (members.length === 0) statements.push(db.prepare('DELETE FROM group_dms WHERE id = ?').bind(group.id));
						else {
							const messages = parseJsonSafe(group.post, []).filter((message) => Number(message?.userid) !== userId);
							const unread = { ...parseJsonSafe(group.unread, {}) }; delete unread[String(userId)];
							const hostId = Number(group.host_id) === userId ? members[0] : Number(group.host_id);
							statements.push(db.prepare('UPDATE group_dms SET host_id = ?, member = ?, post = ?, unread = ? WHERE id = ?')
								.bind(hostId, JSON.stringify(members), JSON.stringify(messages), JSON.stringify(unread), group.id));
						}
					}
					for (const candidate of users || []) {
						const block = normalizeBlockList(parseJsonSafe(candidate.block, []).filter((id) => Number(id) !== userId), candidate.id);
						statements.push(db.prepare('UPDATE users SET block = ? WHERE id = ?').bind(JSON.stringify(block), candidate.id));
					}
					statements.push(
						db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
						db.prepare('DELETE FROM bot_tokens WHERE user_id = ?').bind(userId),
						db.prepare('DELETE FROM trusted_login_ips WHERE user_id = ?').bind(userId),
						db.prepare('DELETE FROM login_approvals WHERE user_id = ?').bind(userId),
						db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(userId),
						db.prepare('DELETE FROM moderation_reports WHERE reporter_user_id = ?').bind(userId),
						db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
					);
					await db.batch(statements);
					return json({ success: true });
				}

				if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/status$/)) {

				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT shadow FROM users WHERE id = ?').bind(userId).first();
				return json(row ? { shadow: Boolean(row.shadow) } : null);
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/status$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const shadow = Boolean(body.shadow);
				await db.prepare('UPDATE users SET shadow = ? WHERE id = ?').bind(shadow ? 1 : 0, userId).run();
				return json({ shadow });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/profile$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const sets = [];
				const values = [];

				if (body.name !== undefined) { sets.push('name = ?'); values.push(body.name); }
				if (body.bio !== undefined) { sets.push('bio = ?'); values.push(body.bio); }
				else if (body.me !== undefined) { sets.push('bio = ?'); values.push(body.me); }
				if (body.header_image !== undefined) { sets.push('header_image = ?'); values.push(body.header_image); }
				if (body.icon_data !== undefined) { sets.push('icon_data = ?'); values.push(body.icon_data); }
				if (body.settings !== undefined) { sets.push('settings = ?'); values.push(JSON.stringify(body.settings || {})); }
				if (body.block !== undefined) { sets.push('block = ?'); values.push(JSON.stringify(normalizeBlockList(body.block, userId))); }
				if (body.verify !== undefined) { sets.push('verify = ?'); values.push(body.verify ? 1 : 0); }
				if (body.freeze !== undefined) { sets.push('freeze = ?'); values.push(body.freeze || null); }
				if (body.admin !== undefined) { sets.push('admin = ?'); values.push(body.admin ? 1 : 0); }
				if (body.shadow !== undefined) { sets.push('shadow = ?'); values.push(body.shadow ? 1 : 0); }

				if (sets.length > 0) {
					values.push(userId);
					await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
				}
				const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
				return json(normalizeUserRow(row));
			}

				if (method === 'GET' && pathname.match(/^\/users\/(\d+)$/)) {
					const userId = Number(pathname.split('/')[2]);
					const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
					return json(normalizeUserRow(row));
				}

				if (method === 'POST' && pathname === '/moderation-reports') {
					const body = await request.json();
					const reporterUserId = Number(body.reporterUserId);
					const targetKind = String(body.targetKind || '');
					const targetId = ['dm', 'dm_message'].includes(targetKind)
						? String(body.targetId || '').trim()
						: Number(body.targetId);
					const description = String(body.description || '');
					const assignmentType = ['freeze_appeal', 'verification_application'].includes(body.assignmentType)
						? body.assignmentType
						: 'report';
					const validTargetId = ['dm', 'dm_message'].includes(targetKind)
						? targetId.length > 0 && targetId.length <= 256
						: Number.isInteger(targetId);
					if (!Number.isInteger(reporterUserId) || !validTargetId || !['user', 'post', 'dm', 'dm_message'].includes(targetKind)) {
						return badRequest('Invalid moderation report');
					}
					const now = body.createdAt || new Date().toISOString();
					const hasExplicitId = body.id != null && Number.isSafeInteger(Number(body.id)) && Number(body.id) > 0;
					let createdId;
					if (hasExplicitId) {
						createdId = Number(body.id);
						await db.prepare(
							`INSERT INTO moderation_reports
								(id, reporter_user_id, target_kind, target_id, description, target_snapshot, assignment_type, status, excluded_admin_ids, created_at)
							 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '[]', ?)`
						).bind(
							createdId,
							reporterUserId,
							targetKind,
							targetId,
							description,
							JSON.stringify(body.targetSnapshot || {}),
							assignmentType,
							now,
						).run();
					} else {
						const result = await db.prepare(
							`INSERT INTO moderation_reports
								(reporter_user_id, target_kind, target_id, description, target_snapshot, assignment_type, status, excluded_admin_ids, created_at)
							 VALUES (?, ?, ?, ?, ?, ?, 'pending', '[]', ?)`
						).bind(
							reporterUserId,
							targetKind,
							targetId,
							description,
							JSON.stringify(body.targetSnapshot || {}),
							assignmentType,
							now,
						).run();
						createdId = result.meta.last_row_id;
					}
					const row = await db.prepare('SELECT * FROM moderation_reports WHERE id = ?').bind(createdId).first();
					return json(normalizeModerationReportRow(row), 201);
				}

				if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/moderation-appeal\/open$/)) {
					const userId = Number(pathname.split('/')[2]);
					const row = await db.prepare(
						`SELECT * FROM moderation_reports
						 WHERE reporter_user_id = ? AND assignment_type = 'freeze_appeal' AND status <> 'resolved'
						 ORDER BY created_at DESC LIMIT 1`
					).bind(userId).first();
					return json(normalizeModerationReportRow(row));
				}

				if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/moderation-verification\/open$/)) {
					const userId = Number(pathname.split('/')[2]);
					const row = await db.prepare(
						`SELECT * FROM moderation_reports
						 WHERE reporter_user_id = ? AND assignment_type = 'verification_application' AND status <> 'resolved'
						 ORDER BY created_at DESC LIMIT 1`
					).bind(userId).first();
					return json(normalizeModerationReportRow(row));
				}

				if (method === 'POST' && pathname === '/moderation-reports/admin-workloads') {
					const body = await request.json();
					const excluded = [...new Set((Array.isArray(body.excludedAdminIds) ? body.excludedAdminIds : [])
						.map(Number)
						.filter(Number.isInteger))];
					const placeholders = excluded.map(() => '?').join(', ');
					const exclusionClause = excluded.length > 0 ? `AND u.id NOT IN (${placeholders})` : '';
					const { results } = await db.prepare(
						`SELECT u.id AS admin_id, COUNT(r.id) AS active_count
						 FROM users u
						 LEFT JOIN moderation_reports r ON r.assigned_admin_id = u.id AND r.status = 'assigned'
						 WHERE u.admin = 1 AND COALESCE(u.freeze, '') = '' ${exclusionClause}
						 GROUP BY u.id`
					).bind(...excluded).all();
					return json((results || []).map((row) => ({
						adminId: Number(row.admin_id),
						activeCount: Number(row.active_count || 0),
					})));
				}

				if (method === 'POST' && pathname === '/moderation-reports/overdue') {
					const body = await request.json();
					const cutoff = String(body.cutoff || '');
					const { results } = await db.prepare(
						`SELECT * FROM moderation_reports
						 WHERE status = 'assigned' AND assigned_at IS NOT NULL AND assigned_at <= ?
						 ORDER BY assigned_at ASC`
					).bind(cutoff).all();
					return json((results || []).map(normalizeModerationReportRow));
				}

				if (method === 'POST' && pathname === '/moderation-reports/unassigned') {
					const body = await request.json();
					const limit = Math.max(1, Math.min(Number(body.limit) || 100, 100));
					const { results } = await db.prepare(
						`SELECT * FROM moderation_reports
						 WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?`
					).bind(limit).all();
					return json((results || []).map(normalizeModerationReportRow));
				}

				if (method === 'GET' && pathname.match(/^\/moderation-reports\/admin\/(\d+)$/)) {
					const adminId = Number(pathname.split('/')[3]);
					const status = url.searchParams.get('status') || 'assigned';
					const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 50), 100));
					const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
					const { results } = await db.prepare(
						`SELECT * FROM moderation_reports
						 WHERE assigned_admin_id = ? AND (? = '' OR status = ?)
						 ORDER BY COALESCE(assigned_at, created_at) DESC, id DESC LIMIT ? OFFSET ?`
					).bind(adminId, status, status, limit, offset).all();
					return json((results || []).map(normalizeModerationReportRow));
				}

				if (method === 'GET' && pathname.match(/^\/moderation-reports\/(\d+)$/)) {
					const reportId = Number(pathname.split('/')[2]);
					const row = await db.prepare('SELECT * FROM moderation_reports WHERE id = ?').bind(reportId).first();
					return json(normalizeModerationReportRow(row));
				}

				if (method === 'POST' && pathname.match(/^\/moderation-reports\/(\d+)\/assign$/)) {
					const reportId = Number(pathname.split('/')[2]);
					const body = await request.json();
					const existing = await db.prepare('SELECT * FROM moderation_reports WHERE id = ?').bind(reportId).first();
					if (!existing || existing.status === 'resolved') return json(null);
					if (Object.prototype.hasOwnProperty.call(body, 'expectedAdminId') && Number(existing.assigned_admin_id) !== Number(body.expectedAdminId)) {
						return json(null);
					}
					const excluded = [...new Set((Array.isArray(body.excludedAdminIds) ? body.excludedAdminIds : parseJsonSafe(existing.excluded_admin_ids, []))
						.map(Number)
						.filter(Number.isInteger))];
					const assignedAt = body.assignedAt || new Date().toISOString();
					await db.prepare(
						`UPDATE moderation_reports
						 SET status = 'assigned', assigned_admin_id = ?, assigned_at = ?, excluded_admin_ids = ?
						 WHERE id = ?`
					).bind(Number(body.adminId), assignedAt, JSON.stringify(excluded), reportId).run();
					const row = await db.prepare('SELECT * FROM moderation_reports WHERE id = ?').bind(reportId).first();
					return json(normalizeModerationReportRow(row));
				}

				if (method === 'POST' && pathname.match(/^\/moderation-reports\/(\d+)\/resolve$/)) {
					const reportId = Number(pathname.split('/')[2]);
					const body = await request.json();
					const now = new Date().toISOString();
					const result = await db.prepare(
						`UPDATE moderation_reports
						 SET status = 'resolved', resolution = ?, resolved_at = ?
						 WHERE id = ? AND assigned_admin_id = ? AND status = 'assigned'`
					).bind(JSON.stringify(body.resolution || {}), now, reportId, Number(body.adminId)).run();
					if (result.meta.changes === 0) return json(null);
					const row = await db.prepare('SELECT * FROM moderation_reports WHERE id = ?').bind(reportId).first();
					return json(normalizeModerationReportRow(row));
				}

				if (method === 'POST' && pathname.match(/^\/moderation-reports\/(\d+)\/delete$/)) {
					const reportId = Number(pathname.split('/')[2]);
					const result = await db.prepare('DELETE FROM moderation_reports WHERE id = ?').bind(reportId).run();
					return json({ success: result.meta.changes > 0 });
				}

				if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/follow$/)) {
				const followingId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const followerId = Number(body.followerId);

				const existing = await db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').bind(followerId, followingId).first();
				if (existing) {
					await db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').bind(followerId, followingId).run();
					return json({ following: false });
				}
				const now = new Date().toISOString();
				await db.prepare('INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)').bind(followerId, followingId, now).run();
				return json({ following: true });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/is-following$/)) {
				const followingId = Number(pathname.split('/')[2]);
				const followerId = Number(url.searchParams.get('followerId'));
				const existing = await db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').bind(followerId, followingId).first();
				return json({ following: Boolean(existing) });
			}

			if (method === 'POST' && pathname === '/users/follow-relationships') {
				const body = await request.json();
				const userId = Number(body?.userId);
				const candidateIds = [...new Set((Array.isArray(body?.candidateIds) ? body.candidateIds : [])
					.map(Number)
					.filter((id) => Number.isSafeInteger(id) && id >= 0 && id !== userId))].slice(0, 500);
				if (!Number.isSafeInteger(userId) || userId < 0 || candidateIds.length === 0) {
					return json({ following_ids: [], follower_ids: [] });
				}
				const placeholders = candidateIds.map(() => '?').join(', ');
				const { results } = await db.prepare(
					`SELECT following_id AS user_id, 'following' AS direction
					 FROM follows
					 WHERE follower_id = ? AND following_id IN (${placeholders})
					 UNION ALL
					 SELECT follower_id AS user_id, 'follower' AS direction
					 FROM follows
					 WHERE following_id = ? AND follower_id IN (${placeholders})`
				).bind(userId, ...candidateIds, userId, ...candidateIds).all();
				const following_ids = [];
				const follower_ids = [];
				for (const row of results || []) {
					if (row.direction === 'following') following_ids.push(Number(row.user_id));
					if (row.direction === 'follower') follower_ids.push(Number(row.user_id));
				}
				return json({ following_ids, follower_ids });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/following$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
				const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
				const withNextCursor = url.searchParams.get('withNextCursor') === 'true';
				const fetchLimit = limit + 1;
				let query;
				let bindings;

				if (decodedCursor) {
					query = `SELECT u.id, u.name, u.scid, u.handle, u.icon_data, f.created_at AS follow_created_at
						 FROM follows f JOIN users u ON u.id = f.following_id
						 WHERE f.follower_id = ? AND (f.created_at < ? OR (f.created_at = ? AND f.following_id < ?))
						 ORDER BY f.created_at DESC, f.following_id DESC LIMIT ?`;
					bindings = [userId, decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, fetchLimit];
				} else {
					const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
					query = `SELECT u.id, u.name, u.scid, u.handle, u.icon_data, f.created_at AS follow_created_at
						 FROM follows f JOIN users u ON u.id = f.following_id
						 WHERE f.follower_id = ?
						 ORDER BY f.created_at DESC, f.following_id DESC LIMIT ? OFFSET ?`;
					bindings = [userId, fetchLimit, offset];
				}

				const { results } = await db.prepare(query).bind(...bindings).all();
				const rows = results || [];
				const hasMore = rows.length > limit;
				const slice = rows.slice(0, limit);
				const lastRow = slice.length > 0 ? slice[slice.length - 1] : null;
				const nextCursor = hasMore && lastRow
					? encodePostCursor({ id: Number(lastRow.id), created_at: lastRow.follow_created_at })
					: null;

				if (withNextCursor) {
					return json({
						users: slice,
						has_more: hasMore,
						next_cursor: nextCursor,
					});
				}
				return json(slice);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/followers$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
				const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
				const withNextCursor = url.searchParams.get('withNextCursor') === 'true';
				const fetchLimit = limit + 1;
				let query;
				let bindings;

				if (decodedCursor) {
					query = `SELECT u.id, u.name, u.scid, u.handle, u.icon_data, f.created_at AS follow_created_at
						 FROM follows f JOIN users u ON u.id = f.follower_id
						 WHERE f.following_id = ? AND (f.created_at < ? OR (f.created_at = ? AND f.follower_id < ?))
						 ORDER BY f.created_at DESC, f.follower_id DESC LIMIT ?`;
					bindings = [userId, decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, fetchLimit];
				} else {
					const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
					query = `SELECT u.id, u.name, u.scid, u.handle, u.icon_data, f.created_at AS follow_created_at
						 FROM follows f JOIN users u ON u.id = f.follower_id
						 WHERE f.following_id = ?
						 ORDER BY f.created_at DESC, f.follower_id DESC LIMIT ? OFFSET ?`;
					bindings = [userId, fetchLimit, offset];
				}

				const { results } = await db.prepare(query).bind(...bindings).all();
				const rows = results || [];
				const hasMore = rows.length > limit;
				const slice = rows.slice(0, limit);
				const lastRow = slice.length > 0 ? slice[slice.length - 1] : null;
				const nextCursor = hasMore && lastRow
					? encodePostCursor({ id: Number(lastRow.id), created_at: lastRow.follow_created_at })
					: null;

				if (withNextCursor) {
					return json({
						users: slice,
						has_more: hasMore,
						next_cursor: nextCursor,
					});
				}
				return json(slice);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/following\/count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?').bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/followers\/count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM follows WHERE following_id = ?').bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/profile-stats$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare(
					`SELECT
						(SELECT COUNT(*) FROM follows WHERE follower_id = ?) AS following_count,
						(SELECT COUNT(*) FROM follows WHERE following_id = ?) AS follower_count,
						(SELECT COUNT(*) FROM posts WHERE user_id = ?) AS post_count,
						(SELECT COUNT(*) FROM posts
						 WHERE user_id = ?
						   AND json_array_length(CASE WHEN json_valid(attachments) = 1 THEN attachments ELSE '[]' END) > 0) AS media_count,
						(SELECT post_id FROM pinned_posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1) AS pinned_post_id`,
				).bind(userId, userId, userId, userId, userId).first();
				return json({
					following_count: Number(row?.following_count || 0),
					follower_count: Number(row?.follower_count || 0),
					post_count: Number(row?.post_count || 0),
					media_count: Number(row?.media_count || 0),
					pinned_post_id: row?.pinned_post_id == null ? null : Number(row.pinned_post_id),
				});
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/following\/ids$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT following_id FROM follows WHERE follower_id = ?').bind(userId).all();
				return json((results || []).map((r) => r.following_id));
			}

			// ==================== Groups ====================
			if (method === 'POST' && pathname === '/groups/user-badges-batch') {
				const body = await request.json().catch(() => ({}));
				const userIds = Array.isArray(body?.user_ids) ? body.user_ids.map(Number).filter(Number.isInteger) : [];
				if (userIds.length === 0) return json({ badges: {} });
				const placeholders = userIds.map(() => '?').join(',');
				const query = `
					SELECT gm.user_id, g.id AS group_id, g.name, g.icon_data, gm.joined_at
					FROM group_memberships gm
					JOIN groups g ON g.id = gm.group_id
					WHERE gm.user_id IN (${placeholders})
					  AND gm.status = 'active'
					  AND g.deleted_at IS NULL
					  AND g.icon_data IS NOT NULL
					  AND g.icon_data <> ''
					  AND g.visibility IN ('open', 'open_invite')
					ORDER BY gm.user_id, gm.joined_at DESC, g.created_at DESC
				`;
				const { results } = await db.prepare(query).bind(...userIds).all();
				const badges = {};
				userIds.forEach((id) => { badges[id] = []; });
				for (const row of results || []) {
					const uid = Number(row.user_id);
					if (!badges[uid]) badges[uid] = [];
					if (badges[uid].length < 3) {
						badges[uid].push({
							id: String(row.group_id),
							name: row.name || '',
							icon_data: row.icon_data,
						});
					}
				}
				return json({ badges });
			}

			if (method === 'GET' && pathname === '/groups') {
				const rawVisibility = String(url.searchParams.get('visibility') || 'open,open_invite');
				const visibility = rawVisibility.split(',').map((value) => value.trim()).filter(Boolean);
				if (visibility.length === 0) return json([]);
				const query = String(url.searchParams.get('query') || '').trim().toLowerCase();
				const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 20), 100));
				const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
				const placeholders = visibility.map(() => '?').join(', ');
				const parameters = [...visibility];
				let sql = `SELECT g.*, (SELECT COUNT(*) FROM group_memberships gm WHERE gm.group_id = g.id AND gm.status = 'active') AS member_count FROM groups g WHERE g.deleted_at IS NULL AND g.visibility IN (${placeholders})`;
				if (query) { sql += ' AND (LOWER(g.name) LIKE ? OR LOWER(g.description) LIKE ?)'; parameters.push(`%${query}%`, `%${query}%`); }
				sql += ' ORDER BY g.created_at DESC, g.id DESC LIMIT ? OFFSET ?';
				parameters.push(limit, offset);
				const { results } = await db.prepare(sql).bind(...parameters).all();
				return json((results || []).map(normalizeGroupRow));
			}

			if (method === 'POST' && pathname === '/groups') {
				const body = await request.json();
				const id = String(body.id || '').trim();
				const ownerId = Number(body.ownerId ?? body.owner_id);
				const name = String(body.name || '').trim();
				const visibility = String(body.visibility || 'open');
				if (!id || !Number.isInteger(ownerId) || ownerId < 0 || !name || name.length > 100 || !['open', 'private', 'invite', 'open_invite'].includes(visibility)) return badRequest('Invalid group');
				const description = String(body.description || '');
				if (description.length > 2000) return badRequest('Invalid description');
				const now = body.createdAt || new Date().toISOString();
				await db.prepare(`INSERT INTO groups (id, owner_id, name, description, icon_data, header_image, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
					.bind(id, ownerId, name, description, body.iconData ?? body.icon_data ?? null, body.headerImage ?? body.header_image ?? null, visibility, now, now).run();
				const row = await db.prepare(`SELECT g.*, 0 AS member_count FROM groups g WHERE g.id = ?`).bind(id).first();
				return json(normalizeGroupRow(row));
			}

			if (method === 'GET' && pathname.match(/^\/groups\/[^/]+$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]);
				const row = await db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM group_memberships gm WHERE gm.group_id = g.id AND gm.status = 'active') AS member_count FROM groups g WHERE g.id = ? AND g.deleted_at IS NULL`).bind(groupId).first();
				return row ? json(normalizeGroupRow(row)) : notFound('Group not found');
			}

			if (method === 'PATCH' && pathname.match(/^\/groups\/[^/]+\/owner$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const newOwnerId = Number(body.newOwnerId ?? body.new_owner_id);
				if (!Number.isInteger(newOwnerId) || newOwnerId < 0) return badRequest('Invalid new owner');
				await db.prepare('UPDATE groups SET owner_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').bind(newOwnerId, new Date().toISOString(), groupId).run();
				const row = await db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM group_memberships gm WHERE gm.group_id = g.id AND gm.status = 'active') AS member_count FROM groups g WHERE g.id = ? AND g.deleted_at IS NULL`).bind(groupId).first();
				return row ? json(normalizeGroupRow(row)) : notFound('Group not found');
			}

			if (method === 'PATCH' && pathname.match(/^\/groups\/[^/]+$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const fields = [['name', 'name'], ['description', 'description'], ['iconData', 'icon_data'], ['icon_data', 'icon_data'], ['headerImage', 'header_image'], ['header_image', 'header_image'], ['visibility', 'visibility']];
				const sets = []; const values = []; const assigned = new Set();
				for (const [key, column] of fields) {
					if (body[key] === undefined || assigned.has(column)) continue;
					assigned.add(column);
					const value = body[key] == null && ['icon_data', 'header_image'].includes(column) ? null : String(body[key]);
					if (column === 'name' && (!value || value.length > 100)) return badRequest('Invalid group name');
					if (column === 'description' && value.length > 2000) return badRequest('Invalid description');
					if (column === 'visibility' && !['open', 'private', 'invite', 'open_invite'].includes(value)) return badRequest('Invalid visibility');
					sets.push(`${column} = ?`); values.push(value);
				}
				if (sets.length === 0) return badRequest('No editable fields');
				sets.push('updated_at = ?'); values.push(new Date().toISOString(), groupId);
				await db.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).bind(...values).run();
				const row = await db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM group_memberships gm WHERE gm.group_id = g.id AND gm.status = 'active') AS member_count FROM groups g WHERE g.id = ? AND g.deleted_at IS NULL`).bind(groupId).first();
				return row ? json(normalizeGroupRow(row)) : notFound('Group not found');
			}

			if (method === 'DELETE' && pathname.match(/^\/groups\/[^/]+$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]);
				const now = new Date().toISOString();
				await db.batch([
					db.prepare('UPDATE groups SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').bind(now, now, groupId),
					db.prepare('UPDATE posts SET repost_to = NULL WHERE repost_to IN (SELECT id FROM posts WHERE group_id = ?)').bind(groupId),
					db.prepare('DELETE FROM likes WHERE post_id IN (SELECT id FROM posts WHERE group_id = ?)').bind(groupId),
					db.prepare('DELETE FROM stars WHERE post_id IN (SELECT id FROM posts WHERE group_id = ?)').bind(groupId),
					db.prepare('DELETE FROM reposts WHERE post_id IN (SELECT id FROM posts WHERE group_id = ?)').bind(groupId),
					db.prepare('DELETE FROM pinned_posts WHERE post_id IN (SELECT id FROM posts WHERE group_id = ?)').bind(groupId),
					db.prepare('DELETE FROM posts WHERE group_id = ?').bind(groupId),
				]);
				const row = await db.prepare('SELECT * FROM groups WHERE id = ?').bind(groupId).first();
				return row ? json(normalizeGroupRow(row)) : notFound('Group not found');
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/groups$/)) {
				const userId = Number(pathname.split('/')[2]);
				const status = String(url.searchParams.get('status') || 'active');
				const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), 200));
				const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
				const { results } = await db.prepare(`SELECT g.*, gm.role_id AS membership_role_id, gm.status AS membership_status, gm.joined_at AS membership_joined_at,
					(SELECT COUNT(*) FROM group_memberships count_gm WHERE count_gm.group_id = g.id AND count_gm.status = 'active') AS member_count
					FROM group_memberships gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ? AND gm.status = ? AND g.deleted_at IS NULL
					ORDER BY gm.joined_at DESC, g.created_at DESC LIMIT ? OFFSET ?`).bind(userId, status, limit, offset).all();
				return json((results || []).map((row) => ({ ...normalizeGroupRow(row), membership: normalizeGroupMembershipRow({ group_id: row.id, user_id: userId, role_id: row.membership_role_id, status: row.membership_status, joined_at: row.membership_joined_at }) })));
			}

			if (method === 'GET' && pathname.match(/^\/groups\/[^/]+\/roles$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT * FROM group_roles WHERE group_id = ? ORDER BY sort_order ASC, name ASC, id ASC').bind(groupId).all();
				return json((results || []).map(normalizeGroupRoleRow));
			}

			if (method === 'POST' && pathname.match(/^\/groups\/[^/]+\/roles$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]); const body = await request.json(); const id = String(body.id || '').trim(); const name = String(body.name || '').trim();
				if (!id || !name || name.length > 50 || !Array.isArray(body.permissions)) return badRequest('Invalid role');
				const now = body.createdAt || new Date().toISOString();
				await db.prepare('INSERT INTO group_roles (id, group_id, name, permissions, is_system, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
					.bind(id, groupId, name, JSON.stringify(body.permissions.map(String)), body.isSystem ? 1 : 0, Number(body.sortOrder) || 0, now, now).run();
				return json(normalizeGroupRoleRow(await db.prepare('SELECT * FROM group_roles WHERE id = ?').bind(id).first()));
			}

			if (method === 'PATCH' && pathname.match(/^\/group-roles\/[^/]+$/)) {
				const roleId = decodeURIComponent(pathname.split('/')[2]); const body = await request.json(); const sets = []; const values = [];
				if (body.name !== undefined) { const name = String(body.name).trim(); if (!name || name.length > 50) return badRequest('Invalid role name'); sets.push('name = ?'); values.push(name); }
				if (body.permissions !== undefined) { if (!Array.isArray(body.permissions)) return badRequest('Invalid permissions'); sets.push('permissions = ?'); values.push(JSON.stringify(body.permissions.map(String))); }
				if (body.sortOrder !== undefined || body.sort_order !== undefined) { sets.push('sort_order = ?'); values.push(Number(body.sortOrder ?? body.sort_order) || 0); }
				if (sets.length === 0) return badRequest('No editable fields');
				sets.push('updated_at = ?'); values.push(new Date().toISOString(), roleId);
				await db.prepare(`UPDATE group_roles SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
				const row = await db.prepare('SELECT * FROM group_roles WHERE id = ?').bind(roleId).first(); return row ? json(normalizeGroupRoleRow(row)) : notFound('Group role not found');
			}

			if (method === 'DELETE' && pathname.match(/^\/group-roles\/[^/]+$/)) {
				const roleId = decodeURIComponent(pathname.split('/')[2]); const row = await db.prepare('SELECT * FROM group_roles WHERE id = ?').bind(roleId).first();
				if (!row) return notFound('Group role not found'); await db.prepare('DELETE FROM group_roles WHERE id = ?').bind(roleId).run(); return json(normalizeGroupRoleRow(row));
			}

			if (method === 'GET' && pathname.match(/^\/groups\/[^/]+\/members\/\d+$/)) {
				const [, , encodedGroupId, , rawUserId] = pathname.split('/'); const row = await db.prepare('SELECT * FROM group_memberships WHERE group_id = ? AND user_id = ?').bind(decodeURIComponent(encodedGroupId), Number(rawUserId)).first();
				return row ? json(normalizeGroupMembershipRow(row)) : notFound('Group membership not found');
			}

			if (method === 'GET' && pathname.match(/^\/groups\/[^/]+\/members$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]); const status = url.searchParams.get('status'); const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), 200)); const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
				const stmt = status ? db.prepare('SELECT * FROM group_memberships WHERE group_id = ? AND status = ? ORDER BY joined_at ASC, user_id ASC LIMIT ? OFFSET ?').bind(groupId, status, limit, offset) : db.prepare('SELECT * FROM group_memberships WHERE group_id = ? ORDER BY joined_at ASC, user_id ASC LIMIT ? OFFSET ?').bind(groupId, limit, offset);
				const { results } = await stmt.all(); return json((results || []).map(normalizeGroupMembershipRow));
			}

			if (method === 'POST' && pathname.match(/^\/groups\/[^/]+\/members$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]); const body = await request.json(); const userId = Number(body.userId ?? body.user_id);
				if (!Number.isInteger(userId) || userId < 0) return badRequest('Invalid user'); const now = body.updatedAt || new Date().toISOString();
				await db.prepare(`INSERT INTO group_memberships (group_id, user_id, role_id, status, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
					ON CONFLICT(group_id, user_id) DO UPDATE SET role_id=excluded.role_id, status=excluded.status, joined_at=excluded.joined_at, updated_at=excluded.updated_at`)
					.bind(groupId, userId, body.roleId ?? body.role_id ?? null, String(body.status || 'active'), body.joinedAt ?? body.joined_at ?? null, now).run();
				return json(normalizeGroupMembershipRow(await db.prepare('SELECT * FROM group_memberships WHERE group_id = ? AND user_id = ?').bind(groupId, userId).first()));
			}

			if (method === 'PATCH' && pathname.match(/^\/groups\/[^/]+\/members\/\d+$/)) {
				const [, , encodedGroupId, , rawUserId] = pathname.split('/'); const groupId = decodeURIComponent(encodedGroupId); const userId = Number(rawUserId); const body = await request.json(); const sets = []; const values = [];
				if (body.roleId !== undefined || body.role_id !== undefined) { sets.push('role_id = ?'); values.push(body.roleId ?? body.role_id ?? null); }
				if (body.status !== undefined) { sets.push('status = ?'); values.push(String(body.status)); }
				if (body.joinedAt !== undefined || body.joined_at !== undefined) { sets.push('joined_at = ?'); values.push(body.joinedAt ?? body.joined_at ?? null); }
				if (sets.length === 0) return badRequest('No editable fields'); sets.push('updated_at = ?'); values.push(new Date().toISOString(), groupId, userId);
				await db.prepare(`UPDATE group_memberships SET ${sets.join(', ')} WHERE group_id = ? AND user_id = ?`).bind(...values).run(); const row = await db.prepare('SELECT * FROM group_memberships WHERE group_id = ? AND user_id = ?').bind(groupId, userId).first(); return row ? json(normalizeGroupMembershipRow(row)) : notFound('Group membership not found');
			}

			if (method === 'POST' && pathname.match(/^\/groups\/[^/]+\/invites$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]); const body = await request.json(); const id = String(body.id || '').trim(); const inviterId = Number(body.inviterId ?? body.inviter_id); const inviteeId = Number(body.inviteeId ?? body.invitee_id);
				if (!id || !Number.isInteger(inviterId) || !Number.isInteger(inviteeId)) return badRequest('Invalid invite'); const now = body.createdAt || new Date().toISOString();
				await db.prepare('INSERT INTO group_invites (id, group_id, inviter_id, invitee_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, groupId, inviterId, inviteeId, String(body.status || 'pending'), now).run(); return json(normalizeGroupInviteRow(await db.prepare('SELECT * FROM group_invites WHERE id = ?').bind(id).first()));
			}

			if (method === 'GET' && pathname === '/group-invites') {
				const groupId = url.searchParams.get('groupId'); const inviteeId = url.searchParams.get('inviteeId'); const status = url.searchParams.get('status'); const clauses = []; const values = [];
				if (groupId) { clauses.push('group_id = ?'); values.push(groupId); } if (inviteeId != null) { clauses.push('invitee_id = ?'); values.push(Number(inviteeId)); } if (status) { clauses.push('status = ?'); values.push(status); }
				if (!clauses.length) return json([]); values.push(Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), 200)), Math.max(0, Number(url.searchParams.get('offset') || 0)));
				const { results } = await db.prepare(`SELECT * FROM group_invites WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...values).all(); return json((results || []).map(normalizeGroupInviteRow));
			}

			if (method === 'GET' && pathname.match(/^\/group-invites\/[^/]+$/)) {
				const row = await db.prepare('SELECT * FROM group_invites WHERE id = ?').bind(decodeURIComponent(pathname.split('/')[2])).first(); return row ? json(normalizeGroupInviteRow(row)) : notFound('Group invite not found');
			}

			if (method === 'PATCH' && pathname.match(/^\/group-invites\/[^/]+$/)) {
				const inviteId = decodeURIComponent(pathname.split('/')[2]); const body = await request.json(); const sets = []; const values = [];
				if (body.status !== undefined) { sets.push('status = ?'); values.push(String(body.status)); } if (body.respondedAt !== undefined || body.responded_at !== undefined) { sets.push('responded_at = ?'); values.push(body.respondedAt ?? body.responded_at ?? null); } else if (body.status && body.status !== 'pending') sets.push(`responded_at = '${new Date().toISOString()}'`);
				if (!sets.length) return badRequest('No editable fields'); values.push(inviteId); await db.prepare(`UPDATE group_invites SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run(); const row = await db.prepare('SELECT * FROM group_invites WHERE id = ?').bind(inviteId).first(); return row ? json(normalizeGroupInviteRow(row)) : notFound('Group invite not found');
			}

			if (method === 'POST' && pathname.match(/^\/groups\/[^/]+\/join-requests$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]); const body = await request.json(); const id = String(body.id || '').trim(); const userId = Number(body.userId ?? body.user_id); if (!id || !Number.isInteger(userId)) return badRequest('Invalid join request'); const now = body.createdAt || new Date().toISOString();
				await db.prepare('INSERT INTO group_join_requests (id, group_id, user_id, status, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, groupId, userId, String(body.status || 'pending'), now).run(); return json(normalizeGroupJoinRequestRow(await db.prepare('SELECT * FROM group_join_requests WHERE id = ?').bind(id).first()));
			}

			if (method === 'GET' && pathname === '/group-join-requests') {
				const groupId = url.searchParams.get('groupId'); const userId = url.searchParams.get('userId'); const status = url.searchParams.get('status'); const clauses = []; const values = [];
				if (groupId) { clauses.push('group_id = ?'); values.push(groupId); } if (userId != null) { clauses.push('user_id = ?'); values.push(Number(userId)); } if (status) { clauses.push('status = ?'); values.push(status); } if (!clauses.length) return json([]);
				values.push(Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), 200)), Math.max(0, Number(url.searchParams.get('offset') || 0))); const { results } = await db.prepare(`SELECT * FROM group_join_requests WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...values).all(); return json((results || []).map(normalizeGroupJoinRequestRow));
			}

			if (method === 'GET' && pathname.match(/^\/group-join-requests\/[^/]+$/)) { const row = await db.prepare('SELECT * FROM group_join_requests WHERE id = ?').bind(decodeURIComponent(pathname.split('/')[2])).first(); return row ? json(normalizeGroupJoinRequestRow(row)) : notFound('Group join request not found'); }

			if (method === 'PATCH' && pathname.match(/^\/group-join-requests\/[^/]+$/)) {
				const requestId = decodeURIComponent(pathname.split('/')[2]); const body = await request.json(); const sets = []; const values = [];
				if (body.status !== undefined) { sets.push('status = ?'); values.push(String(body.status)); } if (body.reviewedBy !== undefined || body.reviewed_by !== undefined) { sets.push('reviewed_by = ?'); values.push(body.reviewedBy ?? body.reviewed_by ?? null); } if (body.reviewedAt !== undefined || body.reviewed_at !== undefined) { sets.push('reviewed_at = ?'); values.push(body.reviewedAt ?? body.reviewed_at ?? null); } else if (body.status && body.status !== 'pending') sets.push(`reviewed_at = '${new Date().toISOString()}'`);
				if (!sets.length) return badRequest('No editable fields'); values.push(requestId); await db.prepare(`UPDATE group_join_requests SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run(); const row = await db.prepare('SELECT * FROM group_join_requests WHERE id = ?').bind(requestId).first(); return row ? json(normalizeGroupJoinRequestRow(row)) : notFound('Group join request not found');
			}

			if (method === 'GET' && pathname.match(/^\/groups\/[^/]+\/(posts|announcements)$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]); const onlyAnnouncements = pathname.endsWith('/announcements'); const subType = url.searchParams.get('subType') === 'replies_only' ? 'replies_only' : 'posts_only'; const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 30), 100)); const offset = Math.max(0, Number(url.searchParams.get('offset') || 0)); const beforeId = Number(url.searchParams.get('beforeId')) || null; const authorId = Number.isInteger(Number(url.searchParams.get('authorId'))) && Number(url.searchParams.get('authorId')) >= 0 ? Number(url.searchParams.get('authorId')) : null;
				const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
				const clauses = ['group_id = ?']; const values = [groupId]; if (onlyAnnouncements) clauses.push('group_announcement = 1'); else clauses.push(subType === 'replies_only' ? 'reply_to IS NOT NULL' : 'reply_to IS NULL'); if (authorId != null) { clauses.push('user_id = ?'); values.push(authorId); }
				if (decodedCursor) { clauses.push('(created_at < ? OR (created_at = ? AND id < ?))'); values.push(decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id); } else if (beforeId) { clauses.push('id < ?'); values.push(beforeId); }
				values.push(limit + 1); let offsetSql = ''; if (!beforeId && !decodedCursor) { values.push(offset); offsetSql = ' OFFSET ?'; }
				const { results } = await db.prepare(`SELECT id, created_at FROM posts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?${offsetSql}`).bind(...values).all(); const rows = results || []; const selectedRows = rows.slice(0, limit); const ids = selectedRows.map((row) => Number(row.id)); const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null; const nextCursor = rows.length > limit && lastRow ? (encodePostCursor(lastRow) || ids.at(-1) || null) : null; return json({ ids, has_more: rows.length > limit, next_cursor: nextCursor });
			}

			if (method === 'GET' && pathname === '/group-posts/search') {
				const userId = Number(url.searchParams.get('userId')); const query = String(url.searchParams.get('query') || '').trim().toLowerCase(); if (!Number.isInteger(userId) || !query) return json({ ids: [], has_more: false, next_cursor: null }); const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 30), 100)); const offset = Math.max(0, Number(url.searchParams.get('offset') || 0)); const beforeId = Number(url.searchParams.get('beforeId')) || null;
				const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
				const clauses = ["gm.user_id = ?", "gm.status = 'active'", 'LOWER(p.content) LIKE ?']; const values = [userId, `%${query}%`];
				if (decodedCursor) { clauses.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?))'); values.push(decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id); } else if (beforeId) { clauses.push('p.id < ?'); values.push(beforeId); }
				values.push(limit + 1); let offsetSql = ''; if (!beforeId && !decodedCursor) { values.push(offset); offsetSql = ' OFFSET ?'; }
				const { results } = await db.prepare(`SELECT p.id, p.created_at FROM posts p JOIN group_memberships gm ON gm.group_id = p.group_id WHERE ${clauses.join(' AND ')} ORDER BY p.created_at DESC, p.id DESC LIMIT ?${offsetSql}`).bind(...values).all(); const rows = results || []; const selectedRows = rows.slice(0, limit); const ids = selectedRows.map((row) => Number(row.id)); const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null; const nextCursor = rows.length > limit && lastRow ? (encodePostCursor(lastRow) || ids.at(-1) || null) : null; return json({ ids, has_more: rows.length > limit, next_cursor: nextCursor });
			}

			if (method === 'POST' && pathname === '/posts') {
				const postData = await request.json();
				const userId = Number(postData.userId);
				const content = postData.content || '';
				const attachments = postData.attachments ? JSON.stringify(postData.attachments) : null;
				const mask = postData.mask ? 1 : 0;
				const lock = postData.lock ? 1 : 0;
				const announcement = postData.announcement ? 1 : 0;
				const replyTo = (postData.replyTo ?? postData.reply_to ?? postData.reply_id) ? Number(postData.replyTo ?? postData.reply_to ?? postData.reply_id) : null;
				const repostTo = (postData.repostTo ?? postData.repost_to ?? postData.repost_id) ? Number(postData.repostTo ?? postData.repost_to ?? postData.repost_id) : null;
				const normalizedTags = normalizePostTags(postData.tags);
				const tags = JSON.stringify(normalizedTags);
				const tagsGeneratedAt = postData.tagsGeneratedAt || null;
				const groupId = postData.groupId ?? postData.group_id ?? null;
				const groupAnnouncement = postData.groupAnnouncement ?? postData.group_announcement ? 1 : 0;
				const now = postData.createdAt ? new Date(postData.createdAt).toISOString() : new Date().toISOString();
				const hasExplicitId = postData.id != null && Number.isSafeInteger(Number(postData.id)) && Number(postData.id) > 0;

				let createdId;
				if (hasExplicitId) {
					createdId = Number(postData.id);
					await db.prepare(
						`INSERT INTO posts (id, user_id, content, attachments, mask, lock, announcement, reply_to, repost_to, tags, tags_generated_at, group_id, group_announcement, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					).bind(createdId, userId, content, attachments, mask, lock, announcement, replyTo, repostTo, tags, tagsGeneratedAt, groupId, groupAnnouncement, now).run();
				} else {
					const res = await db.prepare(
						`INSERT INTO posts (user_id, content, attachments, mask, lock, announcement, reply_to, repost_to, tags, tags_generated_at, group_id, group_announcement, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					).bind(userId, content, attachments, mask, lock, announcement, replyTo, repostTo, tags, tagsGeneratedAt, groupId, groupAnnouncement, now).run();
					createdId = res.meta.last_row_id;
				}

				const created = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(createdId).first();
				await adjustUserKeywordAffinitiesForTags(db, userId, normalizedTags, 1);
				return json(normalizePostRow(created));
			}

			if (method === 'POST' && pathname === '/post-events/enqueue') {
				const body = await request.json();
				const eventType = String(body.eventType || body.event_type || '');
				if (!eventType) return badRequest('eventType is required');
				const postId = body.postId != null || body.post_id != null ? Number(body.postId ?? body.post_id) : null;
				const payload = typeof body.payload === 'object' && body.payload !== null ? JSON.stringify(body.payload) : String(body.payload || '{}');
				const availableAt = body.availableAt || body.available_at || new Date().toISOString();
				const now = new Date().toISOString();

				const res = await db.prepare(
					`INSERT INTO post_events (event_type, post_id, payload, available_at, created_at)
					 VALUES (?, ?, ?, ?, ?)`
				).bind(eventType, postId, payload, availableAt, now).run();

				const createdId = res.meta.last_row_id;
				const created = await db.prepare('SELECT * FROM post_events WHERE id = ?').bind(createdId).first();
				return json(normalizePostEventRow(created));
			}

			if (method === 'POST' && pathname === '/post-events/claim') {
				const body = await request.json();
				const safeLimit = Math.max(1, Math.min(Number(body.limit || 50), 500));
				const workerId = body.workerId != null ? String(body.workerId) : null;
				const now = new Date().toISOString();
				const stale = new Date(Date.now() - 60000).toISOString();

				const rows = await db.prepare(
					`UPDATE post_events
					 SET status = 'processing', attempts = attempts + 1, locked_at = ?, worker_id = ?
					 WHERE id IN (
						 SELECT id FROM post_events
						 WHERE (status = 'pending' AND available_at <= ?)
						    OR (status = 'processing' AND locked_at < ?)
						 ORDER BY available_at ASC, id ASC
						 LIMIT ?
					 )
					 RETURNING *`
				).bind(now, workerId, now, stale, safeLimit).all();

				return json((rows.results || []).map(normalizePostEventRow));
			}

			if (method === 'POST' && pathname.match(/^\/post-events\/(\d+)\/complete$/)) {
				const eventId = Number(pathname.split('/')[2]);
				const res = await db.prepare(
					`UPDATE post_events
					 SET status = 'completed', locked_at = NULL, processed_at = datetime('now'), last_error = NULL
					 WHERE id = ? AND status = 'processing'`
				).bind(eventId).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'POST' && pathname.match(/^\/post-events\/(\d+)\/fail$/)) {
				const eventId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const retryAt = body.retryAt || body.retry_at || null;
				const errorMessage = String(body.error || 'Unknown error').slice(0, 2000);

				let res;
				if (retryAt) {
					res = await db.prepare(
						`UPDATE post_events
						 SET status = 'pending', available_at = ?, locked_at = NULL, last_error = ?
						 WHERE id = ? AND status = 'processing'`
					).bind(new Date(retryAt).toISOString(), errorMessage, eventId).run();
				} else {
					res = await db.prepare(
						`UPDATE post_events
						 SET status = 'failed', locked_at = NULL, last_error = ?
						 WHERE id = ? AND status = 'processing'`
					).bind(errorMessage, eventId).run();
				}
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'POST' && pathname === '/posts/batch') {
				const body = await request.json();
				const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isSafeInteger) : [];
				if (ids.length === 0) return json([]);

				const placeholders = ids.map(() => '?').join(', ');
				const { results } = await db.prepare(`SELECT * FROM posts WHERE id IN (${placeholders})`).bind(...ids).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'POST' && pathname === '/posts/metrics/batch') {
				const body = await request.json();
				const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isSafeInteger) : [];
				const currentUserId = body.currentUserId != null ? Number(body.currentUserId) : null;
				if (ids.length === 0) return json([]);

				const requestedValues = ids.map(() => '(?)').join(', ');
				const viewerColumns = currentUserId
					? `EXISTS (SELECT 1 FROM likes viewer_likes WHERE viewer_likes.post_id = requested.id AND viewer_likes.user_id = ?) AS liked_by_me,
						EXISTS (SELECT 1 FROM stars viewer_stars WHERE viewer_stars.post_id = requested.id AND viewer_stars.user_id = ?) AS starred_by_me`
					: '0 AS liked_by_me, 0 AS starred_by_me';
				const bindings = currentUserId
					? [...ids, currentUserId, currentUserId]
					: ids;
				const { results } = await db.prepare(
					`WITH requested(id) AS (VALUES ${requestedValues}),
						like_counts AS (
							SELECT likes.post_id, COUNT(*) AS count
							FROM likes JOIN requested ON requested.id = likes.post_id
							GROUP BY likes.post_id
						), star_counts AS (
							SELECT stars.post_id, COUNT(*) AS count
							FROM stars JOIN requested ON requested.id = stars.post_id
							GROUP BY stars.post_id
						), repost_counts AS (
							SELECT reposts.post_id, COUNT(*) AS count
							FROM reposts JOIN requested ON requested.id = reposts.post_id
							GROUP BY reposts.post_id
						), reply_counts AS (
							SELECT posts.reply_to AS post_id, COUNT(*) AS count
							FROM posts JOIN requested ON requested.id = posts.reply_to
							GROUP BY posts.reply_to
						)
						SELECT requested.id AS post_id,
							COALESCE(like_counts.count, 0) AS like_count,
							COALESCE(star_counts.count, 0) AS star_count,
							COALESCE(repost_counts.count, 0) AS repost_count,
							COALESCE(reply_counts.count, 0) AS reply_count,
							${viewerColumns}
						FROM requested
						LEFT JOIN like_counts ON like_counts.post_id = requested.id
						LEFT JOIN star_counts ON star_counts.post_id = requested.id
						LEFT JOIN repost_counts ON repost_counts.post_id = requested.id
						LEFT JOIN reply_counts ON reply_counts.post_id = requested.id`
				).bind(...bindings).all();

				const metricsById = new Map((results || []).map((row) => [Number(row.post_id), {
					post_id: Number(row.post_id),
					like_count: Number(row.like_count) || 0,
					star_count: Number(row.star_count) || 0,
					repost_count: Number(row.repost_count) || 0,
					reply_count: Number(row.reply_count) || 0,
					liked_by_me: Boolean(row.liked_by_me),
					starred_by_me: Boolean(row.starred_by_me),
				}]));
				const metrics = ids.map((id) => metricsById.get(id) || {
					post_id: id,
					like_count: 0,
					star_count: 0,
					repost_count: 0,
					reply_count: 0,
					liked_by_me: false,
					starred_by_me: false,
				});
				return json(metrics);
			}

			if (method === 'POST' && pathname === '/posts/reactions/batch') {
				const body = await request.json();
				const ids = [...new Set((Array.isArray(body.ids) ? body.ids : [])
					.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
				const currentUserId = Number(body.currentUserId);
				if (ids.length === 0 || !Number.isSafeInteger(currentUserId) || currentUserId <= 0) return json([]);
				const requestedValues = ids.map(() => '(?)').join(', ');
				const { results } = await db.prepare(
					`WITH requested(post_id) AS (VALUES ${requestedValues})
					 SELECT requested.post_id,
						EXISTS (SELECT 1 FROM likes WHERE post_id = requested.post_id AND user_id = ?) AS liked_by_me,
						EXISTS (SELECT 1 FROM stars WHERE post_id = requested.post_id AND user_id = ?) AS starred_by_me
					 FROM requested`,
				).bind(...ids, currentUserId, currentUserId).all();
				return json(results || []);
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)$/)) {
				const postId = Number(pathname.split('/')[2]);
				const fields = await request.json();
				const existing = fields.tags !== undefined
					? await db.prepare('SELECT user_id, tags FROM posts WHERE id = ?').bind(postId).first()
					: null;
				const sets = [];
				const values = [];

				if (fields.content !== undefined) { sets.push('content = ?'); values.push(fields.content); }
				if (fields.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(normalizePostTags(fields.tags))); }
				if (fields.tagsGeneratedAt !== undefined) { sets.push('tags_generated_at = ?'); values.push(fields.tagsGeneratedAt || null); }
				if (fields.attachments !== undefined) { sets.push('attachments = ?'); values.push(fields.attachments ? JSON.stringify(fields.attachments) : null); }
				if (fields.mask !== undefined) { sets.push('mask = ?'); values.push(fields.mask ? 1 : 0); }
				if (fields.lock !== undefined) { sets.push('lock = ?'); values.push(fields.lock ? 1 : 0); }

				if (sets.length > 0) {
					values.push(postId);
					await db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
				}
				const row = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first();
				if (row && existing) {
					await adjustUserKeywordAffinitiesForTags(db, existing.user_id, existing.tags, -1);
					await adjustUserKeywordAffinitiesForTags(db, existing.user_id, row.tags, 1);
				}
				return json(normalizePostRow(row));
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/delete$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const post = await db.prepare('SELECT user_id FROM posts WHERE id = ?').bind(postId).first();
				if (!post || Number(post.user_id) !== userId) {
					return json({ success: false });
				}
				await db.prepare('DELETE FROM likes WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM stars WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM reposts WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM pinned_posts WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM posts WHERE id = ?').bind(postId).run();
				return json({ success: true });
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/admin-delete$/)) {
				const postId = Number(pathname.split('/')[2]);
				await db.prepare('DELETE FROM likes WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM stars WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM reposts WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM pinned_posts WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM posts WHERE id = ?').bind(postId).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname === '/posts/recent') {
				const limit = Math.min(Number(url.searchParams.get('limit') || 30), 100);
				const { results } = await db.prepare('SELECT * FROM posts WHERE group_id IS NULL AND reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT ?').bind(limit).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/posts$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const { results } = await db.prepare('SELECT * FROM posts WHERE user_id = ? AND group_id IS NULL ORDER BY created_at DESC, id DESC LIMIT ?').bind(userId, limit).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'POST' && pathname === '/posts/timeline/ids') {
				const body = await request.json();
				const tab = body.tab || 'foryou';
				const followIds = Array.isArray(body.followIds) ? body.followIds.map(Number).filter(Number.isSafeInteger) : [];
				const viewerId = body.viewerId != null && Number.isSafeInteger(Number(body.viewerId))
					? Number(body.viewerId)
					: null;
				const includePosts = body.includePosts === true;
				const limit = Math.min(Number(body.limit || 30), 100);
				const decodedCursor = body.cursorCreatedAt && body.cursorId
					? { createdAt: body.cursorCreatedAt, id: Number(body.cursorId) }
					: decodePostCursor(body.cursor);
				const beforeId = Number.isSafeInteger(Number(body.beforeId)) && Number(body.beforeId) > 0
					? Number(body.beforeId)
					: null;
				const offset = (beforeId == null && !decodedCursor) ? Number(body.offset || 0) : 0;

				let results = [];
				if (tab === 'following') {
					let queryRes;
					if (followIds.length > 0) {
						const placeholders = followIds.map(() => '?').join(', ');
						if (decodedCursor) {
							queryRes = await db.prepare(
								`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE user_id IN (${placeholders}) AND group_id IS NULL AND reply_to IS NULL AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`
							).bind(...followIds, decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, limit + 1).all();
						} else if (beforeId != null) {
							queryRes = await db.prepare(
								`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE user_id IN (${placeholders}) AND group_id IS NULL AND reply_to IS NULL AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?`
							).bind(...followIds, beforeId, limit + 1).all();
						} else {
							queryRes = await db.prepare(
								`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE user_id IN (${placeholders}) AND group_id IS NULL AND reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
							).bind(...followIds, limit + 1, offset).all();
						}
					} else if (viewerId != null && viewerId > 0) {
						const where = `user_id IN (SELECT following_id FROM follows WHERE follower_id = ?) AND group_id IS NULL AND reply_to IS NULL`;
						if (decodedCursor) {
							queryRes = await db.prepare(
								`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE ${where} AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`
							).bind(viewerId, decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, limit + 1).all();
						} else if (beforeId != null) {
							queryRes = await db.prepare(
								`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE ${where} AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?`
							).bind(viewerId, beforeId, limit + 1).all();
						} else {
							queryRes = await db.prepare(
								`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
							).bind(viewerId, limit + 1, offset).all();
						}
					} else {
						return json({ ids: [], has_more: false });
					}
					results = queryRes.results || [];
				} else if (tab === 'announce') {
					let queryRes;
					if (decodedCursor) {
						queryRes = await db.prepare(
							`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE group_id IS NULL AND announcement = 1 AND reply_to IS NULL AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`
						).bind(decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, limit + 1).all();
					} else if (beforeId != null) {
						queryRes = await db.prepare(
							`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE group_id IS NULL AND announcement = 1 AND reply_to IS NULL AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?`
						).bind(beforeId, limit + 1).all();
					} else {
						queryRes = await db.prepare(
							`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE group_id IS NULL AND announcement = 1 AND reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
						).bind(limit + 1, offset).all();
					}
					results = queryRes.results || [];
				} else {
					let queryRes;
					if (decodedCursor) {
						queryRes = await db.prepare(
							`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE group_id IS NULL AND reply_to IS NULL AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`
						).bind(decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, limit + 1).all();
					} else if (beforeId != null) {
						queryRes = await db.prepare(
							`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE group_id IS NULL AND reply_to IS NULL AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?`
						).bind(beforeId, limit + 1).all();
					} else {
						queryRes = await db.prepare(
							`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE group_id IS NULL AND reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
						).bind(limit + 1, offset).all();
					}
					results = queryRes.results || [];
				}

				const selectedRows = results.slice(0, limit);
				const hydratedRows = includePosts
					? await attachInlinePostMetrics(db, selectedRows, viewerId)
					: selectedRows;
				const ids = selectedRows.map((r) => r.id);
				const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null;
				const nextCursor = results.length > limit && lastRow
					? (encodePostCursor(lastRow) || ids[ids.length - 1])
					: null;
				return json({
					ids,
					...(includePosts ? { posts: hydratedRows.map(normalizePostRow) } : {}),
					has_more: results.length > limit,
					next_cursor: nextCursor,
				});
			}

				if (method === 'GET' && pathname === '/posts/recommended/ids') {
					const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 30), 1), 100);
					const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
					const beforeId = Number.isSafeInteger(Number(url.searchParams.get('beforeId'))) && Number(url.searchParams.get('beforeId')) > 0
						? Number(url.searchParams.get('beforeId'))
						: null;
					const offset = (beforeId == null && !decodedCursor) ? Math.max(Number(url.searchParams.get('offset') || 0), 0) : 0;
					const viewerIdParam = url.searchParams.get('viewerId');
					const viewerId = viewerIdParam !== null && Number.isSafeInteger(Number(viewerIdParam))
						? Number(viewerIdParam)
						: null;
					const includePosts = url.searchParams.get('includePosts') === 'true';
					const scoringBlockSize = Math.max(240, limit * 8);
					const candidateLimit = scoringBlockSize + 1;
					const candidateWhere = decodedCursor
						? 'p.group_id IS NULL AND p.reply_to IS NULL AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))'
						: (beforeId != null ? 'p.group_id IS NULL AND p.reply_to IS NULL AND p.id < ?' : 'p.group_id IS NULL AND p.reply_to IS NULL');
					const candidateBindings = decodedCursor
						? [decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, candidateLimit, offset, scoringBlockSize]
						: (beforeId != null
							? [beforeId, candidateLimit, offset, scoringBlockSize]
							: [candidateLimit, offset, scoringBlockSize]);
					const commonCtes = `WITH candidate_source AS (
							SELECT p.id, p.user_id, p.created_at, p.tags,
								COALESCE(p.like_count, 0) AS like_count,
								COALESCE(p.star_count, 0) AS star_count,
								COALESCE(p.repost_count, 0) AS repost_count
							FROM posts p
							WHERE ${candidateWhere}
							ORDER BY p.created_at DESC, p.id DESC
							LIMIT ? OFFSET ?
						), candidates AS (
							SELECT id, user_id, created_at, tags, like_count, star_count, repost_count
							FROM candidate_source
							ORDER BY created_at DESC, id DESC
							LIMIT ?
					)`;
					const engagementScore = `MIN(22.0,
								/* Keep simple like and star scores below the repost score. */
								c.like_count * 2.0 / (c.like_count + 4.0)
								+ c.star_count * 4.0 / (c.star_count + 2.0)
								+ c.repost_count * 10.0 / (c.repost_count + 2.0))`;
					const recencyScore = `72.0 / (1.0 + MAX(0.0, (julianday('now') - julianday(c.created_at)) * 24.0) / 4.5)`;
					const query = viewerId == null
						? `${commonCtes}, scored AS (
							SELECT c.id, c.created_at, ${recencyScore} + ${engagementScore} AS score
							FROM candidates c
						)
						SELECT COALESCE(json_group_array(id), '[]') AS ids,
								(SELECT COUNT(*) FROM candidate_source) AS candidate_count,
								(SELECT created_at FROM candidate_source ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET ${scoringBlockSize - 1}) AS cursor_created_at,
								(SELECT id FROM candidate_source ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET ${scoringBlockSize - 1}) AS cursor_id
							FROM (
								SELECT s.id FROM scored s
								CROSS JOIN (SELECT AVG(score) AS average_score FROM scored) stats
								WHERE s.score >= stats.average_score * 0.75
								ORDER BY s.score DESC, s.created_at DESC, s.id DESC
							)`
						: `${commonCtes}, viewer_keyword_profile AS (
							SELECT keyword, score
							FROM user_keyword_affinities
							WHERE user_id = ?
							ORDER BY score DESC, keyword ASC
							LIMIT 80
						), viewer_keyword_affinity AS (
							SELECT c.id AS post_id,
								SUM(profile.score * CASE
									WHEN profile.keyword = post_tag.value THEN 1.0
									ELSE MIN(LENGTH(profile.keyword), LENGTH(post_tag.value)) * 1.0
										/ MAX(LENGTH(profile.keyword), LENGTH(post_tag.value))
								END) AS score
							FROM candidates c
								CROSS JOIN json_each(COALESCE(c.tags, '[]')) AS post_tag
							CROSS JOIN viewer_keyword_profile profile
							WHERE profile.keyword = post_tag.value
								OR (
									LENGTH(profile.keyword) >= 3
									AND LENGTH(post_tag.value) >= 3
									AND (instr(post_tag.value, profile.keyword) > 0 OR instr(profile.keyword, post_tag.value) > 0)
								)
							GROUP BY c.id
							), viewer_reacted AS (
								SELECT post_id FROM likes WHERE user_id = ?
								UNION
								SELECT post_id FROM stars WHERE user_id = ?
								UNION
								SELECT post_id FROM reposts WHERE user_id = ?
							), direct_follows AS (
							SELECT following_id AS user_id FROM follows WHERE follower_id = ?
						), second_degree_follows AS (
							SELECT DISTINCT f2.following_id AS user_id
							FROM follows f1 JOIN follows f2 ON f2.follower_id = f1.following_id
							WHERE f1.follower_id = ? AND f2.following_id <> ?
						), scored AS (
							SELECT c.id, c.created_at,
								MAX(0.0, ${recencyScore} + ${engagementScore}
									+ CASE WHEN df.user_id IS NOT NULL THEN 24.0 WHEN sdf.user_id IS NOT NULL THEN 10.0 ELSE 0.0 END
									+ CASE WHEN vr.post_id IS NOT NULL THEN -35.0 ELSE 0.0 END
									+ MIN(30.0, COALESCE(vka.score, 0) * 2.0)) AS score
							FROM candidates c
								LEFT JOIN viewer_keyword_affinity vka ON vka.post_id = c.id
								LEFT JOIN viewer_reacted vr ON vr.post_id = c.id
								LEFT JOIN direct_follows df ON df.user_id = c.user_id
							LEFT JOIN second_degree_follows sdf ON sdf.user_id = c.user_id
						)
						SELECT COALESCE(json_group_array(id), '[]') AS ids,
								(SELECT COUNT(*) FROM candidate_source) AS candidate_count,
								(SELECT created_at FROM candidate_source ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET ${scoringBlockSize - 1}) AS cursor_created_at,
								(SELECT id FROM candidate_source ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET ${scoringBlockSize - 1}) AS cursor_id
							FROM (
								SELECT s.id FROM scored s
								CROSS JOIN (SELECT AVG(score) AS average_score FROM scored) stats
								WHERE s.score >= stats.average_score * 0.75
								ORDER BY s.score DESC, s.created_at DESC, s.id DESC
							)`;
					const bindings = viewerId == null
						? candidateBindings
							: [...candidateBindings, viewerId, viewerId, viewerId, viewerId, viewerId, viewerId, viewerId];
					const { results } = await db.prepare(query).bind(...bindings).all();
					const row = (results || [])[0] || {};
					let ids = [];
					try {
						ids = Array.isArray(row.ids) ? row.ids : JSON.parse(row.ids || '[]');
					} catch (_) {
						ids = [];
					}
					const candidateCount = Math.max(0, Number(row.candidate_count) || 0);
					const normalizedIds = ids.map(Number).filter(Number.isSafeInteger);
					let posts = null;
					if (includePosts && normalizedIds.length > 0) {
						const placeholders = normalizedIds.map(() => '?').join(', ');
						const postRows = await db.prepare(`SELECT * FROM posts WHERE id IN (${placeholders})`).bind(...normalizedIds).all();
						const postsById = new Map((postRows.results || []).map((post) => [Number(post.id), normalizePostRow(post)]));
						posts = normalizedIds.map((id) => postsById.get(id)).filter(Boolean);
					}
					const cursorPost = candidateCount > scoringBlockSize && row.cursor_created_at && row.cursor_id
						? { id: Number(row.cursor_id), created_at: row.cursor_created_at }
						: null;
					return json({
						ids: normalizedIds,
						...(posts ? { posts } : {}),
						has_more: candidateCount > scoringBlockSize,
						next_cursor: cursorPost ? encodePostCursor(cursorPost) : null,
						next_offset: offset + Math.min(candidateCount, scoringBlockSize),
						use_offset_pagination: !decodedCursor,
					});
				}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/post-ids$/)) {
				const userId = Number(pathname.split('/')[2]);
				const subType = url.searchParams.get('subType') || 'all';
				const includePosts = url.searchParams.get('includePosts') === 'true';
				const limit = Math.min(Number(url.searchParams.get('limit') || 30), 100);
				const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
				const beforeId = Number.isSafeInteger(Number(url.searchParams.get('beforeId'))) && Number(url.searchParams.get('beforeId')) > 0
					? Number(url.searchParams.get('beforeId'))
					: null;
				const offset = (beforeId == null && !decodedCursor) ? Number(url.searchParams.get('offset') || 0) : 0;

				let sql = `SELECT ${includePosts ? '*' : 'id, created_at'} FROM posts WHERE user_id = ? AND group_id IS NULL`;
				const bindings = [userId];
				if (subType === 'posts_only') sql += ' AND reply_to IS NULL';
				if (subType === 'replies_only') sql += ' AND reply_to IS NOT NULL';
				if (decodedCursor) {
					sql += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
					bindings.push(decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id);
				} else if (beforeId != null) {
					sql += ' AND id < ?';
					bindings.push(beforeId);
				}
				sql += (decodedCursor || beforeId != null)
					? ' ORDER BY created_at DESC, id DESC LIMIT ?'
					: ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
				bindings.push(limit + 1);
				if (!decodedCursor && beforeId == null) bindings.push(offset);

				const { results } = await db.prepare(sql).bind(...bindings).all();
				const rows = results || [];
				const ids = rows.slice(0, limit).map((r) => r.id);
				const selectedRows = rows.slice(0, limit);
				const hydratedRows = includePosts
					? await attachInlinePostMetrics(db, selectedRows, viewerId)
					: selectedRows;
				const posts = includePosts ? hydratedRows.map(normalizePostRow) : null;
				const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null;
				const nextCursor = rows.length > limit && lastRow
					? (encodePostCursor(lastRow) || ids[ids.length - 1])
					: null;
				return json({
					ids,
					...(posts ? { posts } : {}),
					has_more: rows.length > limit,
					next_cursor: nextCursor,
				});
			}

			if (method === 'GET' && pathname === '/posts/search/ids') {
				const q = url.searchParams.get('q') || '';
				const includePosts = url.searchParams.get('includePosts') === 'true';
				const viewerIdParam = url.searchParams.get('viewerId');
				const viewerId = viewerIdParam !== null && Number.isSafeInteger(Number(viewerIdParam))
					? Number(viewerIdParam)
					: null;
				const limit = Math.min(Number(url.searchParams.get('limit') || 30), 100);
				const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
				const beforeId = Number.isSafeInteger(Number(url.searchParams.get('beforeId'))) && Number(url.searchParams.get('beforeId')) > 0
					? Number(url.searchParams.get('beforeId'))
					: null;
				const offset = (beforeId == null && !decodedCursor) ? Number(url.searchParams.get('offset') || 0) : 0;
				if (!q.trim()) return json({ ids: [], has_more: false, next_cursor: null });

				const fetchLimit = Math.max(200, (offset + limit) * 3);
				const { results } = decodedCursor
					? await db.prepare(
						'SELECT id, content, tags, created_at FROM posts WHERE group_id IS NULL AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?'
					).bind(decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, fetchLimit).all()
					: (beforeId != null
						? await db.prepare(
							'SELECT id, content, tags, created_at FROM posts WHERE group_id IS NULL AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?'
						).bind(beforeId, fetchLimit).all()
						: await db.prepare(
							'SELECT id, content, tags, created_at FROM posts WHERE group_id IS NULL ORDER BY created_at DESC, id DESC LIMIT ?'
						).bind(fetchLimit).all());

				const rows = results || [];
				const matched = [];
				for (const row of rows) {
					const content = String(row.content || '').toLowerCase();
					const tags = normalizePostTags(row.tags);
					if (
						isFuzzyMatch(content, q, 0.8) ||
						tags.some((tag) => isFuzzyMatch(String(tag), q, 0.8))
					) {
						matched.push(row);
					}
				}

				const matchedSlice = matched.slice(offset, offset + limit);
				const ids = matchedSlice.map((r) => r.id);
				let posts = null;
				if (includePosts && ids.length > 0) {
					const placeholders = ids.map(() => '?').join(', ');
					const postRows = await db.prepare(`SELECT * FROM posts WHERE id IN (${placeholders})`).bind(...ids).all();
					const hydratedRows = await attachInlinePostMetrics(db, postRows.results || [], viewerId);
					const postMap = new Map(hydratedRows.map((row) => [Number(row.id), row]));
					posts = ids.map((id) => postMap.get(Number(id))).filter(Boolean).map(normalizePostRow);
				}
				const lastMatched = matchedSlice.length > 0 ? matchedSlice[matchedSlice.length - 1] : null;
				const nextCursor = matched.length > offset + limit && lastMatched
					? (encodePostCursor(lastMatched) || ids[ids.length - 1])
					: null;
				return json({
					ids,
					...(posts ? { posts } : {}),
					has_more: matched.length > offset + limit,
					next_cursor: nextCursor,
				});
			}

			if (method === 'GET' && pathname === '/posts/search') {
				const q = url.searchParams.get('q') || '';
				const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
				if (!q.trim()) return json([]);

				const fetchLimit = Math.max(200, limit * 3);
				const { results } = await db.prepare(
					'SELECT * FROM posts WHERE group_id IS NULL ORDER BY created_at DESC, id DESC LIMIT ?'
				).bind(fetchLimit).all();

				const rows = results || [];
				const matched = [];
				for (const row of rows) {
					const content = String(row.content || '').toLowerCase();
					const tags = normalizePostTags(row.tags);
					if (
						isFuzzyMatch(content, q, 0.8) ||
						tags.some((tag) => isFuzzyMatch(String(tag), q, 0.8))
					) {
						matched.push(normalizePostRow(row));
						if (matched.length >= limit) break;
					}
				}

				return json(matched);
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/reply-ids$/)) {
				const parentPostId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
				const offset = !decodedCursor ? Number(url.searchParams.get('offset') || 0) : 0;

				const { results } = decodedCursor
					? await db.prepare(
						'SELECT id, created_at FROM posts WHERE reply_to = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?'
					).bind(parentPostId, decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, limit + 1).all()
					: await db.prepare(
						'SELECT id, created_at FROM posts WHERE reply_to = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
					).bind(parentPostId, limit + 1, offset).all();

				const rows = results || [];
				const selectedRows = rows.slice(0, limit);
				const ids = selectedRows.map((r) => r.id);
				const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null;
				const nextCursor = rows.length > limit && lastRow
					? (encodePostCursor(lastRow) || ids[ids.length - 1])
					: null;
				return json({
					ids,
					has_more: rows.length > limit,
					next_cursor: nextCursor,
				});
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/thread-reply-ids$/)) {
				const parentPostId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const offset = Number(url.searchParams.get('offset') || 0);

				const { results } = await db.prepare(
					`WITH RECURSIVE reply_tree(id, reply_to, depth) AS (
						SELECT id, reply_to, 0 FROM posts WHERE reply_to = ?
						UNION ALL
						SELECT p.id, p.reply_to, rt.depth + 1 FROM posts p
						JOIN reply_tree rt ON p.reply_to = rt.id
						WHERE rt.depth < 10
					)
					SELECT id FROM reply_tree LIMIT ? OFFSET ?`
				).bind(parentPostId, limit + 1, offset).all();

				const rows = results || [];
				return json({
					ids: rows.slice(0, limit).map((r) => r.id),
					has_more: rows.length > limit,
				});
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/detail$/)) {
				const postId = Number(pathname.split('/')[2]);
				const currentUserId = url.searchParams.get('currentUserId') ? Number(url.searchParams.get('currentUserId')) : null;
				const viewerId = currentUserId ? currentUserId : null;

				// 詳細画面で必要な関連情報を単一クエリへ集約し、WorkerとD1間の逐次往復をなくす。
				const detail = await db.prepare(
					`SELECT p.*,
						author.id AS author_id,
						author.name AS author_name,
						author.scid AS author_scid,
						COALESCE((SELECT COUNT(*) FROM likes WHERE post_id = p.id), 0) AS like_count,
						COALESCE((SELECT COUNT(*) FROM stars WHERE post_id = p.id), 0) AS star_count,
						EXISTS(SELECT 1 FROM likes WHERE user_id = ? AND post_id = p.id) AS liked_by_me,
						EXISTS(SELECT 1 FROM stars WHERE user_id = ? AND post_id = p.id) AS starred_by_me,
						parent.id AS parent_id,
						parent.content AS parent_content,
						parent_author.id AS parent_author_id,
						parent_author.name AS parent_author_name
					 FROM posts p
					 LEFT JOIN users author ON author.id = p.user_id
					 LEFT JOIN posts parent ON parent.id = p.reply_to
					 LEFT JOIN users parent_author ON parent_author.id = parent.user_id
					 WHERE p.id = ?`
				).bind(viewerId, viewerId, postId).first();
				if (!detail) return json(null);

				const parentPost = detail.parent_id == null
					? null
					: {
						id: detail.parent_id,
						content: detail.parent_content ? String(detail.parent_content).substring(0, 100) : '',
						author: detail.parent_author_id == null
							? null
							: { id: detail.parent_author_id, name: detail.parent_author_name || '' },
					};

				return json({
					...normalizePostRow(detail),
					author: detail.author_id == null
						? null
						: { id: detail.author_id, name: detail.author_name || '', scid: detail.author_scid || null },
					like_count: Number(detail.like_count || 0),
					star_count: Number(detail.star_count || 0),
					liked_by_me: Boolean(detail.liked_by_me),
					starred_by_me: Boolean(detail.starred_by_me),
					parent_post: parentPost,
				});
			}

			if (method === 'GET' && pathname === '/posts/trending') {
				const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
				const { results } = await db.prepare(
					`SELECT p.*,
					   (COALESCE(p.like_count, 0) +
					    COALESCE(p.star_count, 0) * 2 +
					    COALESCE(p.repost_count, 0) * 3) as score
					 FROM posts p
					 WHERE p.group_id IS NULL AND p.reply_to IS NULL
					   AND p.created_at >= datetime('now', '-3 days')
					 ORDER BY score DESC, p.created_at DESC
					 LIMIT ?`
				).bind(limit).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'GET' && pathname === '/posts/trending-hashtags') {
				const limit = Math.min(Number(url.searchParams.get('limit') || 10), 50);
				const type = String(url.searchParams.get('type') || '').trim().toLowerCase();
				const isSummary = url.searchParams.get('summary') === 'true' || url.searchParams.get('detailed') === 'true';
				const { results } = await db.prepare(
					"SELECT user_id, content, tags FROM posts WHERE group_id IS NULL AND created_at >= datetime('now', '-3 days') ORDER BY created_at DESC LIMIT 500"
				).all();
				const hashtagUsers = new Map();
				const tagUsers = new Map();
				const wordUsers = new Map();

				for (const row of results || []) {
					const userId = row.user_id || 'anonymous';
					const content = row.content || '';
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

					const tags = normalizePostTags(row.tags);
					const postWords = new Set(
						tags
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
						.slice(0, limit)
						.map((c) => ({ tag_name: c.representative, occurrence_count: c.users.size }));
				};

				const hashtagsList = mapToMergedSortedList(hashtagUsers);
				const wordsList = mapToMergedSortedList(wordUsers);
				const tagsList = mapToMergedSortedList(tagUsers);

				if (type === 'hashtags') return json(hashtagsList);
				if (type === 'words') return json(wordsList);
				if (type === 'tags') return json(tagsList.length > 0 ? tagsList : wordsList);

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

				if (isSummary) {
					return json({
						trends: trendsList,
						hashtags: hashtagsList,
						tags: tagsList.length > 0 ? tagsList : wordsList,
						words: wordsList,
					});
				}

				return json(trendsList);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/posts\/count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM posts WHERE user_id = ?').bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/media\/count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare(
					`SELECT COUNT(*) AS count FROM posts
					 WHERE user_id = ?
					   AND json_valid(attachments)
					   AND json_type(attachments) = 'array'
					   AND json_array_length(attachments) > 0`
				).bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/media$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 15), 1), 100);
				const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
				const offset = !decodedCursor ? Math.max(Number(url.searchParams.get('offset') || 0), 0) : 0;
				const type = url.searchParams.get('type');

				const clauses = [
					'p.user_id = ?',
					'json_valid(p.attachments)',
					"json_type(p.attachments) = 'array'",
				];
				const values = [userId];
				if (type && (type === 'image' || type === 'video')) {
					clauses.push("COALESCE(json_extract(attachment.value, '$.type'), 'file') = ?");
					values.push(type);
				}
				if (decodedCursor) {
					if (decodedCursor.position != null) {
						clauses.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?) OR (p.created_at = ? AND p.id = ? AND CAST(attachment.key AS INTEGER) >= ?))');
						values.push(decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, decodedCursor.createdAt, decodedCursor.id, decodedCursor.position);
					} else {
						clauses.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?))');
						values.push(decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id);
					}
				}

				values.push(limit + 1);
				let offsetSql = '';
				if (!decodedCursor) {
					values.push(offset);
					offsetSql = ' OFFSET ?';
				}

				const { results } = await db.prepare(
					`SELECT p.id AS post_id,
						p.created_at,
						CAST(attachment.key AS INTEGER) AS position,
						json_extract(attachment.value, '$.id') AS file_id,
						COALESCE(json_extract(attachment.value, '$.type'), 'file') AS file_type
					 FROM posts p
					 CROSS JOIN json_each(p.attachments) AS attachment
					 WHERE ${clauses.join(' AND ')}
					 ORDER BY p.created_at DESC, p.id DESC, CAST(attachment.key AS INTEGER) ASC
					 LIMIT ?${offsetSql}`
				).bind(...values).all();

				const rows = results || [];
				const selectedRows = rows.slice(0, limit);
				const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null;
				const nextCursor = rows.length > limit && lastRow
					? encodePostCursor({ createdAt: lastRow.created_at, id: lastRow.post_id, position: lastRow.position + 1 })
					: null;

				return json(selectedRows.map((row) => ({
					post_id: Number(row.post_id),
					file_id: row.file_id,
					file_type: row.file_type || 'file',
					type: row.file_type || 'file',
				})), 200, nextCursor ? { 'X-Next-Cursor': nextCursor } : {});
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/replies\/count$/)) {
				const postId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM posts WHERE reply_to = ?').bind(postId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)$/)) {
				const postId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first();
				return json(normalizePostRow(row));
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/like$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const existing = await db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				if (existing) {
					await db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').bind(userId, postId).run();
					await adjustUserKeywordAffinities(db, userId, postId, -1);
				} else {
					const now = new Date().toISOString();
					await db.prepare('INSERT INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(userId, postId, now).run();
					await adjustUserKeywordAffinities(db, userId, postId, 1);
				}
				const countRow = await db.prepare('SELECT COUNT(*) as count FROM likes WHERE post_id = ?').bind(postId).first();
				return json({ liked: !existing, count: Number(countRow?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/likes\/count$/)) {
				const postId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM likes WHERE post_id = ?').bind(postId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/likes\/check$/)) {
				const postId = Number(pathname.split('/')[2]);
				const userId = Number(url.searchParams.get('userId'));
				const row = await db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				return json({ liked: Boolean(row) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/likes\/ids$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT post_id FROM likes WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all();
				return json((results || []).map((r) => r.post_id));
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/star$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const existing = await db.prepare('SELECT 1 FROM stars WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				if (existing) {
					await db.prepare('DELETE FROM stars WHERE user_id = ? AND post_id = ?').bind(userId, postId).run();
					await adjustUserKeywordAffinities(db, userId, postId, -3);
				} else {
					const now = new Date().toISOString();
					await db.prepare('INSERT INTO stars (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(userId, postId, now).run();
					await adjustUserKeywordAffinities(db, userId, postId, 3);
				}
				const countRow = await db.prepare('SELECT COUNT(*) as count FROM stars WHERE post_id = ?').bind(postId).first();
				return json({ starred: !existing, count: Number(countRow?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/stars\/count$/)) {
				const postId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM stars WHERE post_id = ?').bind(postId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/stars\/check$/)) {
				const postId = Number(pathname.split('/')[2]);
				const userId = Number(url.searchParams.get('userId'));
				const row = await db.prepare('SELECT 1 FROM stars WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				return json({ starred: Boolean(row) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/stars\/ids$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT post_id FROM stars WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all();
				return json((results || []).map((r) => r.post_id));
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/pin$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const post = await db.prepare('SELECT user_id FROM posts WHERE id = ?').bind(postId).first();
				if (!post || Number(post.user_id) !== userId) {
					return badRequest('Cannot pin a post you do not own');
				}

				const existing = await db.prepare('SELECT 1 FROM pinned_posts WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				if (existing) {
					await db.prepare('DELETE FROM pinned_posts WHERE user_id = ? AND post_id = ?').bind(userId, postId).run();
					return json({ pinned: false });
				}
				const now = new Date().toISOString();
				await db.prepare('INSERT INTO pinned_posts (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(userId, postId, now).run();
				return json({ pinned: true });
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/dislike$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);
				await adjustUserKeywordAffinities(db, userId, postId, -15);
				return json({ success: true });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/pinned$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare(
					`SELECT p.* FROM posts p JOIN pinned_posts pp ON pp.post_id = p.id
					 WHERE pp.user_id = ? ORDER BY pp.created_at DESC`
				).bind(userId).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/pinned\/id$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT post_id FROM pinned_posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').bind(userId).first();
				return json({ postId: row?.post_id || null });
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/repost$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const original = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first();
				if (!original) return notFound('Post not found');

				const existing = await db.prepare('SELECT 1 FROM reposts WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				if (existing) return badRequest('Already reposted');

				const now = new Date().toISOString();
				await db.prepare('INSERT INTO reposts (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(userId, postId, now).run();

				const res = await db.prepare(
					`INSERT INTO posts (user_id, content, attachments, mask, lock, repost_to, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`
				).bind(userId, original.content, original.attachments, original.mask, original.lock, postId, now).run();

				const created = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(res.meta.last_row_id).first();
				return json(normalizePostRow(created));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/reposts$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare(
					`SELECT p.* FROM posts p JOIN reposts r ON r.post_id = p.repost_to
					 WHERE r.user_id = ? ORDER BY r.created_at DESC`
				).bind(userId).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/reposts$/)) {
				const postId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const { results } = await db.prepare(
					`SELECT u.id as user_id, u.name, u.handle FROM reposts r
					 JOIN users u ON u.id = r.user_id WHERE r.post_id = ? ORDER BY r.created_at DESC LIMIT ?`
				).bind(postId, limit).all();
				return json(results || []);
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/reposts\/count$/)) {
				const postId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM reposts WHERE post_id = ?').bind(postId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname === '/dm/list') {
				const userId = Number(url.searchParams.get('userId'));
				const { results } = await db.prepare(
					`SELECT * FROM dm_channels WHERE EXISTS (
						SELECT 1 FROM json_each(dm_channels.participants)
						WHERE CAST(json_each.value AS INTEGER) = ?
					 )`,
				).bind(userId).all();
				return json(results || []);
			}

			if (method === 'POST' && pathname === '/dm/channel') {
				const body = await request.json();
				const u1 = Math.min(Number(body.userId1), Number(body.userId2));
				const u2 = Math.max(Number(body.userId1), Number(body.userId2));
				const channelId = `${u1}:${u2}`;

				const existing = await db.prepare('SELECT * FROM dm_channels WHERE id = ?').bind(channelId).first();
				if (existing) return json(existing);

				const now = new Date().toISOString();
				await db.prepare('INSERT INTO dm_channels (id, participants, created_at) VALUES (?, ?, ?)').bind(channelId, JSON.stringify([u1, u2]), now).run();
				return json({ id: channelId, participants: [u1, u2], created_at: now });
			}

			if (method === 'GET' && pathname.startsWith('/dm/messages/')) {
				const channelId = decodeURIComponent(pathname.slice('/dm/messages/'.length));
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const offset = Number(url.searchParams.get('offset') || 0);

				const { results } = await db.prepare('SELECT * FROM dm_messages WHERE channel_id = ? ORDER BY sent_at DESC LIMIT ? OFFSET ?').bind(channelId, limit, offset).all();
				return json(results || []);
			}

			if (method === 'POST' && pathname === '/dm/messages') {
				const body = await request.json();
				const channelId = String(body.channelId);
				const senderId = Number(body.senderId);
				const content = String(body.content || '');
				const now = body.sentAt ? new Date(body.sentAt).toISOString() : new Date().toISOString();
				const hasExplicitId = body.id != null && Number.isSafeInteger(Number(body.id)) && Number(body.id) > 0;

				let createdId;
				if (hasExplicitId) {
					createdId = Number(body.id);
					await db.prepare('INSERT INTO dm_messages (id, channel_id, sender_id, content, sent_at) VALUES (?, ?, ?, ?, ?)').bind(createdId, channelId, senderId, content, now).run();
				} else {
					const res = await db.prepare('INSERT INTO dm_messages (channel_id, sender_id, content, sent_at) VALUES (?, ?, ?, ?)').bind(channelId, senderId, content, now).run();
					createdId = res.meta.last_row_id;
				}

				const row = await db.prepare('SELECT * FROM dm_messages WHERE id = ?').bind(createdId).first();
				return json(row ? {
					id: Number(row.id),
					channelId: row.channel_id,
					channel_id: row.channel_id,
					senderId: Number(row.sender_id),
					sender_id: Number(row.sender_id),
					content: row.content,
					sentAt: row.sent_at,
					sent_at: row.sent_at,
					readAt: row.read_at,
					read_at: row.read_at,
				} : null);
			}

			if (method === 'POST' && pathname === '/dm/read') {
				const body = await request.json();
				const channelId = String(body.channelId);
				const userId = Number(body.userId);
				const now = new Date().toISOString();
				await db.prepare('UPDATE dm_messages SET read_at = ? WHERE channel_id = ? AND sender_id != ? AND read_at IS NULL').bind(now, channelId, userId).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname === '/dm/unread') {
				const userId = Number(url.searchParams.get('userId'));
				const row = await db.prepare(
					`SELECT COUNT(*) AS count FROM dm_messages m
					 JOIN dm_channels c ON c.id = m.channel_id
					 WHERE EXISTS (
						SELECT 1 FROM json_each(c.participants)
						WHERE CAST(json_each.value AS INTEGER) = ?
					 ) AND m.sender_id != ? AND m.read_at IS NULL`
				).bind(userId, userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/group-dms$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 50), 100));
				const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
				const { results } = await db.prepare(
					`SELECT * FROM group_dms
					 WHERE host_id = ? OR EXISTS (
						SELECT 1 FROM json_each(group_dms.member)
						WHERE CAST(json_each.value AS INTEGER) = ?
					 )
					 ORDER BY time DESC LIMIT ? OFFSET ?`,
				).bind(userId, userId, limit, offset).all();
				return json((results || []).map((r) => normalizeGroupDmRow(r, userId)));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/group-dms\/visibility$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare(
					`SELECT id, member, unread FROM group_dms
					 WHERE host_id = ? OR EXISTS (
						SELECT 1 FROM json_each(group_dms.member)
						WHERE CAST(json_each.value AS INTEGER) = ?
					 )`,
				).bind(userId, userId).all();
				return json((results || []).map((row) => ({
					id: row.id,
					member: parseJsonSafe(row.member, []),
					unread: parseJsonSafe(row.unread, {}),
				})));
			}

			if (method === 'GET' && pathname.match(/^\/group-dms\/([^/]+)$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const row = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
				return json(normalizeGroupDmRow(row));
			}

			if (method === 'POST' && pathname === '/group-dms') {
				const body = await request.json();
				const id = crypto.randomUUID();
				const hostId = Number(body.hostId);
				const member = Array.isArray(body.member) ? body.member.map(Number) : [hostId];
				const accepted = Array.isArray(body.accepted) ? body.accepted.map(Number) : member;
				const title = String(body.title || '');
				const now = new Date().toISOString();

				await db.prepare(
					`INSERT INTO group_dms (id, host_id, title, member, post, unread, time, created_at)
					 VALUES (?, ?, ?, ?, '[]', ?, ?, ?)`
				).bind(id, hostId, title, JSON.stringify(member), JSON.stringify({ _accepted: accepted }), now, now).run();

				const row = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(id).first();
				return json(normalizeGroupDmRow(row, hostId));
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/update$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const updates = await request.json();
				const currentRow = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
				if (!currentRow) return notFound('Group DM not found');
				const sets = [];
				const values = [];

				if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title); }
				if (updates.host_id !== undefined || updates.hostId !== undefined) { sets.push('host_id = ?'); values.push(Number(updates.host_id ?? updates.hostId)); }
				if (updates.member !== undefined) { sets.push('member = ?'); values.push(JSON.stringify(updates.member.map(Number))); }
				if (updates.post !== undefined) { sets.push('post = ?'); values.push(JSON.stringify(updates.post)); }
				if (updates.unread !== undefined) { sets.push('unread = ?'); values.push(JSON.stringify(updates.unread)); }
				if (updates.accepted !== undefined) {
					const unread = parseJsonSafe(currentRow.unread, {});
					unread._accepted = Array.isArray(updates.accepted) ? updates.accepted.map(Number) : [];
					sets.push('unread = ?'); values.push(JSON.stringify(unread));
				}
				if (updates.time !== undefined) { sets.push('time = ?'); values.push(updates.time); }

				if (sets.length > 0) {
					values.push(dmId);
					await db.prepare(`UPDATE group_dms SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
				}
				const row = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
				return json(normalizeGroupDmRow(row));
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/messages$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const message = body.message;
				const senderId = body.senderId != null ? Number(body.senderId) : null;

				const row = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
				if (!row) return notFound('Group DM not found');

				const posts = parseJsonSafe(row.post, []);
				posts.push(message);
				const unread = parseJsonSafe(row.unread, {});
				const members = parseJsonSafe(row.member, []);

				if (senderId != null) {
					unread[String(senderId)] = 0;
					for (const m of members) {
						if (Number(m) !== senderId) {
							const k = String(m);
							unread[k] = Number(unread[k] || 0) + 1;
						}
					}
				}

				const time = message.time || new Date().toISOString();
				await db.prepare('UPDATE group_dms SET post = ?, unread = ?, time = ? WHERE id = ?').bind(JSON.stringify(posts), JSON.stringify(unread), time, dmId).run();

				const updated = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
				return json(normalizeGroupDmRow(updated, senderId));
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/read$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const row = await db.prepare('SELECT unread FROM group_dms WHERE id = ?').bind(dmId).first();
				if (row) {
					const unread = parseJsonSafe(row.unread, {});
					unread[String(userId)] = 0;
					await db.prepare('UPDATE group_dms SET unread = ? WHERE id = ?').bind(JSON.stringify(unread), dmId).run();
				}
				return json({ success: true });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/group-dms\/unread-counts$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare(
					`SELECT id, member, unread FROM group_dms
					 WHERE host_id = ? OR EXISTS (
						SELECT 1 FROM json_each(group_dms.member)
						WHERE CAST(json_each.value AS INTEGER) = ?
					 )`,
				).bind(userId, userId).all();
				const counts = [];
				for (const r of results || []) {
					const members = parseJsonSafe(r.member, []);
					if (Array.isArray(members) && members.map(Number).includes(userId)) {
						const unread = parseJsonSafe(r.unread, {});
						counts.push({ dm_id: r.id, unread_count: Number(unread[String(userId)] || 0) });
					}
				}
				return json(counts);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/group-dms\/unread-total$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare(
					`SELECT COALESCE(SUM(COALESCE(json_extract(unread, '$.' || ?), 0)), 0) AS total
					 FROM group_dms
					 WHERE host_id = ? OR EXISTS (
						SELECT 1 FROM json_each(group_dms.member)
						WHERE CAST(json_each.value AS INTEGER) = ?
					 )`,
				).bind(String(userId), userId, userId).first();
				return json({ total: Number(row?.total || 0) });
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/delete$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const res = await db.prepare('DELETE FROM group_dms WHERE id = ?').bind(dmId).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/leave$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const row = await db.prepare('SELECT member, unread FROM group_dms WHERE id = ?').bind(dmId).first();
				if (!row) return json({ success: false });

				const members = parseJsonSafe(row.member, []).filter((id) => Number(id) !== userId);
				const unread = parseJsonSafe(row.unread, {});
				delete unread[String(userId)];

				await db.prepare('UPDATE group_dms SET member = ?, unread = ? WHERE id = ?').bind(JSON.stringify(members), JSON.stringify(unread), dmId).run();
				return json({ success: true });
			}

			if (method === 'POST' && pathname === '/group-dms/find-by-members') {
				const body = await request.json();
				const target = Array.from(new Set(body.memberIds.map(Number))).sort((a, b) => a - b);
				if (target.length === 0) return json(null);
				const placeholders = target.map(() => '?').join(', ');
				const row = await db.prepare(
					`SELECT * FROM group_dms
					 WHERE json_array_length(member) = ?
					   AND (
						 SELECT COUNT(DISTINCT CAST(value AS INTEGER))
						 FROM json_each(group_dms.member)
						 WHERE CAST(value AS INTEGER) IN (${placeholders})
					   ) = ?
					 LIMIT 1`,
				).bind(target.length, ...target, target.length).first();
				return json(normalizeGroupDmRow(row));
			}

			// DM E2E暗号化用の公開鍵
			if (method === 'GET' && pathname === '/dm-e2e-keys') {
				const raw = String(url.searchParams.get('user_ids') || '');
				const ids = raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 0);
				if (ids.length === 0) return json([]);
				const placeholders = ids.map(() => '?').join(',');
				const { results } = await db.prepare(
					`SELECT user_id, public_key FROM dm_e2e_keys WHERE user_id IN (${placeholders})`
				).bind(...ids).all();
				return json((results || []).map((r) => ({
					user_id: Number(r.user_id),
					public_key: String(r.public_key),
				})));
			}

			if (method === 'POST' && pathname === '/dm-e2e-keys') {
				const body = await request.json();
				const userId = Number(body.userId);
				const publicKey = String(body.publicKey || '');
				if (!Number.isInteger(userId) || userId < 0 || !publicKey) {
					return badRequest('userId and publicKey are required');
				}
				const now = new Date().toISOString();
				await db.prepare(
					`INSERT INTO dm_e2e_keys (user_id, public_key, created_at, updated_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT (user_id) DO UPDATE SET public_key = excluded.public_key, updated_at = excluded.updated_at`
				).bind(userId, publicKey, now, now).run();
				return json({ success: true });
			}

			if (method === 'POST' && pathname === '/notifications') {
				const body = await request.json();
				const userId = Number(body.userId);
				const type = String(body.type);
				const fromUserId = body.fromUserId != null ? Number(body.fromUserId) : (body.from_user_id != null ? Number(body.from_user_id) : null);
				const postId = body.postId != null ? Number(body.postId) : (body.target?.kind === 'post' ? Number(body.target.id) : null);
				const target = body.target ? JSON.stringify(body.target) : null;
				const message = typeof body.message === 'string' ? body.message : null;
				const now = body.createdAt ? new Date(body.createdAt).toISOString() : new Date().toISOString();
				const hasExplicitId = body.id != null && Number.isSafeInteger(Number(body.id)) && Number(body.id) > 0;

				let createdId;
				if (hasExplicitId) {
					createdId = Number(body.id);
					await db.prepare(
						`INSERT INTO notifications (id, user_id, type, from_user_id, post_id, target, message, read, clicked, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
					).bind(createdId, userId, type, fromUserId, postId, target, message, now).run();
				} else {
					const res = await db.prepare(
						`INSERT INTO notifications (user_id, type, from_user_id, post_id, target, message, read, clicked, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`
					).bind(userId, type, fromUserId, postId, target, message, now).run();
					createdId = res.meta.last_row_id;
				}

				const row = await db.prepare('SELECT * FROM notifications WHERE id = ?').bind(createdId).first();
				return json(row ? {
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
					createdAt: row.created_at,
					created_at: row.created_at,
				} : null);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/notifications$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
				const offset = Number(url.searchParams.get('offset') || 0);

				const { results } = await db.prepare(
					'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
				).bind(userId, limit, offset).all();

				return json((results || []).map((r) => ({
					...r,
					target: parseJsonSafe(r.target, null),
					read: Boolean(r.read),
					clicked: Boolean(r.clicked),
				})));
			}

			if (method === 'POST' && pathname.match(/^\/notifications\/(\d+)\/read$/)) {
				const id = Number(pathname.split('/')[2]);
				await db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').bind(id).run();
				return json({ success: true });
			}

			if (method === 'POST' && pathname.match(/^\/notifications\/(\d+)\/click$/)) {
				const id = Number(pathname.split('/')[2]);
				await db.prepare('UPDATE notifications SET clicked = 1 WHERE id = ?').bind(id).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname.match(/^\/notifications\/(\d+)$/)) {
				const id = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT * FROM notifications WHERE id = ?').bind(id).first();
				return json(row ? { ...row, target: parseJsonSafe(row.target, null), read: Boolean(row.read), clicked: Boolean(row.clicked) } : null);
			}

			if (method === 'POST' && pathname.match(/^\/notifications\/(\d+)\/delete$/)) {
				const id = Number(pathname.split('/')[2]);
				const res = await db.prepare('DELETE FROM notifications WHERE id = ?').bind(id).run();
				return json({ success: res.meta.changes > 0 });
			}

					if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/notifications\/read-all$/)) {
						const userId = Number(pathname.split('/')[2]);
						await db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').bind(userId).run();
						return json({ success: true });
					}

					if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/notifications\/click-all$/)) {
						const userId = Number(pathname.split('/')[2]);
						await db.prepare('UPDATE notifications SET read = 1, clicked = 1 WHERE user_id = ? AND (read = 0 OR clicked = 0)').bind(userId).run();
						return json({ success: true });
					}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/notifications\/unread-count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0').bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/push-subscriptions$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const endpoint = String(body.endpoint);
				const expirationTime = body.expirationTime != null ? Number(body.expirationTime) : null;
				const p256dh = String(body.keys?.p256dh || '');
				const auth = String(body.keys?.auth || '');
				const sessionToken = body.sessionToken != null ? String(body.sessionToken) : null;
				const now = new Date().toISOString();

				await db.prepare(
					`INSERT INTO push_subscriptions (user_id, endpoint, expiration_time, p256dh, auth, session_token, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(user_id, endpoint) DO UPDATE SET
					   expiration_time = excluded.expiration_time,
					   p256dh = excluded.p256dh,
					   auth = excluded.auth,
					   session_token = COALESCE(excluded.session_token, push_subscriptions.session_token),
					   updated_at = excluded.updated_at`
				).bind(userId, endpoint, expirationTime, p256dh, auth, sessionToken, now, now).run();

				return json({ userId, endpoint, expirationTime, keys: { p256dh, auth }, sessionToken });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/push-subscriptions$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT endpoint, expiration_time, p256dh, auth, session_token FROM push_subscriptions WHERE user_id = ?').bind(userId).all();
				return json((results || []).map((r) => ({
					endpoint: r.endpoint,
					expirationTime: r.expiration_time ? Number(r.expiration_time) : null,
					keys: { p256dh: r.p256dh, auth: r.auth },
					sessionToken: r.session_token || null,
				})));
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/push-subscriptions\/delete$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const endpoint = String(body.endpoint);
				const res = await db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').bind(userId, endpoint).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'GET' && pathname.startsWith('/ranking/')) {
				const type = decodeURIComponent(pathname.slice('/ranking/'.length));
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);

				let sql = '';
				if (type === 'followers') {
					sql = `SELECT u.id AS user_id, u.name, u.scid, u.icon_data,
						   COUNT(f.follower_id) AS follower_count
						   FROM users u LEFT JOIN follows f ON f.following_id = u.id
						   GROUP BY u.id ORDER BY follower_count DESC, u.id ASC LIMIT ?`;
				} else if (type === 'posts') {
					sql = `SELECT u.id AS user_id, u.name, u.scid, u.icon_data,
						   COUNT(p.id) AS post_count
						   FROM users u LEFT JOIN posts p ON p.user_id = u.id
						   GROUP BY u.id ORDER BY post_count DESC, u.id ASC LIMIT ?`;
				} else if (type === 'likes') {
					sql = `SELECT u.id AS user_id, u.name, u.scid, u.icon_data,
						   COUNT(l.user_id) AS like_count
						   FROM users u
						   LEFT JOIN posts p ON p.user_id = u.id
						   LEFT JOIN likes l ON l.post_id = p.id
						   GROUP BY u.id ORDER BY like_count DESC, u.id ASC LIMIT ?`;
				} else if (type === 'stars') {
					sql = `SELECT u.id AS user_id, u.name, u.scid, u.icon_data,
						   COUNT(s.user_id) AS star_count
						   FROM users u
						   LEFT JOIN posts p ON p.user_id = u.id
						   LEFT JOIN stars s ON s.post_id = p.id
						   GROUP BY u.id ORDER BY star_count DESC, u.id ASC LIMIT ?`;
				} else {
					return badRequest('Invalid ranking type');
				}

				const { results } = await db.prepare(sql).bind(limit).all();
				return json(results || []);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/ranking\/([^/]+)$/)) {
				const parts = pathname.split('/');
				const userId = Number(parts[2]);
				const type = decodeURIComponent(parts[4]);

				let sql = '';
				const metricField = type === 'followers' ? 'follower_count' : (type === 'posts' ? 'post_count' : (type === 'likes' ? 'like_count' : 'star_count'));

				if (type === 'followers') {
					sql = `SELECT rank, follower_count FROM (
						   SELECT u.id, COUNT(f.follower_id) AS follower_count,
						     ROW_NUMBER() OVER (ORDER BY COUNT(f.follower_id) DESC, u.id ASC) AS rank
						   FROM users u LEFT JOIN follows f ON f.following_id = u.id GROUP BY u.id
					) WHERE id = ?`;
				} else if (type === 'posts') {
					sql = `SELECT rank, post_count FROM (
						   SELECT u.id, COUNT(p.id) AS post_count,
						     ROW_NUMBER() OVER (ORDER BY COUNT(p.id) DESC, u.id ASC) AS rank
						   FROM users u LEFT JOIN posts p ON p.user_id = u.id GROUP BY u.id
					) WHERE id = ?`;
				} else if (type === 'likes') {
					sql = `SELECT rank, like_count FROM (
						   SELECT u.id, COUNT(l.user_id) AS like_count,
						     ROW_NUMBER() OVER (ORDER BY COUNT(l.user_id) DESC, u.id ASC) AS rank
						   FROM users u
						   LEFT JOIN posts p ON p.user_id = u.id
						   LEFT JOIN likes l ON l.post_id = p.id
						   GROUP BY u.id
					) WHERE id = ?`;
				} else if (type === 'stars') {
					sql = `SELECT rank, star_count FROM (
						   SELECT u.id, COUNT(s.user_id) AS star_count,
						     ROW_NUMBER() OVER (ORDER BY COUNT(s.user_id) DESC, u.id ASC) AS rank
						   FROM users u
						   LEFT JOIN posts p ON p.user_id = u.id
						   LEFT JOIN stars s ON s.post_id = p.id
						   GROUP BY u.id
					) WHERE id = ?`;
				} else {
					return badRequest('Invalid ranking type');
				}

				const row = await db.prepare(sql).bind(userId).first();
				return json(row || { rank: null, [metricField]: 0 });
			}

			if (method === 'POST' && pathname === '/logs') {
				const body = await request.json();
				const scratchId = body.scratch_id || '';
				const nyaitterId = body.nyaitter_id != null ? Number(body.nyaitter_id) : null;
				const maskedIpUuid = body.masked_ip_uuid || '';
				const logTime = new Date().toISOString();

				await db.prepare('INSERT INTO logs (scratch_id, nyaitter_id, masked_ip_uuid, log_time) VALUES (?, ?, ?, ?)').bind(scratchId, nyaitterId, maskedIpUuid, logTime).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname === '/logs') {
				const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
				const offset = Number(url.searchParams.get('offset') || 0);
				const { results } = await db.prepare('SELECT * FROM logs ORDER BY log_time DESC LIMIT ? OFFSET ?').bind(limit, offset).all();
				return json(results || []);
			}

			// ==================== Polls ====================

			if (method === 'POST' && pathname === '/polls') {
				const body = await request.json();
				const pollId = Number(body.id) || Number(`${Date.now() % 1000000000}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`);
				const postId = Number(body.postId ?? body.post_id);
				const userId = Number(body.userId ?? body.user_id);
				const title = String(body.title || '').trim() || '投票';
				const options = JSON.stringify(body.options || []);
				const allowMultiple = body.allowMultiple || body.allow_multiple ? 1 : 0;
				const allowOther = body.allowOther || body.allow_other ? 1 : 0;
				const showResultsBeforeVoting = body.showResultsBeforeVoting !== false && body.show_results_before_voting !== false ? 1 : 0;
				const expiresAt = body.expiresAt || body.expires_at || null;
				const now = new Date().toISOString();

				await db.prepare(
					`INSERT INTO polls (id, post_id, user_id, title, options, allow_multiple, allow_other, show_results_before_voting, expires_at, closed, closed_notified, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
				).bind(pollId, postId, userId, title, options, allowMultiple, allowOther, showResultsBeforeVoting, expiresAt, now).run();

				const created = await db.prepare('SELECT * FROM polls WHERE id = ?').bind(pollId).first();
				return json(formatD1PollRow(created, [], userId));
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/poll$/)) {
				const postId = Number(pathname.split('/')[2]);
				const currentUserId = url.searchParams.get('currentUserId') != null ? Number(url.searchParams.get('currentUserId')) : null;
				const poll = await db.prepare('SELECT * FROM polls WHERE post_id = ?').bind(postId).first();
				if (!poll) return json(null);
				const { results: voteRows } = await db.prepare('SELECT * FROM poll_votes WHERE poll_id = ?').bind(poll.id).all();
				return json(formatD1PollRow(poll, voteRows || [], currentUserId));
			}

			if (method === 'GET' && pathname.match(/^\/polls\/(\d+)$/)) {
				const pollId = Number(pathname.split('/')[2]);
				const currentUserId = url.searchParams.get('currentUserId') != null ? Number(url.searchParams.get('currentUserId')) : null;
				const poll = await db.prepare('SELECT * FROM polls WHERE id = ?').bind(pollId).first();
				if (!poll) return notFound('Poll not found');
				const { results: voteRows } = await db.prepare('SELECT * FROM poll_votes WHERE poll_id = ?').bind(poll.id).all();
				return json(formatD1PollRow(poll, voteRows || [], currentUserId));
			}

			if (method === 'GET' && pathname === '/polls/by-posts') {
				const rawPostIds = url.searchParams.get('postIds') || '';
				const currentUserId = url.searchParams.get('currentUserId') != null ? Number(url.searchParams.get('currentUserId')) : null;
				const postIds = rawPostIds.split(',').map(Number).filter(Number.isSafeInteger);
				if (postIds.length === 0) return json([]);

				const placeholders = postIds.map(() => '?').join(', ');
				const { results: polls } = await db.prepare(`SELECT * FROM polls WHERE post_id IN (${placeholders})`).bind(...postIds).all();
				if (!polls || polls.length === 0) return json([]);

				const pollIds = polls.map((p) => p.id);
				const pollPlaceholders = pollIds.map(() => '?').join(', ');
				const { results: allVotes } = await db.prepare(`SELECT * FROM poll_votes WHERE poll_id IN (${pollPlaceholders})`).bind(...pollIds).all();

				const votesByPoll = new Map();
				for (const v of allVotes || []) {
					if (!votesByPoll.has(v.poll_id)) votesByPoll.set(v.poll_id, []);
					votesByPoll.get(v.poll_id).push(v);
				}

				const formattedList = polls.map((p) => formatD1PollRow(p, votesByPoll.get(p.id) || [], currentUserId)).filter(Boolean);
				return json(formattedList);
			}

			if (method === 'POST' && pathname.match(/^\/polls\/(\d+)\/vote$/)) {
				const pollId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId ?? body.user_id);
				const poll = await db.prepare('SELECT * FROM polls WHERE id = ?').bind(pollId).first();
				if (!poll) return notFound('Poll not found');

				const isExpired = Boolean(poll.expires_at && new Date(poll.expires_at) <= new Date()) || Boolean(poll.closed);
				if (isExpired) return badRequest('この投票は既に終了しています');

				const optionIds = Array.isArray(body.optionIds) ? body.optionIds.map(Number) : [];
				const otherText = body.otherText ? String(body.otherText).trim().slice(0, 200) : null;
				const now = new Date().toISOString();

				// 既存の投票を削除
				await db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?').bind(poll.id, userId).run();

				// 新規投票を挿入
				for (const optId of optionIds) {
					const voteId = Number(`${Date.now() % 1000000000}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`);
					await db.prepare(
						'INSERT INTO poll_votes (id, poll_id, user_id, option_id, other_text, created_at) VALUES (?, ?, ?, ?, ?, ?)'
					).bind(voteId, poll.id, userId, optId, optId === -1 ? otherText : null, now).run();
				}

				const { results: voteRows } = await db.prepare('SELECT * FROM poll_votes WHERE poll_id = ?').bind(poll.id).all();
				return json(formatD1PollRow(poll, voteRows || [], userId));
			}

			if (method === 'GET' && pathname === '/polls/expired-unnotified') {
				const now = new Date().toISOString();
				const { results } = await db.prepare('SELECT * FROM polls WHERE expires_at IS NOT NULL AND expires_at <= ? AND closed_notified = 0 LIMIT 50').bind(now).all();
				return json(results || []);
			}

			if (method === 'POST' && pathname.match(/^\/polls\/(\d+)\/mark-notified$/)) {
				const pollId = Number(pathname.split('/')[2]);
				await db.prepare('UPDATE polls SET closed_notified = 1 WHERE id = ?').bind(pollId).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname.match(/^\/polls\/(\d+)\/voters$/)) {
				const pollId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare(
					`SELECT pv.option_id, pv.created_at, pv.other_text, u.id as user_id, u.name, u.scid, u.icon_data
					 FROM poll_votes pv
					 JOIN users u ON u.id = pv.user_id
					 WHERE pv.poll_id = ?
					 ORDER BY pv.created_at DESC`
				).bind(pollId).all();
				return json(results || []);
			}

			// ==================== Post Activities ====================

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/reposts$/)) {
				const postId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const { results } = await db.prepare(
					`SELECT u.id, u.name, u.scid, u.icon_data, r.created_at
					 FROM reposts r
					 JOIN users u ON u.id = r.user_id
					 WHERE r.post_id = ?
					 ORDER BY r.created_at DESC LIMIT ?`
				).bind(postId, limit).all();
				return json(results || []);
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/quotes$/)) {
				const postId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const { results } = await db.prepare(
					`SELECT p.*
					 FROM posts p
					 WHERE p.repost_to = ? AND p.content != ''
					 ORDER BY p.created_at DESC LIMIT ?`
				).bind(postId, limit).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/likes$/)) {
				const postId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const { results } = await db.prepare(
					`SELECT u.id, u.name, u.scid, u.icon_data, l.created_at
					 FROM likes l
					 JOIN users u ON u.id = l.user_id
					 WHERE l.post_id = ?
					 ORDER BY l.created_at DESC LIMIT ?`
				).bind(postId, limit).all();
				return json(results || []);
			}

			return notFound(`Path ${method} ${pathname} not handled`);
		} catch (error) {
			return internalError(error);
		}
	},
};
