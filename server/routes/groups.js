'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { serializePostsByIds, serializeNotification, invalidateUserBriefCache } = require('../utils/serialize');
const { getPublicUrl } = require('../utils/nyaitterAddress');
const { createNotificationIfAllowed } = require('../services/NotificationDeliveryService');
const { resolvePostingUser } = require('../services/auth/PostAsUserService');
const {
  GROUP_VISIBILITIES,
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
  countCreatedGroups,
  createGroupWithDefaultRoles,
  getDefaultMemberRole,
  getDefaultSystemRole,
  isDefaultOwnerRole,
} = require('../services/GroupService');

const api = require('../utils/ApiRegistry');

const router = api.createRouter({
  tag: 'groups',
  basePath: '/groups',
  description: 'グループ・コミュニティ API',
});

function getDb(req) {
  return req.app.locals.dbAdapter;
}

function errorResponse(res, error, contextMessage = 'server error') {
  console.error(`[groups] ${contextMessage}:`, error);
  const status = error.statusCode || error.status || (error.message?.includes('見つかりません') ? 404 : 500);
  return res.status(status).json({
    error: error.message || '内部エラーが発生しました。',
  });
}

function groupPayload(group, { roles = null, membership = null, owner = null } = {}) {
  return {
    id: String(group.id),
    owner_id: Number(group.ownerId ?? group.owner_id),
    name: group.name || '',
    description: group.description || '',
    icon_data: group.iconData ?? group.icon_data ?? null,
    header_image: group.headerImage ?? group.header_image ?? null,
    visibility: group.visibility || 'open',
    member_count: Math.max(0, Number(group.memberCount ?? group.member_count) || 0),
    created_at: group.createdAt ?? group.created_at ?? null,
    updated_at: group.updatedAt ?? group.updated_at ?? null,
    ...(owner ? { owner } : {}),
    ...(membership ? { membership } : {}),
    ...(roles ? { roles } : {}),
  };
}

function rolePayload(role) {
  return {
    id: String(role.id),
    group_id: String(role.groupId ?? role.group_id),
    name: role.name || '',
    permissions: Array.isArray(role.permissions) ? role.permissions : [],
    is_system: Boolean(role.isSystem ?? role.is_system),
    sort_order: Number(role.sortOrder ?? role.sort_order) || 0,
  };
}

function membershipPayload(membership) {
  if (!membership) return null;
  return {
    group_id: String(membership.groupId ?? membership.group_id),
    user_id: Number(membership.userId ?? membership.user_id),
    role_id: membership.roleId ?? membership.role_id ?? null,
    status: membership.status || 'active',
    joined_at: membership.joinedAt ?? membership.joined_at ?? null,
  };
}

async function getGroupOr404(req, res) {
  const groupId = normalizeGroupId(req.params.groupId);
  if (!groupId) {
    res.status(400).json({ error: 'グループIDが正しくありません。' });
    return null;
  }
  const group = await getDb(req).getGroupById(groupId);
  if (!group) {
    res.status(404).json({ error: 'グループが見つかりません。' });
    return null;
  }
  return group;
}

async function publishNotification(req, userId, notification) {
  if (!notification) return;
  const structured = await serializeNotification(getDb(req), notification, getPublicUrl(req));
  if (!structured) return;
  try {
    await req.app.locals.realtime?.publishNewNotification?.(userId, structured, getDb(req));
  } catch (error) {
    console.warn('[groups] realtime notification delivery failed:', error.message);
  }
  if (req.app.locals.pushNotificationService?.enabled) {
    void req.app.locals.pushNotificationService.sendNotificationToUser(userId, structured, {
      publicUrl: getPublicUrl(req),
    }).catch((error) => console.warn('[groups] push notification delivery failed:', error.message));
  }
}

