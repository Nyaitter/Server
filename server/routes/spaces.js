'use strict';

const express = require('express');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const config = require('../config');
const {
  normalizeSpaceId,
  normalizeSpaceVisibility,
  normalizeChannelKind,
  normalizeUserId,
  normalizeLimit,
  normalizeOffset,
  normalizeMessageContent,
  normalizeChannelName,
  isSpaceOwner,
  canAccessSpace,
  isActiveGroupMember,
  requireSpaceOwner,
  requireSpaceMembership,
  countSpacesByOwner,
  createSpaceWithDefaults,
  newSpaceId,
} = require('../services/SpaceService');
const { invalidateUserBriefCache } = require('../utils/serialize');

const api = require('../utils/ApiRegistry');

const router = api.createRouter({
  tag: 'spaces',
  basePath: '/spaces',
  description: 'スペース（テキスト・ボイスチャンネルの部屋）API',
});

function getDb(req) {
  return req.app.locals.dbAdapter;
}

function errorResponse(res, error, contextMessage = 'server error') {
  if (error?.statusCode && error.statusCode < 500) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  console.error(`[spaces] ${contextMessage}:`, error);
  return res.status(500).json({ error: error.message || '内部エラーが発生しました。' });
}

function spacePayload(space, { membership = null } = {}) {
  return {
    id: String(space.id),
    owner_id: Number(space.ownerId ?? space.owner_id),
    name: space.name || '',
    description: space.description || '',
    icon_data: space.iconData ?? space.icon_data ?? null,
    header_image: space.headerImage ?? space.header_image ?? null,
    visibility: space.visibility || 'public',
    group_id: space.groupId ?? space.group_id ?? null,
    member_count: Math.max(0, Number(space.memberCount ?? space.member_count) || 0),
    created_at: space.createdAt ?? space.created_at ?? null,
    updated_at: space.updatedAt ?? space.updated_at ?? null,
    ...(membership ? { membership } : {}),
  };
}

function membershipPayload(member) {
  if (!member) return null;
  return {
    space_id: String(member.spaceId ?? member.space_id),
    user_id: Number(member.userId ?? member.user_id),
    role: member.role || 'member',
    joined_at: member.joinedAt ?? member.joined_at ?? null,
  };
}

function channelPayload(channel) {
  return {
    id: String(channel.id),
    space_id: String(channel.spaceId ?? channel.space_id),
    name: channel.name || '',
    kind: channel.kind || 'text',
    sort_order: Math.max(0, Number(channel.sortOrder ?? channel.sort_order) || 0),
    created_at: channel.createdAt ?? channel.created_at ?? null,
  };
}

function messagePayload(message) {
  return {
    id: Number(message.id),
    space_id: String(message.spaceId ?? message.space_id),
    channel_id: String(message.channelId ?? message.channel_id),
    user_id: Number(message.userId ?? message.user_id),
    content: message.content || '',
    created_at: message.createdAt ?? message.created_at ?? null,
  };
}

async function getSpaceOr404(req, res) {
  const spaceId = normalizeSpaceId(req.params.spaceId);
  if (!spaceId) {
    res.status(400).json({ error: 'スペースIDが正しくありません。' });
    return null;
  }
  const space = await getDb(req).getSpaceById(spaceId);
  if (!space) {
    res.status(404).json({ error: 'スペースが見つかりません。' });
    return null;
  }
  return space;
}

async function getChannelOr404(req, res) {
  const channelId = normalizeSpaceId(req.params.channelId);
  if (!channelId) {
    res.status(400).json({ error: 'チャンネルIDが正しくありません。' });
    return null;
  }
  const channel = await getDb(req).getSpaceChannel(channelId);
  if (!channel) {
    res.status(404).json({ error: 'チャンネルが見つかりません。' });
    return null;
  }
  return channel;
}

// 通話のシグナリングはサーバーのWebSocket経由で行う。RESTではICESTUNサーバーのみ渡す。
router.get({
  path: '/ice-servers',
  summary: '音声通話用 ICE サーバー設定の取得',
  auth: 'none',
}, async (req, res) => {
  const iceServers = Array.isArray(config.spaces?.iceServers) ? config.spaces.iceServers : [];
  res.json({
    ice_servers: iceServers,
    ice_transport_policy: config.spaces?.iceTransportPolicy || 'all',
    bundle_policy: config.spaces?.bundlePolicy || 'max-bundle',
    rtcp_mux_policy: config.spaces?.rtcpMuxPolicy || 'require',
  });
});

