'use strict';

const crypto = require('crypto');

const SPACE_VISIBILITIES = new Set(['public', 'private', 'group']);
const SPACE_CHANNEL_KINDS = new Set(['text', 'voice']);
const SPACE_MEMBER_ROLES = new Set(['owner', 'member']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_CHANNEL_NAMES = Object.freeze([
  { name: '全体チャット', kind: 'text' },
  { name: 'ボイスチャンネル', kind: 'voice' },
]);

function newSpaceId() {
  return crypto.randomUUID();
}

function normalizeSpaceId(value) {
  const id = String(value || '').trim();
  return UUID_PATTERN.test(id) ? id.toLowerCase() : null;
}

function normalizeSpaceVisibility(value, fallback = 'public') {
  const visibility = String(value || '').trim().toLowerCase();
  if (!visibility) return fallback;
  return SPACE_VISIBILITIES.has(visibility) ? visibility : null;
}

function normalizeChannelKind(value, fallback = 'text') {
  const kind = String(value || '').trim().toLowerCase();
  if (!kind) return fallback;
  return SPACE_CHANNEL_KINDS.has(kind) ? kind : null;
}

function normalizeUserId(value) {
  const userId = Number(value);
  return Number.isInteger(userId) && userId >= 0 ? userId : null;
}

function normalizeLimit(value, fallback = 30, maximum = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), maximum));
}

function normalizeOffset(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizeMessageContent(value) {
  return String(value ?? '').trim();
}

function normalizeChannelName(value) {
  return String(value ?? '').trim();
}

function isSpaceOwner(space, userId) {
  const ownerId = Number(space?.ownerId ?? space?.owner_id);
  const targetId = normalizeUserId(userId);
  return ownerId !== null && ownerId === targetId;
}

function hasSpaceAccess(space, membership) {
  if (!space) return false;
  if (String(space.visibility || 'public') === 'public') return true;
  return Boolean(membership);
}

async function isActiveGroupMember(db, groupId, userId) {
  const id = String(groupId || '').trim();
  if (!id) return false;
  const membership = await db.getGroupMembership(id, userId);
  return membership?.status === 'active';
}

async function canAccessSpace(db, space, userId, membership) {
  if (!space) return false;
  if (hasSpaceAccess(space, membership)) return true;
  if (String(space.visibility || 'public') === 'group') {
    return isActiveGroupMember(db, space.groupId ?? space.group_id, userId);
  }
  return false;
}

async function requireSpaceAccess(db, space, userId) {
  if (!space) {
    const error = new Error('スペースが見つかりません。');
    error.statusCode = 404;
    throw error;
  }
  const membership = await db.getSpaceMember(space.id, userId);
  if (!await canAccessSpace(db, space, userId, membership)) {
    const error = new Error('このスペースにアクセスする権限がありません。');
    error.statusCode = 403;
    throw error;
  }
  return membership;
}

async function requireSpaceOwner(db, space, userId) {
  if (!space) {
    const error = new Error('スペースが見つかりません。');
    error.statusCode = 404;
    throw error;
  }
  if (!isSpaceOwner(space, userId)) {
    const error = new Error('スペースのオーナーではありません。');
    error.statusCode = 403;
    throw error;
  }
  return space;
}

async function requireSpaceMembership(db, space, userId) {
  const membership = await db.getSpaceMember(space?.id, userId);
  if (!membership) {
    const error = new Error('このスペースに参加している必要があります。');
    error.statusCode = 403;
    throw error;
  }
  return membership;
}

async function countSpacesByOwner(db, ownerId) {
  const normalizedOwnerId = normalizeUserId(ownerId);
  if (normalizedOwnerId === null) return 0;
  if (typeof db.countSpacesByOwner === 'function') {
    return Number(await db.countSpacesByOwner(normalizedOwnerId)) || 0;
  }
  const spaces = await db.listSpaces({ limit: 100, offset: 0, includePrivate: true, ownerId: normalizedOwnerId });
  return Array.isArray(spaces) ? spaces.length : 0;
}

/**
 * スペースを作成し、初期チャンネル（テキスト1・ボイス1）とオーナー参加をまとめて整える。
 */
async function createSpaceWithDefaults(db, { ownerId, name, description = '', visibility = 'public', groupId = null, iconData = null, headerImage = null }) {
  const normalizedOwnerId = normalizeUserId(ownerId);
  if (normalizedOwnerId === null) {
    const error = new Error('オーナーが正しくありません。');
    error.statusCode = 400;
    throw error;
  }
  const trimmedName = String(name || '').trim();
  if (!trimmedName || trimmedName.length > 50) {
    const error = new Error('スペース名の長さが正しくありません。');
    error.statusCode = 400;
    throw error;
  }
  const normalizedVisibility = normalizeSpaceVisibility(visibility);
  if (!normalizedVisibility) {
    const error = new Error('スペースの公開範囲が正しくありません。');
    error.statusCode = 400;
    throw error;
  }

  const spaceId = newSpaceId();
  const space = await db.createSpace({
    id: spaceId,
    ownerId: normalizedOwnerId,
    name: trimmedName,
    description: String(description || '').trim(),
    visibility: normalizedVisibility,
    groupId: normalizedVisibility === 'group' ? (groupId ? String(groupId) : null) : null,
    iconData: iconData || null,
    headerImage: headerImage || null,
  });

  for (const [index, channel] of DEFAULT_CHANNEL_NAMES.entries()) {
    await db.createSpaceChannel({
      id: newSpaceId(),
      spaceId,
      name: channel.name,
      kind: channel.kind,
      sortOrder: index,
    });
  }

  await db.createSpaceMember({ spaceId, userId: normalizedOwnerId, role: 'owner' });
  await db.updateSpaceMemberCount(spaceId);

  return db.getSpaceById(spaceId);
}

module.exports = {
  SPACE_VISIBILITIES,
  SPACE_CHANNEL_KINDS,
  SPACE_MEMBER_ROLES,
  UUID_PATTERN,
  DEFAULT_CHANNEL_NAMES,
  newSpaceId,
  normalizeSpaceId,
  normalizeSpaceVisibility,
  normalizeChannelKind,
  normalizeUserId,
  normalizeLimit,
  normalizeOffset,
  normalizeMessageContent,
  normalizeChannelName,
  isSpaceOwner,
  hasSpaceAccess,
  canAccessSpace,
  isActiveGroupMember,
  requireSpaceAccess,
  requireSpaceOwner,
  requireSpaceMembership,
  countSpacesByOwner,
  createSpaceWithDefaults,
};