async function listGroupInvitePermissionUserIds(db, group) {
  const roles = await db.getGroupRoles(group.id);
  const rolesById = new Map(roles.map((role) => [String(role.id), role]));
  const userIds = [];
  const pageSize = 200;
  for (let offset = 0; ; offset += pageSize) {
    const memberships = await db.getGroupMemberships(group.id, { status: 'active', limit: pageSize, offset });
    for (const membership of memberships) {
      const userId = Number(membership.userId ?? membership.user_id);
      const roleId = membership.roleId ?? membership.role_id ?? null;
      const role = rolesById.get(String(roleId)) || null;
      if (Number.isInteger(userId) && hasPermission(group, membership, role, 'invite')) userIds.push(userId);
    }
    if (memberships.length < pageSize) break;
  }
  return [...new Set(userIds)];
}

async function cancelPendingGroupJoinRequests(db, groupId, userId) {
  const requests = await db.getGroupJoinRequests({ groupId, userId, status: 'pending', limit: 100 });
  await Promise.all(requests.map((request) => db.updateGroupJoinRequest(request.id, { status: 'cancelled' })));
}

async function getDefaultMemberRoleOrThrow(db, groupId) {
  const roles = await db.getGroupRoles(groupId);
  const memberRole = getDefaultMemberRole(roles);
  if (!memberRole) throw new Error('グループの標準ロールが見つかりません。');
  return memberRole;
}

async function assertMembershipCapacity(req, group, userId) {
  const groupMaximum = Number(config.limits.groupMaxMembersPerGroup) || 0;
  if (groupMaximum > 0 && Number(group.memberCount ?? group.member_count) >= groupMaximum) {
    const error = new Error('このグループは参加者数の上限に達しています。');
    error.statusCode = 409;
    throw error;
  }
  const userMaximum = Number(config.limits.groupMaxMembershipsPerUser) || 0;
  if (userMaximum > 0) {
    const groups = await getDb(req).getUserGroups(userId, { status: 'active', limit: userMaximum + 1 });
    if (groups.length >= userMaximum) {
      const error = new Error('参加グループ数の上限に達しています。');
      error.statusCode = 409;
      throw error;
    }
  }
}

router.get({
  path: '/',
  summary: 'グループ一覧の検索・取得',
  auth: 'optional',
}, optionalAuth, async (req, res) => {
  const db = getDb(req);
  const limit = normalizeLimit(req.query?.limit, 20);
  const offset = normalizeOffset(req.query?.offset, 0);
  const query = typeof req.query?.query === 'string' ? req.query.query.trim() : '';

  try {
    const groups = await db.getGroupsByVisibility({ query, visibility: ['open', 'open_invite'], limit, offset });
    res.json({
      groups: groups.map((g) => groupPayload(g)),
      limit,
      offset,
    });
  } catch (error) {
    console.error('[groups] list error:', error);
    res.status(500).json({ error: 'グループ一覧の取得に失敗しました。' });
  }
});

router.post({
  path: '/',
  summary: '新規グループの作成',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const db = getDb(req);
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();
  const visibility = normalizeVisibility(req.body?.visibility);
  const category = String(req.body?.category || '').trim() || null;

  if (!name || name.length > config.limits.userNameLength.max) {
    return res.status(400).json({ error: 'グループ名の長さが正しくありません。' });
  }

  try {
    const createdCount = await countCreatedGroups(db, req.user.id);
    if (createdCount >= config.limits.groupsPerUser) {
      return res.status(409).json({ error: `グループは最大${config.limits.groupsPerUser}件まで作成できます。` });
    }

    const group = await createGroupWithDefaultRoles(db, {
      name,
      description,
      visibility,
      category,
      ownerId: req.user.id,
    });
    invalidateUserBriefCache(req.user.id);

    res.status(201).json({ group: groupPayload(group) });
  } catch (error) {
    console.error('[groups] create error:', error);
    res.status(500).json({ error: 'グループの作成に失敗しました。' });
  }
});