router.get({
  path: '/',
  summary: '公開スペース一覧の取得',
  auth: 'optional',
}, optionalAuth, async (req, res) => {
  const limit = normalizeLimit(req.query.limit, 20);
  const offset = normalizeOffset(req.query.offset);
  const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';

  try {
    const spaces = await getDb(req).listSpaces({ query, limit, offset });
    res.json({ spaces: spaces.map((space) => spacePayload(space)), limit, offset });
  } catch (error) {
    errorResponse(res, error, 'list error');
  }
});

router.post({
  path: '/',
  summary: 'スペースの作成',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();
  const visibility = normalizeSpaceVisibility(req.body?.visibility);
  const limitPerUser = config.limits?.spaceMaxCreatedPerUser ?? 20;

  if (!name || name.length > 50) {
    return res.status(400).json({ error: 'スペース名の長さが正しくありません。' });
  }
  if (!visibility) {
    return res.status(400).json({ error: 'スペースの公開範囲が正しくありません。' });
  }

  try {
    const db = getDb(req);
    let groupId = null;
    if (visibility === 'group') {
      groupId = String(req.body?.group_id ?? req.body?.groupId ?? '').trim();
      const group = groupId ? await db.getGroupById(groupId) : null;
      if (!group) return res.status(400).json({ error: '対象のグループが見つかりません。' });
      if (!await isActiveGroupMember(db, group.id ?? group.groupId ?? groupId, req.user.id)) {
        return res.status(403).json({ error: 'このグループのメンバーのみ作成できます。' });
      }
    }
    const created = await countSpacesByOwner(db, req.user.id);
    if (created >= limitPerUser) {
      return res.status(409).json({ error: `スペースは最大${limitPerUser}件まで作成できます。` });
    }
    const space = await createSpaceWithDefaults(db, {
      ownerId: req.user.id,
      name,
      description,
      visibility,
      groupId,
      iconData: req.body?.iconData ?? null,
      headerImage: req.body?.headerImage ?? null,
    });
    invalidateUserBriefCache(req.user.id);
    res.status(201).json({ space: spacePayload(space, { membership: { space_id: space.id, user_id: req.user.id, role: 'owner', joined_at: null } }) });
  } catch (error) {
    errorResponse(res, error, 'create error');
  }
});

router.get({
  path: '/mine',
  summary: '参加中スペース一覧の取得',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const limit = normalizeLimit(req.query.limit, 50);
  const offset = normalizeOffset(req.query.offset);
  try {
    const spaces = await getDb(req).listUserSpaces(req.user.id, { limit, offset });
    res.json({ spaces: spaces.map((space) => spacePayload(space, { membership: membershipPayload(space.membership) })), limit, offset });
  } catch (error) {
    errorResponse(res, error, 'mine error');
  }
});

router.get({
  path: '/:spaceId',
  summary: 'スペース詳細の取得',
  auth: 'optional',
}, optionalAuth, async (req, res) => {
  try {
    const space = await getSpaceOr404(req, res);
    if (!space) return;
    const viewerId = req.user ? req.user.id : null;
    const membership = viewerId != null ? await getDb(req).getSpaceMember(space.id, viewerId) : null;
    if (!await canAccessSpace(getDb(req), space, viewerId, membership)) {
      return res.status(403).json({ error: 'このスペースにアクセスする権限がありません。' });
    }
    const channels = await getDb(req).listSpaceChannels(space.id);
    res.json({ space: spacePayload(space, { membership: membershipPayload(membership) }), channels: channels.map(channelPayload) });
  } catch (error) {
    errorResponse(res, error, 'detail error');
  }
});

