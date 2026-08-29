'use strict';

const crypto = require('crypto');

const GROUP_VISIBILITIES = new Set(['open', 'private', 'invite', 'open_invite']);
const GROUP_PERMISSIONS = new Set(['invite', 'announce', 'delete', 'ban', 'post', 'profile', 'admin']);
const GROUP_MEMBERSHIP_STATUSES = new Set(['active', 'pending', 'invited', 'banned']);
const GROUP_INVITE_STATUSES = new Set(['pending', 'accepted', 'declined', 'cancelled']);
const GROUP_JOIN_REQUEST_STATUSES = new Set(['pending', 'approved', 'declined', 'cancelled']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OWNER_PERMISSIONS = Object.freeze([...GROUP_PERMISSIONS]);
const ADMIN_PERMISSIONS = Object.freeze([...GROUP_PERMISSIONS]);
const MEMBER_PERMISSIONS = Object.freeze(['post']);
const DEFAULT_SYSTEM_ROLE_SORT_ORDERS = Object.freeze({ owner: 0, admin: 1, member: 2 });

function normalizeGroupId(value) {
  const id = String(value || '').trim();
  return UUID_PATTERN.test(id) ? id.toLowerCase() : null;
}

function normalizeVisibility(value, fallback = null) {
  const visibility = String(value || '').trim().toLowerCase();
  if (!visibility) return fallback;
  return GROUP_VISIBILITIES.has(visibility) ? visibility : null;
}

function normalizePermissionList(value) {
  if (!Array.isArray(value)) return null;
  const permissions = [...new Set(value.map((permission) => String(permission || '').trim()).filter(Boolean))];
  return permissions.every((permission) => GROUP_PERMISSIONS.has(permission)) ? permissions : null;
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

function normalizePostId(value) {
  const postId = Number(value);
  return Number.isInteger(postId) && postId > 0 ? postId : null;
}

function hasPermission(group, membership, role, permission) {
  if (!group || !membership || membership.status !== 'active') return false;
  if (Number(group.ownerId ?? group.owner_id) === Number(membership.userId ?? membership.user_id)) return true;
  const permissions = Array.isArray(role?.permissions) ? role.permissions : [];
  return permissions.includes('admin') || permissions.includes(permission);
}

async function resolveGroupMembership(db, group, userId) {
  if (!group || userId == null) return { membership: null, role: null, roles: [] };
  const [membership, roles] = await Promise.all([
    db.getGroupMembership(group.id, userId),
    db.getGroupRoles(group.id),
  ]);
  const roleId = membership?.roleId ?? membership?.role_id ?? null;
  const role = roles.find((candidate) => String(candidate.id) === String(roleId)) || null;
  return { membership, role, roles };
}

async function requireGroupPermission(db, group, userId, permission) {
  const membershipState = await resolveGroupMembership(db, group, userId);
  if (!hasPermission(group, membershipState.membership, membershipState.role, permission)) {
    const error = new Error('グループ操作の権限がありません。');
    error.statusCode = 403;
    throw error;
  }
  return membershipState;
}

async function requireActiveMembership(db, group, userId) {
  const membershipState = await resolveGroupMembership(db, group, userId);
  if (!membershipState.membership || membershipState.membership.status !== 'active') {
    const error = new Error('このグループに参加している必要があります。');
    error.statusCode = 403;
    throw error;
  }
  return membershipState;
}

async function listActiveGroupMemberIds(db, groupId) {
  const ids = [];
  const pageSize = 200;
  for (let offset = 0; ; offset += pageSize) {
    const page = await db.getGroupMemberships(groupId, { status: 'active', limit: pageSize, offset });
    ids.push(...page.map((membership) => Number(membership.userId ?? membership.user_id)).filter(Number.isInteger));
    if (page.length < pageSize) break;
  }
  return [...new Set(ids)];
}

async function countCreatedGroups(db, userId) {
  if (typeof db.getGroupsByOwner === 'function') {
    const groups = await db.getGroupsByOwner(userId, { limit: 100000 });
    return groups.length;
  }
  const groups = await db.getUserGroups(userId, { status: 'active', limit: 200, offset: 0 });
  return groups.filter((group) => Number(group.ownerId ?? group.owner_id) === Number(userId)).length;
}

async function createGroupWithDefaultRoles(db, {
  ownerId,
  name,
  description = '',
  iconData = null,
  headerImage = null,
  visibility = 'open',
}) {
  const groupId = crypto.randomUUID();
  const roles = {
    owner: crypto.randomUUID(),
    admin: crypto.randomUUID(),
    member: crypto.randomUUID(),
  };
  const group = await db.createGroup({
    id: groupId,
    ownerId,
    name,
    description,
    iconData,
    headerImage,
    visibility,
  });
  try {
    await db.createGroupRole({
      id: roles.owner,
      groupId,
      name: 'owner',
      permissions: OWNER_PERMISSIONS,
      isSystem: true,
      sortOrder: 0,
    });
    await db.createGroupRole({
      id: roles.admin,
      groupId,
      name: 'admin',
      permissions: ADMIN_PERMISSIONS,
      isSystem: true,
      sortOrder: 1,
    });
    await db.createGroupRole({
      id: roles.member,
      groupId,
      name: 'member',
      permissions: MEMBER_PERMISSIONS,
      isSystem: true,
      sortOrder: 2,
    });
    await db.createGroupMembership({
      groupId,
      userId: ownerId,
      roleId: roles.owner,
      status: 'active',
      joinedAt: new Date().toISOString(),
    });
    return group;
  } catch (error) {
    await db.deleteGroup(groupId).catch(() => {});
    throw error;
  }
}

function getDefaultSystemRole(roles, roleType) {
  const expectedSortOrder = DEFAULT_SYSTEM_ROLE_SORT_ORDERS[roleType];
  if (expectedSortOrder === undefined) return null;
  const systemRoles = (roles || []).filter((role) => Boolean(role?.isSystem ?? role?.is_system));
  return systemRoles.find((role) => Number(role.sortOrder ?? role.sort_order) === expectedSortOrder)
    || systemRoles.find((role) => role.name === roleType)
    || null;
}

function isDefaultOwnerRole(role) {
  if (!Boolean(role?.isSystem ?? role?.is_system)) return false;
  return Number(role.sortOrder ?? role.sort_order) === DEFAULT_SYSTEM_ROLE_SORT_ORDERS.owner
    || role.name === 'owner';
}

function getDefaultMemberRole(roles) {
  return getDefaultSystemRole(roles, 'member');
}

function isOwner(group, userId) {
  return Number(group?.ownerId ?? group?.owner_id) === Number(userId);
}

function isAdmin(group, membership, role) {
  return isOwner(group, membership?.userId ?? membership?.user_id)
    || (membership?.status === 'active' && Array.isArray(role?.permissions) && role.permissions.includes('admin'));
}

module.exports = {
  GROUP_VISIBILITIES,
  GROUP_PERMISSIONS,
  GROUP_MEMBERSHIP_STATUSES,
  GROUP_INVITE_STATUSES,
  GROUP_JOIN_REQUEST_STATUSES,
  OWNER_PERMISSIONS,
  ADMIN_PERMISSIONS,
  MEMBER_PERMISSIONS,
  DEFAULT_SYSTEM_ROLE_SORT_ORDERS,
  normalizeGroupId,
  normalizeVisibility,
  normalizePermissionList,
  normalizeUserId,
  normalizeLimit,
  normalizeOffset,
  normalizePostId,
  hasPermission,
  isOwner,
  isAdmin,
  resolveGroupMembership,
  requireGroupPermission,
  requireActiveMembership,
  listActiveGroupMemberIds,
  countCreatedGroups,
  createGroupWithDefaultRoles,
  getDefaultSystemRole,
  isDefaultOwnerRole,
  getDefaultMemberRole,
};