router.get({
  path: '/mine',
  summary: '所属グループ一覧の取得',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const db = getDb(req);
  const limit = normalizeLimit(req.query?.limit, 50);
  const offset = normalizeOffset(req.query?.offset, 0);

  try {
    const groups = await db.getUserGroups(req.user.id, { status: 'active', limit, offset });
    res.json({
      groups: groups.map((g) => groupPayload(g)),
      limit,
      offset,
    });
  } catch (error) {
    console.error('[groups] mine error:', error);
    res.status(500).json({ error: '参加グループ一覧の取得に失敗しました。' });
  }
});

router.get({
  path: '/invites/mine',
  summary: '自分宛てのグループ招待状一覧取得',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const db = getDb(req);
  try {
    const rawInvites = await db.getGroupInvites({ inviteeId: req.user.id, status: 'pending' });
    const invites = await Promise.all(
      rawInvites.map(async (inv) => {
        const group = await db.getGroupById(inv.groupId ?? inv.group_id);
        const inviter = await db.getUserById(inv.inviterId ?? inv.inviter_id);
        return {
          ...inv,
          group: group ? groupPayload(group) : null,
          inviter: inviter ? { id: inviter.id, name: inviter.name, scid: inviter.scid, icon: inviter.icon } : null,
        };
      })
    );
    res.json({ invites });
  } catch (error) {
    console.error('[groups] user invites error:', error);
    res.status(500).json({ error: 'グループ招待の取得に失敗しました。' });
  }
});

router.post({
  path: '/invites/:inviteId/respond',
  summary: 'グループ招待への応答',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const db = getDb(req);
  const inviteId = String(req.params.inviteId || '').trim();
  const accept = Boolean(req.body?.accept);

  try {
    const result = await db.respondToGroupInvite(inviteId, req.user.id, accept);
    res.json({ success: true, result });
  } catch (error) {
    console.error('[groups] respond invite error:', error);
    res.status(500).json({ error: error.message || '招待への応答に失敗しました。' });
  }
});

router.get({
  path: '/:groupId',
  summary: 'グループ詳細情報の取得',
  auth: 'optional',
}, optionalAuth, async (req, res) => {
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    const db = getDb(req);
    const owner = await db.getUserById(group.ownerId ?? group.owner_id);
    let membershipState = { membership: null, roles: [] };
    let pendingJoinRequest = null;
    if (req.user) {
      const postingUser = await resolvePostingUser(req, db, req.query.post_as_user_id);
      [membershipState, pendingJoinRequest] = await Promise.all([
        resolveGroupMembership(db, group, postingUser.id),
        db.getGroupJoinRequests({ groupId: group.id, userId: postingUser.id, status: 'pending', limit: 1 })
          .then((requests) => requests[0] || null),
      ]);
    }
    res.json({
      group: groupPayload(group, {
        owner: owner ? { id: owner.id, name: owner.name || '', nyaitter_id: owner.handle || null, icon_data: owner.icon_data || null } : null,
        membership: membershipPayload(membershipState.membership),
        roles: membershipState.membership?.status === 'active' ? membershipState.roles.map(rolePayload) : undefined,
      }),
      join_request: pendingJoinRequest,
    });
  } catch (error) {
    errorResponse(res, error, 'detail error');
  }
});

router.patch({
  path: '/:groupId',
  summary: 'グループ基本情報の更新',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    await requireGroupPermission(getDb(req), group, req.user.id, 'profile');
    const fields = {};
    if (req.body?.name !== undefined) fields.name = String(req.body.name).trim();
    if (req.body?.description !== undefined) fields.description = String(req.body.description);
    if (req.body?.icon_data !== undefined) fields.iconData = req.body.icon_data;
    if (req.body?.header_image !== undefined) fields.headerImage = req.body.header_image;
    if (req.body?.visibility !== undefined) fields.visibility = normalizeVisibility(req.body.visibility);
    if ((fields.name !== undefined && (!fields.name || fields.name.length > 100)) || (fields.description !== undefined && fields.description.length > 2000) || fields.visibility === null) {
      return res.status(400).json({ error: '更新内容が正しくありません。' });
    }
    const updated = await getDb(req).updateGroup(group.id, fields);
    invalidateUserBriefCache(req.user.id);
    res.json({ group: groupPayload(updated) });
  } catch (error) {
    errorResponse(res, error, 'update error');
  }
});