router.patch({
  path: '/:spaceId',
  summary: 'スペース情報の更新',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const space = await getSpaceOr404(req, res);
    if (!space) return;
    await requireSpaceOwner(getDb(req), space, req.user.id);

    const fields = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name || name.length > 50) return res.status(400).json({ error: 'スペース名の長さが正しくありません。' });
      fields.name = name;
    }
    if (req.body?.description !== undefined) fields.description = String(req.body.description || '');
    if (req.body?.iconData !== undefined) fields.iconData = req.body.iconData || null;
    if (req.body?.headerImage !== undefined) fields.headerImage = req.body.headerImage || null;
    if (req.body?.visibility !== undefined) {
      const visibility = normalizeSpaceVisibility(req.body.visibility);
      if (!visibility) return res.status(400).json({ error: 'スペースの公開範囲が正しくありません。' });
      fields.visibility = visibility;
    }
    const db = getDb(req);
    const hasExplicitFields = Object.keys(fields).length > 0;
    if (req.body?.group_id !== undefined || req.body?.groupId !== undefined) {
      const groupId = String(req.body.group_id ?? req.body.groupId ?? '').trim();
      if (!groupId) {
        fields.groupId = null;
      } else {
        const group = await db.getGroupById(groupId);
        if (!group) return res.status(400).json({ error: '対象のグループが見つかりません。' });
        if (!await isActiveGroupMember(db, group.id ?? group.groupId ?? groupId, req.user.id)) {
          return res.status(403).json({ error: 'このグループのメンバーのみ設定できます。' });
        }
        fields.groupId = group.id ?? group.groupId ?? groupId;
      }
    }
    if ((fields.visibility ?? space.visibility ?? 'public') === 'group') {
      const nextGroupId = fields.groupId ?? space.groupId ?? space.group_id ?? null;
      if (!nextGroupId) return res.status(400).json({ error: 'グループを選択してください。' });
      fields.groupId = nextGroupId;
    } else if (hasExplicitFields || req.body?.group_id !== undefined || req.body?.groupId !== undefined) {
      fields.groupId = null;
    }
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: '更新する項目がありません。' });

    const updated = await db.updateSpace(space.id, fields);
    res.json({ space: spacePayload(updated) });
  } catch (error) {
    errorResponse(res, error, 'update error');
  }
});

router.delete({
  path: '/:spaceId',
  summary: 'スペースの削除',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const space = await getSpaceOr404(req, res);
    if (!space) return;
    await requireSpaceOwner(getDb(req), space, req.user.id);
    await getDb(req).deleteSpace(space.id);
    await req.app.locals.calls?.refreshStage(space.id);
    const realtime = req.app.locals.realtime;
    if (realtime?.broadcastToSpace) realtime.broadcastToSpace(space.id, getDb(req), { type: 'space_deleted', space_id: space.id });
    res.json({ deleted: true });
  } catch (error) {
    errorResponse(res, error, 'delete error');
  }
});

router.post({
  path: '/:spaceId/join',
  summary: 'スペースへの参加',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const space = await getSpaceOr404(req, res);
    if (!space) return;
    const db = getDb(req);
    const existing = await db.getSpaceMember(space.id, req.user.id);
    if (existing) {
      return res.json({ membership: membershipPayload(existing), already: true });
    }
    if (space.visibility === 'private' && !isSpaceOwner(space, req.user.id)) {
      return res.status(403).json({ error: 'このスペースは招待制です。' });
    }
    const membership = await db.createSpaceMember({ spaceId: space.id, userId: req.user.id, role: 'member' });
    await db.updateSpaceMemberCount(space.id);
    invalidateUserBriefCache(req.user.id);
    res.json({ membership: membershipPayload(membership), already: false });
  } catch (error) {
    errorResponse(res, error, 'join error');
  }
});

router.post({
  path: '/:spaceId/leave',
  summary: 'スペースからの退出',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const space = await getSpaceOr404(req, res);
    if (!space) return;
    const db = getDb(req);
    if (isSpaceOwner(space, req.user.id)) {
      return res.status(409).json({ error: 'オーナーは退出できません。先にスペースを削除するか、オーナーを譲ってください。' });
    }
    const removed = await db.deleteSpaceMember(space.id, req.user.id);
    if (removed) await db.updateSpaceMemberCount(space.id);
    const realtime = req.app.locals.realtime;
    if (realtime?.broadcastToSpace) {
      realtime.broadcastToSpace(space.id, getDb(req), { type: 'space_member_left', space_id: space.id, user_id: req.user.id });
    }
    invalidateUserBriefCache(req.user.id);
    res.json({ removed });
  } catch (error) {
    errorResponse(res, error, 'leave error');
  }
});

