'use strict';

const {
  TABLES,
  createSnapshot,
  normalizeSnapshot,
} = require('./DataMigrationService');

const TABLE_COLUMNS = Object.freeze({
  users: ['id', 'scid', 'name', 'handle', 'nyaitter_address', 'auth_provider', 'provider_domain', 'external_id', 'external_profile', 'uuid', 'settings', 'bio', 'header_image', 'icon_data', 'verify', 'freeze', 'admin', 'shadow', 'block', 'account_operation', 'created_at'],
  user_auth_providers: ['id', 'user_id', 'provider', 'provider_user_id', 'provider_profile', 'created_at'],
  spaces: ['stage_settings', 'id', 'owner_id', 'name', 'description', 'icon_data', 'header_image', 'visibility', 'created_at', 'updated_at'],
  space_channels: ['id', 'space_id', 'name', 'kind', 'sort_order', 'created_at'],
  space_members: ['space_id', 'user_id', 'role', 'joined_at'],
  space_messages: ['id', 'space_id', 'channel_id', 'user_id', 'content', 'created_at'],
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
  moderation_reports: ['id', 'reporter_user_id', 'target_kind', 'target_id', 'description', 'target_snapshot', 'assignment_type', 'status', 'assigned_admin_id', 'assigned_at', 'excluded_admin_ids', 'resolution', 'created_at', 'resolved_at', 'claimed_at'],
  logs: ['id', 'scratch_id', 'nyaitter_id', 'masked_ip_uuid', 'log_time'],
  groups: ['id', 'owner_id', 'name', 'description', 'icon_data', 'header_image', 'visibility', 'deleted_at', 'created_at', 'updated_at'],
  group_roles: ['id', 'group_id', 'name', 'permissions', 'is_system', 'sort_order', 'created_at', 'updated_at'],
  group_memberships: ['group_id', 'user_id', 'role_id', 'status', 'joined_at', 'updated_at'],
  group_invites: ['id', 'group_id', 'inviter_id', 'invitee_id', 'status', 'created_at', 'responded_at'],
  group_join_requests: ['id', 'group_id', 'user_id', 'status', 'reviewed_by', 'created_at', 'reviewed_at'],
  user_keyword_affinities: ['user_id', 'keyword', 'score', 'updated_at'],
});

const JSON_COLUMNS = new Set([
  'external_profile', 'settings', 'block', 'attachments', 'tags', 'post', 'unread', 'target',
  'target_snapshot', 'excluded_admin_ids', 'resolution', 'permissions', 'provider_profile',
]);
const ARRAY_COLUMNS = new Set(['participants', 'member']);
const DATE_COLUMNS = new Set([
  'created_at', 'updated_at', 'tags_generated_at', 'expires_at', 'last_used_at', 'decided_at', 'consumed_at',
  'sent_at', 'read_at', 'time', 'assigned_at', 'resolved_at', 'claimed_at', 'log_time', 'deleted_at', 'joined_at', 'responded_at', 'reviewed_at',
]);

const INSERT_ORDER = Object.freeze([
  'users',
  'user_auth_providers',
  'spaces',
  'space_channels',
  'space_members',
  'space_messages',
  'groups',
  'group_roles',
  'group_memberships',
  'group_invites',
  'group_join_requests',
  'posts',
  'dm_channels',
  'group_dms',
  'dm_e2e_keys',
  'sessions',
  'trusted_login_ips',
  'login_approvals',
  'bot_tokens',
  'follows',
  'likes',
  'stars',
  'reposts',
  'pinned_posts',
  'user_keyword_affinities',
  'dm_messages',
  'notifications',
  'push_subscriptions',
  'moderation_reports',
  'logs',
]);

const RESET_ORDER = Object.freeze([...INSERT_ORDER].reverse());
const ID_SEQUENCES = Object.freeze({
  user_auth_providers: 'user_auth_providers_id_seq',
  space_messages: 'space_messages_id_seq',
  posts: 'nyaitter_posts_id_seq',
  dm_messages: 'nyaitter_dm_messages_id_seq',
  notifications: 'nyaitter_notifications_id_seq',
  moderation_reports: 'nyaitter_moderation_reports_id_seq',
  logs: 'nyaitter_logs_id_seq',
});