router.post({
  path: '/:groupId/transfer-owner',
  summary: 'グループオーナー権限の譲渡',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const newOwnerId = normalizeUserId(req.body?.user_id);
  if (newOwnerId == null) return res.status(400).json({ error: '新しいオーナーのユーザーIDが正しくありません。' });
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    if (!isOwner(group, req.user.id)) return res.status(403).json({ error: 'オーナー権限を移譲できるのは現在のオーナーのみです。' });
    if (newOwnerId === Number(req.user.id)) return res.status(400).json({ error: '自分自身へオーナー権限を移譲することはできません。' });
    const db = getDb(req);
    const newOwnerMembership = await db.getGroupMembership(group.id, newOwnerId);
    if (!newOwnerMembership || newOwnerMembership.status !== 'active') return res.status(409).json({ error: '新しいオーナーは参加中のメンバーである必要があります。' });
    const roles = await db.getGroupRoles(group.id);
    const ownerRole = getDefaultSystemRole(roles, 'owner');
    const adminRole = getDefaultSystemRole(roles, 'admin');
    if (!ownerRole || !adminRole) throw new Error('グループのシステムロールが見つかりません。');
    const changed = await db.transferGroupOwnership(group.id, newOwnerId);
    if (!changed) return res.status(404).json({ error: 'グループが見つかりません。' });
    await db.updateGroupMembership(group.id, newOwnerId, { roleId: ownerRole.id });
    await db.updateGroupMembership(group.id, req.user.id, { roleId: adminRole.id });
    invalidateUserBriefCache(req.user.id);
    invalidateUserBriefCache(newOwnerId);
    res.json({ group: groupPayload(changed) });
  } catch (error) {
    errorResponse(res, error, 'transfer owner error');
  }
});

router.delete({
  path: '/:groupId',
  summary: 'グループの削除',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    if (!isOwner(group, req.user.id)) return res.status(403).json({ error: 'グループを削除できるのはオーナーのみです。' });
    const deleted = await getDb(req).deleteGroup(group.id);
    invalidateUserBriefCache(req.user.id);
    res.json({ success: Boolean(deleted) });
  } catch (error) {
    errorResponse(res, error, 'delete error');
  }
});

router.post({
  path: '/:groupId/join',
  summary: 'グループへの参加・参加申請',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    const db = getDb(req);
    const existing = await db.getGroupMembership(group.id, req.user.id);
    if (existing?.status === 'banned') return res.status(403).json({ error: 'このグループへの参加は禁止されています。' });
    if (existing?.status === 'active') return res.json({ membership: membershipPayload(existing), joined: true });
    if (group.visibility === 'invite' || group.visibility === 'open_invite') {
      const requests = await db.getGroupJoinRequests({ groupId: group.id, userId: req.user.id, status: 'pending', limit: 1 });
      if (requests.length > 0) return res.status(409).json({ error: '参加申請はすでに送信されています。' });
      const request = await db.createGroupJoinRequest({ id: crypto.randomUUID(), groupId: group.id, userId: req.user.id, status: 'pending' });
      const recipientIds = (await listGroupInvitePermissionUserIds(db, group))
        .filter((userId) => userId !== Number(req.user.id));
      await Promise.all(recipientIds.map(async (userId) => {
        try {
          const notification = await createNotificationIfAllowed(db, {
            userId,
            type: 'group_join_request',
            fromUserId: req.user.id,
            target: { kind: 'route', value: `#group/${group.id}/manage` },
            message: `「${group.name}」への参加申請が届いています。`,
          });
          await publishNotification(req, userId, notification);
        } catch (error) {
          console.warn('[groups] join request notification delivery failed:', error.message);
        }
      }));
      return res.status(202).json({ join_request: request, pending: true });
    }
    await assertMembershipCapacity(req, group, req.user.id);
    const memberRole = await getDefaultMemberRoleOrThrow(db, group.id);
    const membership = await db.createGroupMembership({ groupId: group.id, userId: req.user.id, roleId: memberRole.id, status: 'active', joinedAt: new Date().toISOString() });
    await cancelPendingGroupJoinRequests(db, group.id, req.user.id);
    invalidateUserBriefCache(req.user.id);
    res.status(201).json({ membership: membershipPayload(membership), joined: true });
  } catch (error) {
    errorResponse(res, error, 'join error');
  }
});

