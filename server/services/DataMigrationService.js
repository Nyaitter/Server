'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const SNAPSHOT_VERSION = 1;
const TABLES = Object.freeze([
  'users',
  'user_auth_providers',
  'spaces',
  'space_channels',
  'space_members',
  'space_messages',
  'sessions',
  'trusted_login_ips',
  'login_approvals',
  'bot_tokens',
  'posts',
  'likes',
  'stars',
  'reposts',
  'pinned_posts',
  'follows',
  'dm_channels',
  'dm_messages',
  'group_dms',
  'groups',
  'group_roles',
  'group_memberships',
  'group_invites',
  'group_join_requests',
  'dm_e2e_keys',
  'notifications',
  'push_subscriptions',
  'moderation_reports',
  'logs',
  'user_keyword_affinities',
]);

const ADAPTER_NAMES = new Set(['memory', 'postgres', 'd1']);

function normalizeAdapterName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'inmemory') return 'memory';
  if (normalized === 'pg') return 'postgres';
  if (normalized === 'cloudflare-d1') return 'd1';
  if (!ADAPTER_NAMES.has(normalized)) {
    throw new Error(`Unsupported database adapter: ${value || '(empty)'}`);
  }
  return normalized;
}

function cloneJson(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function normalizeDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function normalizeBoolean(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return cloneJson(value);
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function normalizeInteger(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function normalizeEpochMilliseconds(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.trunc(numeric);
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRow(table, input) {
  const row = input && typeof input === 'object' ? input : {};
  const value = { ...row };

  for (const key of Object.keys(value)) {
    if (value[key] instanceof Date) {
      value[key] = isNaN(value[key].getTime()) ? null : value[key].toISOString();
    }
  }

  if (table === 'users') {
    return {
      id: normalizeInteger(value.id),
      scid: value.scid || null,
      name: String(value.name || value.scid || ''),
      handle: value.handle || null,
      nyaitter_address: value.nyaitter_address || null,
      auth_provider: value.auth_provider || 'local',
      provider_domain: value.provider_domain || null,
      external_id: value.external_id || null,
      external_profile: parseJson(value.external_profile, null),
      uuid: value.uuid || null,
      settings: parseJson(value.settings, {}),
      bio: String(value.bio ?? value.me ?? ''),
      header_image: value.header_image || null,
      icon_data: value.icon_data || null,
      verify: normalizeBoolean(value.verify),
      admin: normalizeBoolean(value.admin),
      freeze: value.freeze || null,
      shadow: normalizeBoolean(value.shadow),
      block: parseJson(value.block, []),
      account_operation: value.account_operation || null,
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'posts') {
    return {
      id: normalizeInteger(value.id),
      user_id: normalizeInteger(value.user_id ?? value.userId),
      content: String(value.content ?? ''),
      attachments: parseJson(value.attachments, []),
      mask: normalizeBoolean(value.mask),
      lock: normalizeBoolean(value.lock),
      announcement: normalizeBoolean(value.announcement),
      reply_to: normalizeInteger(value.reply_to ?? value.replyTo),
      repost_to: normalizeInteger(value.repost_to ?? value.repostTo),
      tags: parseJson(value.tags, []).map((tag) => String(tag || '').trim().toLocaleLowerCase('ja-JP')).filter((tag) => tag.length > 0 && tag.length <= 48).slice(0, 5),
      tags_generated_at: normalizeDate(value.tags_generated_at ?? value.tagsGeneratedAt),
      group_id: value.group_id ?? value.groupId ?? null,
      group_announcement: normalizeBoolean(value.group_announcement ?? value.groupAnnouncement),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'groups') {
    return {
      id: value.id == null ? null : String(value.id),
      owner_id: normalizeInteger(value.owner_id ?? value.ownerId),
      name: String(value.name || ''),
      description: String(value.description || ''),
      icon_data: value.icon_data ?? value.iconData ?? null,
      header_image: value.header_image ?? value.headerImage ?? null,
      visibility: ['open', 'private', 'invite', 'open_invite'].includes(String(value.visibility)) ? String(value.visibility) : 'open',
      deleted_at: normalizeDate(value.deleted_at ?? value.deletedAt),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      updated_at: normalizeDate(value.updated_at ?? value.updatedAt),
    };
  }

  if (table === 'group_roles') {
    return {
      id: value.id == null ? null : String(value.id),
      group_id: value.group_id ?? value.groupId ?? null,
      name: String(value.name || ''),
      permissions: parseJson(value.permissions, []).map((permission) => String(permission || '').trim()).filter(Boolean),
      is_system: normalizeBoolean(value.is_system ?? value.isSystem),
      sort_order: normalizeInteger(value.sort_order ?? value.sortOrder, 0),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      updated_at: normalizeDate(value.updated_at ?? value.updatedAt),
    };
  }

  if (table === 'group_memberships') {
    return {
      group_id: value.group_id ?? value.groupId ?? null,
      user_id: normalizeInteger(value.user_id ?? value.userId),
      role_id: value.role_id ?? value.roleId ?? null,
      status: ['active', 'pending', 'invited', 'banned'].includes(String(value.status)) ? String(value.status) : 'active',
      joined_at: normalizeDate(value.joined_at ?? value.joinedAt),
      updated_at: normalizeDate(value.updated_at ?? value.updatedAt),
    };
  }

  if (table === 'group_invites') {
    return {
      id: value.id == null ? null : String(value.id),
      group_id: value.group_id ?? value.groupId ?? null,
      inviter_id: normalizeInteger(value.inviter_id ?? value.inviterId),
      invitee_id: normalizeInteger(value.invitee_id ?? value.inviteeId),
      status: ['pending', 'accepted', 'declined', 'cancelled'].includes(String(value.status)) ? String(value.status) : 'pending',
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      responded_at: normalizeDate(value.responded_at ?? value.respondedAt),
    };
  }

  if (table === 'group_join_requests') {
    return {
      id: value.id == null ? null : String(value.id),
      group_id: value.group_id ?? value.groupId ?? null,
      user_id: normalizeInteger(value.user_id ?? value.userId),
      status: ['pending', 'approved', 'declined', 'cancelled'].includes(String(value.status)) ? String(value.status) : 'pending',
      reviewed_by: normalizeInteger(value.reviewed_by ?? value.reviewedBy),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      reviewed_at: normalizeDate(value.reviewed_at ?? value.reviewedAt),
    };
  }

  if (table === 'sessions') {
    return {
      session_id: value.session_id || value.id || null,
      token: value.token || null,
      user_id: normalizeInteger(value.user_id ?? value.userId),
      ip_hash: value.ip_hash ?? value.ipHash ?? null,
      ip_masked: value.ip_masked ?? value.ipMasked ?? null,
      user_agent: value.user_agent ?? value.userAgent ?? null,
      expires_at: normalizeDate(value.expires_at ?? value.expiresAt),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'trusted_login_ips') {
    return {
      user_id: normalizeInteger(value.user_id ?? value.userId),
      ip_hash: value.ip_hash ?? value.ipHash ?? null,
      ip_masked: value.ip_masked ?? value.ipMasked ?? null,
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      last_used_at: normalizeDate(value.last_used_at ?? value.lastUsedAt),
    };
  }

  if (table === 'login_approvals') {
    return {
      id: value.id || null,
      user_id: normalizeInteger(value.user_id ?? value.userId),
      ip_hash: value.ip_hash ?? value.ipHash ?? null,
      ip_masked: value.ip_masked ?? value.ipMasked ?? null,
      user_agent: value.user_agent ?? value.userAgent ?? null,
      poll_token_hash: value.poll_token_hash ?? value.pollTokenHash ?? null,
      status: value.status || 'pending',
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      expires_at: normalizeDate(value.expires_at ?? value.expiresAt),
      decided_at: normalizeDate(value.decided_at ?? value.decidedAt),
      consumed_at: normalizeDate(value.consumed_at ?? value.consumedAt),
    };
  }

  if (table === 'bot_tokens') {
    return {
      token_id: value.token_id ?? value.tokenId ?? null,
      token_hash: value.token_hash ?? value.tokenHash ?? null,
      user_id: normalizeInteger(value.user_id ?? value.userId),
      name: String(value.name || ''),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      last_used_at: normalizeDate(value.last_used_at ?? value.lastUsedAt),
    };
  }

  if (table === 'user_keyword_affinities') {
    return {
      user_id: normalizeInteger(value.user_id ?? value.userId),
      keyword: String(value.keyword || '').trim().toLocaleLowerCase('ja-JP').slice(0, 48),
      score: Math.max(0, Number(value.score) || 0),
      updated_at: normalizeDate(value.updated_at ?? value.updatedAt),
    };
  }

  if (['likes', 'stars', 'reposts', 'pinned_posts'].includes(table)) {
    return {
      user_id: normalizeInteger(value.user_id ?? value.userId),
      post_id: normalizeInteger(value.post_id ?? value.postId),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'follows') {
    return {
      follower_id: normalizeInteger(value.follower_id ?? value.followerId),
      following_id: normalizeInteger(value.following_id ?? value.followingId),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'dm_channels') {
    return {
      id: value.id || null,
      participants: parseJson(value.participants, []).map(Number).filter(Number.isSafeInteger),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'dm_messages') {
    return {
      id: normalizeInteger(value.id),
      channel_id: value.channel_id ?? value.channelId ?? null,
      sender_id: normalizeInteger(value.sender_id ?? value.senderId),
      content: String(value.content ?? ''),
      sent_at: normalizeDate(value.sent_at ?? value.sentAt),
      read_at: normalizeDate(value.read_at ?? value.readAt),
    };
  }

  if (table === 'group_dms') {
    return {
      id: value.id || null,
      host_id: normalizeInteger(value.host_id ?? value.hostId),
      title: String(value.title || ''),
      member: parseJson(value.member, []).map(Number).filter(Number.isSafeInteger),
      post: parseJson(value.post, []),
      unread: parseJson(value.unread, {}),
      time: normalizeDate(value.time),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'dm_e2e_keys') {
    return {
      user_id: normalizeInteger(value.user_id ?? value.userId),
      public_key: value.public_key ?? value.publicKey ?? null,
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      updated_at: normalizeDate(value.updated_at ?? value.updatedAt),
    };
  }

  if (table === 'notifications') {
    return {
      id: normalizeInteger(value.id),
      user_id: normalizeInteger(value.user_id ?? value.userId),
      type: value.type || null,
      from_user_id: normalizeInteger(value.from_user_id ?? value.fromUserId),
      post_id: normalizeInteger(value.post_id ?? value.postId),
      target: parseJson(value.target, null),
      message: value.message || null,
      read: normalizeBoolean(value.read),
      clicked: normalizeBoolean(value.clicked),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'push_subscriptions') {
    return {
      user_id: normalizeInteger(value.user_id ?? value.userId),
      endpoint: value.endpoint || null,
      expiration_time: normalizeEpochMilliseconds(value.expiration_time ?? value.expirationTime),
      p256dh: value.p256dh || null,
      auth: value.auth || null,
      session_token: value.session_token ?? value.sessionToken ?? null,
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      updated_at: normalizeDate(value.updated_at ?? value.updatedAt),
    };
  }

  if (table === 'moderation_reports') {
    return {
      id: normalizeInteger(value.id),
      reporter_user_id: normalizeInteger(value.reporter_user_id ?? value.reporterUserId),
      target_kind: value.target_kind ?? value.targetKind ?? null,
      target_id: String(value.target_id ?? value.targetId ?? ''),
      description: String(value.description || ''),
      target_snapshot: parseJson(value.target_snapshot ?? value.targetSnapshot, {}),
      assignment_type: value.assignment_type ?? value.assignmentType ?? 'report',
      status: value.status || 'pending',
      assigned_admin_id: normalizeInteger(value.assigned_admin_id ?? value.assignedAdminId),
      assigned_at: normalizeDate(value.assigned_at ?? value.assignedAt),
      excluded_admin_ids: parseJson(value.excluded_admin_ids ?? value.excludedAdminIds, []),
      resolution: parseJson(value.resolution, null),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      resolved_at: normalizeDate(value.resolved_at ?? value.resolvedAt),
      claimed_at: normalizeDate(value.claimed_at ?? value.claimedAt),
    };
  }

  if (table === 'user_auth_providers') {
    return {
      id: normalizeInteger(value.id),
      user_id: normalizeInteger(value.user_id ?? value.userId),
      provider: String(value.provider || '').toLowerCase(),
      provider_user_id: String(value.provider_user_id ?? value.providerUserId ?? ''),
      provider_profile: parseJson(value.provider_profile ?? value.providerProfile, {}),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'spaces') {
    return {
      stage_settings: value.stage_settings || null,
      id: String(value.id || ''),
      owner_id: normalizeInteger(value.owner_id ?? value.ownerId),
      name: String(value.name || ''),
      description: String(value.description || ''),
      icon_data: value.icon_data ?? value.iconData ?? null,
      header_image: value.header_image ?? value.headerImage ?? null,
      visibility: value.visibility || 'public',
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      updated_at: normalizeDate(value.updated_at ?? value.updatedAt),
    };
  }

  if (table === 'space_channels') {
    return {
      id: String(value.id || ''),
      space_id: String(value.space_id ?? value.spaceId ?? ''),
      name: String(value.name || ''),
      kind: value.kind || 'text',
      sort_order: normalizeInteger(value.sort_order ?? value.sortOrder, 0),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'space_members') {
    return {
      space_id: String(value.space_id ?? value.spaceId ?? ''),
      user_id: normalizeInteger(value.user_id ?? value.userId),
      role: value.role || 'member',
      joined_at: normalizeDate(value.joined_at ?? value.joinedAt),
    };
  }

  if (table === 'space_messages') {
    return {
      id: normalizeInteger(value.id),
      space_id: String(value.space_id ?? value.spaceId ?? ''),
      channel_id: String(value.channel_id ?? value.channelId ?? ''),
      user_id: normalizeInteger(value.user_id ?? value.userId),
      content: String(value.content || ''),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'logs') {
    return {
      id: normalizeInteger(value.id),
      scratch_id: value.scratch_id ?? value.scid ?? null,
      nyaitter_id: normalizeInteger(value.nyaitter_id ?? value.user_id),
      masked_ip_uuid: value.masked_ip_uuid ?? null,
      log_time: normalizeDate(value.log_time ?? value.logTime),
    };
  }

  return cloneJson(value);
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('Migration snapshot must be an object');
  }
  if (Number(snapshot.version) !== SNAPSHOT_VERSION) {
    throw new Error(`Unsupported migration snapshot version: ${snapshot.version}`);
  }
  const sourceTables = snapshot.tables && typeof snapshot.tables === 'object' ? snapshot.tables : {};
  const tables = {};
  for (const table of TABLES) {
    const rows = sourceTables[table] ?? [];
    if (!Array.isArray(rows)) throw new TypeError(`Migration snapshot table ${table} must be an array`);
    tables[table] = rows.map((row) => normalizeRow(table, row));
  }
  return {
    version: SNAPSHOT_VERSION,
    created_at: normalizeDate(snapshot.created_at) || new Date().toISOString(),
    source_adapter: snapshot.source_adapter || null,
    tables,
  };
}

function createSnapshot(sourceAdapter, rowsByTable) {
  const tables = {};
  for (const table of TABLES) {
    const rows = rowsByTable?.[table] ?? [];
    tables[table] = Array.isArray(rows) ? rows.map((row) => normalizeRow(table, row)) : [];
  }
  const snapshot = {
    version: SNAPSHOT_VERSION,
    created_at: new Date().toISOString(),
    source_adapter: normalizeAdapterName(sourceAdapter),
    tables,
  };
  return {
    ...snapshot,
    checksum: crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
  };
}

function verifySnapshotChecksum(snapshot) {
  if (!snapshot?.checksum) return normalizeSnapshot(snapshot);
  const { checksum, ...unsignedSnapshot } = snapshot;
  const expected = crypto.createHash('sha256').update(JSON.stringify(unsignedSnapshot)).digest('hex');
  if (checksum !== expected) throw new Error('Migration snapshot checksum does not match');
  return normalizeSnapshot(unsignedSnapshot);
}

function createAdapter(adapterName, prefix) {
  const type = normalizeAdapterName(adapterName);
  const variable = (name) => process.env[`${prefix}_${name}`] || '';

  if (type === 'memory') {
    const InMemoryAdapter = require('../adapters/database/InMemoryAdapter');
    return new InMemoryAdapter();
  }
  if (type === 'postgres') {
    const PostgresAdapter = require('../adapters/database/postgres/PostgresAdapter');
    return new PostgresAdapter({
      connectionString: variable('DATABASE_URL') || variable('POSTGRES_URL'),
      sslCa: variable('SSL_CA') || undefined,
      poolSize: Number(variable('POOL_SIZE')) || undefined,
      poolMin: Number(variable('POOL_MIN')) || undefined,
      transactionRetries: Number(variable('TRANSACTION_RETRIES')) || undefined,
      retryBaseDelayMs: Number(variable('RETRY_BASE_DELAY_MS')) || undefined,
    });
  }
  const D1Adapter = require('../adapters/database/d1/D1Adapter');
  return new D1Adapter({
    workerUrl: variable('D1_WORKER_URL'),
    authToken: variable('D1_WORKER_TOKEN'),
  });
}

async function writeSnapshot(filePath, snapshot) {
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  return target;
}

async function readSnapshot(filePath) {
  const content = await fs.readFile(path.resolve(filePath), 'utf8');
  return verifySnapshotChecksum(JSON.parse(content));
}

module.exports = {
  SNAPSHOT_VERSION,
  TABLES,
  normalizeAdapterName,
  normalizeSnapshot,
  createSnapshot,
  normalizeEpochMilliseconds,
  verifySnapshotChecksum,
  createAdapter,
  writeSnapshot,
  readSnapshot,
};