router.get({
  path: '/:spaceId/members',
  summary: 'スペースメンバー一覧の取得',
  auth: 'optional',
}, optionalAuth, async (req, res) => {
  try {
    const space = await getSpaceOr404(req, res);
    if (!space) return;
    const viewerId = req.user ? req.user.id : null;
    const membership = viewerId != null ? await getDb(req).getSpaceMember(space.id, viewerId) : null;
    if (!await canAccessSpace(getDb(req), space, viewerId, membership)) {
      return res.status(403).json({ error: 'このスペースにアクセスする権限がありません。' });
    }
    const limit = normalizeLimit(req.query.limit, 100, 200);
    const offset = normalizeOffset(req.query.offset);
    const members = await getDb(req).listSpaceMembers(space.id, { limit, offset });
    const users = await getDb(req).getUsersByIds(members.map((member) => member.userId ?? member.user_id));
    const usersById = new Map((users || []).map((user) => [Number(user.id), user]));
    res.json({
      members: members.map((member) => ({
        membership: membershipPayload(member),
        user: usersById.get(Number(member.userId ?? member.user_id)) || null,
      })),
    });
  } catch (error) {
    errorResponse(res, error, 'member list error');
  }
});

router.get({
  path: '/:spaceId/channels',
  summary: 'スペースのチャンネル一覧の取得',
  auth: 'optional',
}, optionalAuth, async (req, res) => {
  try {
    const space = await getSpaceOr404(req, res);
    if (!space) return;
    const viewerId = req.user ? req.user.id : null;
    const membership = viewerId != null ? await getDb(req).getSpaceMember(space.id, viewerId) : null;
    if (!await canAccessSpace(getDb(req), space, viewerId, membership)) {
      return res.status(403).json({ error: 'このスペースにアクセスする権限がありません。' });
    }
    const channels = await getDb(req).listSpaceChannels(space.id);
    res.json({ channels: channels.map(channelPayload) });
  } catch (error) {
    errorResponse(res, error, 'channel list error');
  }
});

router.post({
  path: '/:spaceId/channels',
  summary: 'チャンネルの作成',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const space = await getSpaceOr404(req, res);
    if (!space) return;
    await requireSpaceOwner(getDb(req), space, req.user.id);

    const name = normalizeChannelName(req.body?.name);
    const kind = normalizeChannelKind(req.body?.kind);
    if (!name || name.length > 50) return res.status(400).json({ error: 'チャンネル名の長さが正しくありません。' });
    if (!kind) return res.status(400).json({ error: 'チャンネルの種類が正しくありません。' });

    const channel = await getDb(req).createSpaceChannel({ id: newSpaceId(), spaceId: space.id, name, kind, sortOrder: 0 });
    res.status(201).json({ channel: channelPayload(channel) });
  } catch (error) {
    errorResponse(res, error, 'channel create error');
  }
});

router.patch({
  path: '/:spaceId/channels/:channelId',
  summary: 'チャンネルの更新',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const space = await getSpaceOr404(req, res);
    if (!space) return;
    const channel = await getChannelOr404(req, res);
    if (!channel) return;
    if (String(channel.spaceId ?? channel.space_id) !== String(space.id)) {
      return res.status(400).json({ error: 'チャンネルがこのスペースに属していません。' });
    }
    await requireSpaceOwner(getDb(req), space, req.user.id);

    const fields = {};
    if (req.body?.name !== undefined) {
      const name = normalizeChannelName(req.body.name);
      if (!name || name.length > 50) return res.status(400).json({ error: 'チャンネル名の長さが正しくありません。' });
      fields.name = name;
    }
    if (req.body?.kind !== undefined) {
      const kind = normalizeChannelKind(req.body.kind);
      if (!kind) return res.status(400).json({ error: 'チャンネルの種類が正しくありません。' });
      fields.kind = kind;
    }
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: '更新する項目がありません。' });

    const updated = await getDb(req).updateSpaceChannel(channel.id, fields);
    res.json({ channel: channelPayload(updated) });
  } catch (error) {
    errorResponse(res, error, 'channel update error');
  }
});