router.post({
  path: '/:groupId/leave',
  summary: 'グループからの脱退',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    if (isOwner(group, req.user.id)) return res.status(409).json({ error: 'オーナーはオーナー権限を移譲してから退出してください。' });
    const membership = await getDb(req).getGroupMembership(group.id, req.user.id);
    if (!membership || membership.status !== 'active') return res.status(404).json({ error: '参加状態が見つかりません。' });
    const updated = await getDb(req).updateGroupMembership(group.id, req.user.id, { status: 'pending', roleId: null, joinedAt: null });
    invalidateUserBriefCache(req.user.id);
    res.json({ success: true, membership: membershipPayload(updated) });
  } catch (error) {
    errorResponse(res, error, 'leave error');
  }
});

router.post({
  path: '/:groupId/invites',
  summary: 'グループへの招待状作成',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const inviteeId = normalizeUserId(req.body?.user_id);
  if (inviteeId == null) return res.status(400).json({ error: '招待するユーザーIDが正しくありません。' });
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    const db = getDb(req);
    await requireGroupPermission(db, group, req.user.id, 'invite');
    if (inviteeId === Number(req.user.id)) return res.status(400).json({ error: '自分自身を招待することはできません。' });
    if (!await db.getUserById(inviteeId)) return res.status(404).json({ error: 'ユーザーが見つかりません。' });
    const membership = await db.getGroupMembership(group.id, inviteeId);
    if (membership?.status === 'banned') return res.status(403).json({ error: 'このユーザーはグループへの参加を禁止されています。' });
    if (membership?.status === 'active') return res.status(409).json({ error: 'このユーザーはすでに参加しています。' });
    const existing = await db.getGroupInvites({ groupId: group.id, inviteeId, status: 'pending', limit: 1 });
    if (existing.length > 0) return res.status(409).json({ error: '保留中の招待がすでにあります。' });
    const invite = await db.createGroupInvite({ id: crypto.randomUUID(), groupId: group.id, inviterId: req.user.id, inviteeId, status: 'pending' });
    try {
      const notification = await createNotificationIfAllowed(db, {
        userId: inviteeId,
        type: 'group_invite',
        fromUserId: req.user.id,
        target: { kind: 'route', value: '#groups' },
        message: `「${group.name}」へのグループ招待が届いています。`,
      });
      await publishNotification(req, inviteeId, notification);
    } catch (error) {
      console.warn('[groups] invite notification delivery failed:', error.message);
    }
    res.status(201).json({ invite });
  } catch (error) {
    errorResponse(res, error, 'invite create error');
  }
});

router.get({
  path: '/:groupId/join-requests',
  summary: 'グループ参加申請一覧の取得',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    await requireGroupPermission(getDb(req), group, req.user.id, 'invite');
    const requests = await getDb(req).getGroupJoinRequests({ groupId: group.id, status: String(req.query.status || 'pending'), limit: 100 });
    res.json({ join_requests: requests });
  } catch (error) {
    errorResponse(res, error, 'join request list error');
  }
});