function quoteIdentifier(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error(`Invalid migration identifier: ${identifier}`);
  return `"${identifier}"`;
}

function valueForColumn(column, value) {
  if (value == null) return null;
  if (JSON_COLUMNS.has(column)) return JSON.stringify(value);
  if (column === 'expiration_time') return new Date(Number(value));
  if (DATE_COLUMNS.has(column)) return value;
  if (ARRAY_COLUMNS.has(column)) return Array.isArray(value) ? value.map(Number) : [];
  return value;
}

function placeholderForColumn(column, index) {
  if (JSON_COLUMNS.has(column)) return `$${index}::jsonb`;
  return `$${index}`;
}

function isPostgresCompatibleSnapshotTable(table) {
  return TABLES.includes(table) && Object.prototype.hasOwnProperty.call(TABLE_COLUMNS, table);
}

async function exportPostgresSnapshot(pool, adapterName) {
  const rowsByTable = {};
  for (const table of TABLES) {
    if (!isPostgresCompatibleSnapshotTable(table)) continue;
    const { rows } = await pool.query(`SELECT * FROM ${quoteIdentifier(table)}`);
    rowsByTable[table] = rows;
  }
  return createSnapshot(adapterName, rowsByTable);
}

async function resetPostgresDestination(client) {
  // usersをCASCADE削除すると参照表も安全に空になる。明示的に空テーブルを残すため各表を削除する。
  for (const table of RESET_ORDER) {
    await client.query(`DELETE FROM ${quoteIdentifier(table)}`);
  }
}

async function insertRows(client, table, rows) {
  const columns = TABLE_COLUMNS[table];
  if (!columns || rows.length === 0) return;
  const quotedColumns = columns.map(quoteIdentifier).join(', ');
  const placeholders = columns.map((column, index) => placeholderForColumn(column, index + 1)).join(', ');
  const statement = `INSERT INTO ${quoteIdentifier(table)} (${quotedColumns}) VALUES (${placeholders})`;
  for (const row of rows) {
    const values = columns.map((column) => valueForColumn(column, row[column]));
    await client.query(statement, values);
  }
}

async function restorePostReferences(client, rows) {
  for (const row of rows) {
    if (row.reply_to == null && row.repost_to == null) continue;
    await client.query(
      'UPDATE posts SET reply_to = $1, repost_to = $2 WHERE id = $3',
      [row.reply_to, row.repost_to, row.id],
    );
  }
}

async function resetIdentitySequences(pool) {
  // 連番の再設定はデータ置換トランザクションを確定した後に行う。
  // 明示名のシーケンスはPostgreSQLでsetvalを利用できる。
  for (const [table, sequenceName] of Object.entries(ID_SEQUENCES)) {
    try {
      const { rows } = await pool.query(`SELECT COALESCE(MAX(id), 0) AS max_id FROM ${quoteIdentifier(table)}`);
      const maxId = Math.max(0, Number(rows[0]?.max_id || 0));
      await pool.query('SELECT setval($1, $2, $3)', [sequenceName, maxId || 1, maxId > 0]);
    } catch (error) {
      console.warn(`[data-migration] Could not reset sequence for ${table}: ${error.message}`);
    }
  }
}

async function importPostgresSnapshot(pool, snapshot, { replace = false } = {}) {
  if (replace !== true) {
    throw new Error('Destination replacement requires replace=true');
  }
  const normalized = normalizeSnapshot(snapshot);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await resetPostgresDestination(client);
    for (const table of INSERT_ORDER) {
      const rows = table === 'posts'
        ? (normalized.tables.posts || []).map((row) => ({ ...row, reply_to: null, repost_to: null }))
        : (normalized.tables[table] || []);
      await insertRows(client, table, rows);
    }
    await restorePostReferences(client, normalized.tables.posts || []);
    await client.query('COMMIT');
    await resetIdentitySequences(pool);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
  return Object.fromEntries(TABLES.map((table) => [table, normalized.tables[table].length]));
}

module.exports = {
  TABLE_COLUMNS,
  INSERT_ORDER,
  exportPostgresSnapshot,
  importPostgresSnapshot,
};