router.delete({
  path: '/:spaceId/channels/:channelId',
  summary: 'チャンネルの削除',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const space = await getSpaceOr404(req, res);
    if (!space) return;
    const channel = await getChannelOr404(req, res);
    if (!channel) return;
    if (String(channel.spaceId ?? channel.space_id) !== String(space.id)) {
      return res.status(400).json({ error: 'チャンネルがこのスペースに属していません。' });
    }
    await requireSpaceOwner(getDb(req), space, req.user.id);

    const channels = await getDb(req).listSpaceChannels(space.id);
    if (channels.length < 2) {
      return res.status(409).json({ error: '最後のチャンネルは削除できません。' });
    }
    const removed = await getDb(req).deleteSpaceChannel(channel.id);
    res.json({ deleted: removed });
  } catch (error) {
    errorResponse(res, error, 'channel delete error');
  }
});

router.get({
  path: '/:spaceId/channels/:channelId/messages',
  summary: 'チャンネルのメッセージ一覧の取得',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const space = await getSpaceOr404(req, res);
    if (!space) return;
    const channel = await getChannelOr404(req, res);
    if (!channel) return;
    if (String(channel.spaceId ?? channel.space_id) !== String(space.id)) {
      return res.status(400).json({ error: 'チャンネルがこのスペースに属していません。' });
    }
    const db = getDb(req);
    const membership = await db.getSpaceMember(space.id, req.user.id);
    if (!membership && !isSpaceOwner(space, req.user.id)) {
      return res.status(403).json({ error: 'このスペースに参加している必要があります。' });
    }
    const limit = normalizeLimit(req.query.limit, 50, 100);
    const beforeId = req.query.before_id === undefined ? null : normalizeUserId(req.query.before_id);
    const messages = await db.listSpaceMessages(channel.id, { limit, beforeId });
    res.json({ messages: messages.map(messagePayload), channel: channelPayload(channel) });
  } catch (error) {
    errorResponse(res, error, 'message list error');
  }
});

router.post({
  path: '/:spaceId/channels/:channelId/messages',
  summary: 'チャンネルへのメッセージ送信',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const space = await getSpaceOr404(req, res);
    if (!space) return;
    const channel = await getChannelOr404(req, res);
    if (!channel) return;
    if (String(channel.spaceId ?? channel.space_id) !== String(space.id)) {
      return res.status(400).json({ error: 'チャンネルがこのスペースに属していません。' });
    }
    const db = getDb(req);
    await requireSpaceMembership(db, space, req.user.id);

    const content = normalizeMessageContent(req.body?.content);
    if (!content || content.length > 2000) {
      return res.status(400).json({ error: 'メッセージの長さが正しくありません。' });
    }

    const message = await db.createSpaceMessage({ spaceId: space.id, channelId: channel.id, userId: req.user.id, content });
    const user = await db.getUserById(req.user.id);
    const realtime = req.app.locals.realtime;
    if (realtime?.broadcastToSpace) {
      realtime.broadcastToSpace(space.id, getDb(req), {
        type: 'space_message',
        space_id: space.id,
        channel_id: channel.id,
        message: messagePayload(message),
        user: user || null,
      });
    }
    res.status(201).json({ message: messagePayload(message) });
  } catch (error) {
    errorResponse(res, error, 'message create error');
  }
});

router.delete({
  path: '/:spaceId/messages/:messageId',
  summary: 'メッセージの削除',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const messageId = Number(req.params.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return res.status(400).json({ error: 'メッセージIDが正しくありません。' });
  }
  try {
    const space = await getSpaceOr404(req, res);
    if (!space) return;
    const db = getDb(req);
    const message = await db.getSpaceMessageById(messageId);
    if (!message || String(message.spaceId ?? message.space_id) !== String(space.id)) {
      return res.status(404).json({ error: 'メッセージが見つかりません。' });
    }
    const isAuthor = Number(message.userId ?? message.user_id) === Number(req.user.id);
    if (!isAuthor && !isSpaceOwner(space, req.user.id)) {
      return res.status(403).json({ error: 'このメッセージを削除する権限がありません。' });
    }
    await db.deleteSpaceMessage(messageId);
    const realtime = req.app.locals.realtime;
    if (realtime?.broadcastToSpace) {
      realtime.broadcastToSpace(space.id, getDb(req), { type: 'space_message_deleted', space_id: space.id, message_id: messageId, channel_id: message.channelId ?? message.channel_id });
    }
    res.json({ deleted: true });
  } catch (error) {
    errorResponse(res, error, 'message delete error');
  }
});

module.exports = router;