router.post({
  path: '/:groupId/join-requests/:requestId/respond',
  summary: 'グループ参加申請への応答',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const decision = String(req.body?.decision || '').toLowerCase();
  if (!['approve', 'decline'].includes(decision)) return res.status(400).json({ error: '参加申請への応答が正しくありません。' });
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    const db = getDb(req);
    await requireGroupPermission(db, group, req.user.id, 'invite');
    const request = await db.getGroupJoinRequest(req.params.requestId);
    if (!request || String(request.groupId ?? request.group_id) !== group.id || request.status !== 'pending') return res.status(404).json({ error: '保留中の参加申請が見つかりません。' });
    if (decision === 'approve') {
      const applicantId = Number(request.userId ?? request.user_id);
      const existingMembership = await db.getGroupMembership(group.id, applicantId);
      if (existingMembership?.status === 'banned') {
        return res.status(403).json({ error: 'このユーザーはグループへの参加を禁止されています。' });
      }
      if (existingMembership?.status !== 'active') {
        await assertMembershipCapacity(req, group, applicantId);
        const memberRole = await getDefaultMemberRoleOrThrow(db, group.id);
        await db.createGroupMembership({ groupId: group.id, userId: applicantId, roleId: memberRole.id, status: 'active', joinedAt: new Date().toISOString() });
      }
      invalidateUserBriefCache(applicantId);
    }
    const updated = await db.updateGroupJoinRequest(request.id, { status: decision === 'approve' ? 'approved' : 'declined', reviewedBy: req.user.id });
    res.json({ join_request: updated });
  } catch (error) {
    errorResponse(res, error, 'join request response error');
  }
});

router.get({
  path: '/:groupId/roles',
  summary: 'グループロール一覧の取得',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    await requireActiveMembership(getDb(req), group, req.user.id);
    res.json({ roles: (await getDb(req).getGroupRoles(group.id)).map(rolePayload) });
  } catch (error) {
    errorResponse(res, error, 'role list error');
  }
});

router.post({
  path: '/:groupId/roles',
  summary: 'グループロールの新規作成',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const permissions = normalizePermissionList(req.body?.permissions);
  if (!name || name.length > 50 || !permissions) return res.status(400).json({ error: 'ロール名または権限が正しくありません。' });
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    const state = await requireActiveMembership(getDb(req), group, req.user.id);
    if (!isAdmin(group, state.membership, state.role)) return res.status(403).json({ error: 'ロールを管理する権限がありません。' });
    const roles = await getDb(req).getGroupRoles(group.id);
    if (roles.some((role) => role.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: '同名のロールがすでにあります。' });
    const role = await getDb(req).createGroupRole({ id: crypto.randomUUID(), groupId: group.id, name, permissions, isSystem: false, sortOrder: Number(req.body?.sort_order) || roles.length + 10 });
    res.status(201).json({ role: rolePayload(role) });
  } catch (error) {
    errorResponse(res, error, 'role create error');
  }
});

router.patch({
  path: '/:groupId/roles/:roleId',
  summary: 'グループロールの更新',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    const db = getDb(req);
    const state = await requireActiveMembership(db, group, req.user.id);
    if (!isAdmin(group, state.membership, state.role)) return res.status(403).json({ error: 'ロールを管理する権限がありません。' });
    const role = (await db.getGroupRoles(group.id)).find((candidate) => String(candidate.id) === String(req.params.roleId));
    if (!role) return res.status(404).json({ error: 'ロールが見つかりません。' });
    if (isDefaultOwnerRole(role)) return res.status(403).json({ error: 'オーナーロールは変更できません。' });
    if (req.body?.sort_order !== undefined && Boolean(role.isSystem ?? role.is_system)) {
      return res.status(403).json({ error: '既定ロールの並び順は変更できません。' });
    }
    const fields = {};
    if (req.body?.name !== undefined) fields.name = String(req.body.name).trim();
    if (req.body?.permissions !== undefined) fields.permissions = normalizePermissionList(req.body.permissions);
    if (req.body?.sort_order !== undefined) fields.sortOrder = Number(req.body.sort_order) || 0;
    if (!fields.name && fields.name !== undefined || fields.permissions === null) return res.status(400).json({ error: 'ロール更新内容が正しくありません。' });
    const updated = await db.updateGroupRole(role.id, fields);
    res.json({ role: rolePayload(updated) });
  } catch (error) {
    errorResponse(res, error, 'role update error');
  }
});

router.delete({
  path: '/:groupId/roles/:roleId',
  summary: 'グループロールの削除',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    const db = getDb(req);
    const state = await requireActiveMembership(db, group, req.user.id);
    if (!isAdmin(group, state.membership, state.role)) return res.status(403).json({ error: 'ロールを管理する権限がありません。' });
    const role = (await db.getGroupRoles(group.id)).find((candidate) => String(candidate.id) === String(req.params.roleId));
    if (!role) return res.status(404).json({ error: 'ロールが見つかりません。' });
    if (role.isSystem ?? role.is_system) return res.status(403).json({ error: 'システムロールは削除できません。' });
    await db.deleteGroupRole(role.id);
    res.json({ success: true });
  } catch (error) {
    errorResponse(res, error, 'role delete error');
  }
});

router.get({
  path: '/:groupId/members',
  summary: 'グループメンバー一覧の取得',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    const requestedStatus = String(req.query.status || 'active');
    if (!['active', 'pending', 'invited', 'banned'].includes(requestedStatus)) {
      return res.status(400).json({ error: 'メンバー状態が正しくありません。' });
    }
    if (requestedStatus === 'active') {
      await requireActiveMembership(getDb(req), group, req.user.id);
    } else {
      await requireGroupPermission(getDb(req), group, req.user.id, 'ban');
    }
    const memberships = await getDb(req).getGroupMemberships(group.id, { status: requestedStatus, limit: 200, offset: normalizeOffset(req.query.offset) });
    const users = await getDb(req).getUsersByIds(memberships.map((membership) => membership.userId ?? membership.user_id));
    const usersById = new Map(users.map((user) => [Number(user.id), user]));
    res.json({ members: memberships.map((membership) => ({ membership: membershipPayload(membership), user: usersById.get(Number(membership.userId ?? membership.user_id)) || null })) });
  } catch (error) {
    errorResponse(res, error, 'member list error');
  }
});

router.patch({
  path: '/:groupId/members/:userId',
  summary: 'グループメンバーのロール更新',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const memberId = normalizeUserId(req.params.userId);
  if (memberId == null) return res.status(400).json({ error: 'ユーザーIDが正しくありません。' });
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    const db = getDb(req);
    const state = await requireActiveMembership(db, group, req.user.id);
    if (!isAdmin(group, state.membership, state.role)) return res.status(403).json({ error: 'メンバーを管理する権限がありません。' });
    if (isOwner(group, memberId)) return res.status(403).json({ error: 'オーナーのロールは変更できません。' });
    const member = await db.getGroupMembership(group.id, memberId);
    if (!member || member.status !== 'active') return res.status(404).json({ error: '参加中のメンバーが見つかりません。' });
    const roleId = String(req.body?.role_id || '').trim();
    const role = (await db.getGroupRoles(group.id)).find((candidate) => String(candidate.id) === roleId);
    if (!role) return res.status(400).json({ error: 'ロールが正しくありません。' });
    const updated = await db.updateGroupMembership(group.id, memberId, { roleId: role.id });
    if (!updated) return res.status(404).json({ error: 'メンバーが見つかりません。' });
    res.json({ membership: membershipPayload(updated) });
  } catch (error) {
    errorResponse(res, error, 'member update error');
  }
});

router.post({
  path: '/:groupId/members/:userId/ban',
  summary: 'グループメンバーの追放・禁止',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const memberId = normalizeUserId(req.params.userId);
  if (memberId == null) return res.status(400).json({ error: 'ユーザーIDが正しくありません。' });
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    const db = getDb(req);
    await requireGroupPermission(db, group, req.user.id, 'ban');
    if (isOwner(group, memberId)) return res.status(403).json({ error: 'オーナーを追放することはできません。' });
    if (!await db.getUserById(memberId)) return res.status(404).json({ error: 'ユーザーが見つかりません。' });
    const current = await db.getGroupMembership(group.id, memberId);
    if (current?.status === 'active' && !isOwner(group, req.user.id)) {
      const roles = await db.getGroupRoles(group.id);
      const targetRoleId = current.roleId ?? current.role_id ?? null;
      const targetRole = roles.find((role) => String(role.id) === String(targetRoleId)) || null;
      if (isAdmin(group, current, targetRole)) {
        return res.status(403).json({ error: '管理者を禁止できるのはオーナーのみです。' });
      }
    }
    const updated = current
      ? await db.updateGroupMembership(group.id, memberId, { status: 'banned', roleId: null, joinedAt: null })
      : await db.createGroupMembership({ groupId: group.id, userId: memberId, roleId: null, status: 'banned', joinedAt: null });
    await cancelPendingGroupJoinRequests(db, group.id, memberId);
    res.json({ membership: membershipPayload(updated) });
  } catch (error) {
    errorResponse(res, error, 'member ban error');
  }
});

router.post({
  path: '/:groupId/members/:userId/unban',
  summary: 'グループメンバーの追放・禁止解除',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const memberId = normalizeUserId(req.params.userId);
  if (memberId == null) return res.status(400).json({ error: 'ユーザーIDが正しくありません。' });
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    const db = getDb(req);
    await requireGroupPermission(db, group, req.user.id, 'ban');
    const membership = await db.getGroupMembership(group.id, memberId);
    if (!membership || membership.status !== 'banned') return res.status(404).json({ error: '禁止状態のメンバーが見つかりません。' });
    const updated = await db.updateGroupMembership(group.id, memberId, { status: 'pending', roleId: null, joinedAt: null });
    res.json({ membership: membershipPayload(updated) });
  } catch (error) {
    errorResponse(res, error, 'member unban error');
  }
});

router.get({
  path: '/:groupId/posts',
  summary: 'グループ内タイムライン投稿一覧の取得',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const group = await getGroupOr404(req, res);
    if (!group) return;
    await requireActiveMembership(getDb(req), group, req.user.id);
    const limit = normalizeLimit(req.query.limit, 30, 100);
    const beforeId = normalizePostId(req.query.before_id);
    const rawCursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : null;
    const offset = (beforeId == null && !rawCursor) ? normalizeOffset(req.query.offset) : 0;
    const authorId = req.query.author_id === undefined ? null : normalizeUserId(req.query.author_id);
    if (req.query.author_id !== undefined && authorId == null) return res.status(400).json({ error: '投稿者IDが正しくありません。' });
    const subType = req.query.sub_type === 'replies_only' ? 'replies_only' : 'posts_only';
    const mode = String(req.query.mode || 'all');
    let page;
    if (mode === 'announcements') {
      page = await getDb(req).getGroupAnnouncementPostIds(group.id, { limit, offset, beforeId, cursor: rawCursor });
    } else if (mode === 'recommended') {
      const candidatePage = await getDb(req).getGroupPostIds(group.id, { limit: Math.min(limit * 4, 100), offset, beforeId, authorId, subType, cursor: rawCursor });
      const candidatePosts = await getDb(req).getPostsByIds(candidatePage.ids || []);
      const eligiblePosts = (candidatePosts || [])
        .filter((post) => Number(post.userId ?? post.user_id) !== Number(req.user.id));
      const score = (post) => Number(post.like_count ?? post.likeCount ?? 0) + Number(post.star_count ?? post.starCount ?? 0) * 2 + Number(post.repost_count ?? post.repostCount ?? 0) * 3;
      const rankedIds = [...eligiblePosts].sort((left, right) => {
        return score(right) - score(left) || Number(right.id) - Number(left.id);
      }).map((post) => Number(post.id));
      page = { ...candidatePage, ids: rankedIds.slice(0, limit) };
    } else {
      page = await getDb(req).getGroupPostIds(group.id, { limit, offset, beforeId, authorId, subType, cursor: rawCursor });
    }
    const posts = await serializePostsByIds(getDb(req), page.ids || [], req.user.id, getPublicUrl(req), req.user.visibilityUser || null);
    res.json({ posts, has_next: Boolean(page.has_more), next_cursor: page.next_cursor || null });
  } catch (error) {
    errorResponse(res, error, 'post list error');
  }
});

module.exports = router;
