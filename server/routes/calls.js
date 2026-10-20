'use strict';

const api = require('../utils/ApiRegistry');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { createSpaceWithDefaults, normalizeSpaceId, countSpacesByOwner } = require('../services/SpaceService');
const { authorizeRoom, stagePayload, fail } = require('../services/CallService');
const { createGuestCallSession, revokeGuestCallSession, SESSION_TTL_MS } = require('../services/GuestCallSessionService');
const config = require('../config');

const router = api.createRouter({ tag: 'calls', basePath: '/calls', description: 'ステージとDM通話' });
const db = req => req.app.locals.dbAdapter;
const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
        if (!error.statusCode) console.error('[calls]', error);
        res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : '通話の処理に失敗しました。' });
    }
};
const ids = value => {
    if (!Array.isArray(value) || value.length > 1000 || value.some(id => !Number.isSafeInteger(id) || id < 0)) fail(400, '招待ユーザーIDが正しくありません。');
    return [...new Set(value)];
};
const ice = () => Array.isArray(config.spaces?.iceServers) ? config.spaces.iceServers : [];
// クライアント側 RTCPeerConnection に渡す推奨設定（後方互換: 追加フィールドのみ）。
const rtcPolicy = () => ({
    ice_transport_policy: config.spaces?.iceTransportPolicy || 'all',
    bundle_policy: config.spaces?.bundlePolicy || 'max-bundle',
    rtcp_mux_policy: config.spaces?.rtcpMuxPolicy || 'require',
});
const guestCookiePath = config.server.apiEndpoint === '/' ? '/' : config.server.apiEndpoint;
const guestCookie = req => String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('nyaitter_stage_guest='))?.slice('nyaitter_stage_guest='.length) || null;

router.get({ path: '/stages', auth: 'optional', summary: '参加可能なステージを検索' }, optionalAuth, wrap(async (req, res) => {
    const query = String(req.query.query || '').trim().slice(0, 200).toLowerCase();
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    // 公開分と本人の非公開分・所属グループ限定分をそれぞれページングし、権限のない部屋は取得しない。
    const groupIds = req.user
        ? (await db(req).getUserGroups(req.user.id, { status: 'active', limit: 100 })).map(group => String(group.id ?? group.groupId)).filter(Boolean)
        : [];
    const [publicSpaces, mine, groupSpaces] = await Promise.all([
        db(req).listSpaces({ query, limit: 100, offset }),
        req.user ? db(req).listUserSpaces(req.user.id, { limit: 100, offset }) : Promise.resolve([]),
        groupIds.length ? db(req).listSpaces({ query, groupIds, limit: 100, offset }) : Promise.resolve([]),
    ]);
    const spaces = [...new Map([...publicSpaces, ...mine, ...groupSpaces].map(s => [s.id, s])).values()];
    const stages = [];
    for (const space of spaces) {
        const stage = stagePayload(space);
        if (!stage || stage.status === 'ended' || (query && !`${stage.name} ${stage.description}`.toLowerCase().includes(query))) continue;
        if (!req.user) {
            if (stage.visibility === 'public') stages.push(stage);
            continue;
        }
        try { await authorizeRoom(db(req), 'stage', stage.id, req.user.id); stages.push(stage); }
        catch (error) { if (error.statusCode !== 403) throw error; }
    }
    res.json({ stages, has_more: publicSpaces.length === 100 || mine.length === 100 || groupSpaces.length === 100 });
}));

router.post({ path: '/stages', auth: 'required', summary: 'ステージを開始・予約' }, requireAuth, wrap(async (req, res) => {
    const v = req.body || {};
    if (await countSpacesByOwner(db(req), req.user.id) >= (config.limits?.spaceMaxCreatedPerUser ?? 20)) fail(403, '作成できるステージ数の上限に達しました。');
    const scheduled = v.scheduled_at ? new Date(v.scheduled_at) : null;
    if (scheduled && (Number.isNaN(scheduled.getTime()) || scheduled.getTime() <= Date.now())) fail(400, '予約日時は未来の日時にしてください。');
    const inviteIds = ids(v.invite_ids || []);
    const speakers = ids(v.speaker_ids || []);
    const description = String(v.description || '').trim();
    if (description.length > 2000) fail(400, '説明は2000文字以内にしてください。');
    const visibility = String(v.visibility || 'public').trim().toLowerCase();
    let groupId = null;
    if (visibility === 'group') {
        groupId = String(v.group_id ?? v.groupId ?? '').trim();
        const group = groupId ? await db(req).getGroupById(groupId) : null;
        if (!group) fail(400, '対象のグループが見つかりません。');
        const membership = await db(req).getGroupMembership(group.id ?? group.groupId ?? groupId, req.user.id);
        if (membership?.status !== 'active') fail(403, 'このグループのメンバーのみ作成できます。');
    }
    for (const uid of [...new Set([...inviteIds, ...speakers])]) if (!await db(req).getUserById(uid)) fail(400, '招待先のユーザーが見つかりません。');
    const space = await createSpaceWithDefaults(db(req), { ownerId: req.user.id, name: v.name, description, visibility, groupId });
    for (const uid of [...new Set([...inviteIds, ...speakers])]) {
        if (uid !== req.user.id) await db(req).createSpaceMember({ spaceId: space.id, userId: uid, role: 'member' });
    }
    const settings = { version: 1, scheduled_at: scheduled?.toISOString() || null, status: scheduled ? 'scheduled' : 'live', speaker_ids: speakers, allow_guest_join: v.allow_guest_join === true };
    const updated = await db(req).updateSpace(space.id, { stage_settings: JSON.stringify(settings) });
    res.status(201).json({ stage: stagePayload(updated) });
}));

router.get({ path: '/stages/:id', auth: 'optional', summary: 'ステージの参加情報' }, optionalAuth, wrap(async (req, res) => {
    if (!normalizeSpaceId(req.params.id)) fail(404, 'ステージが見つかりません。');
    let info;
    if (req.user) info = await authorizeRoom(db(req), 'stage', req.params.id, req.user.id);
    else {
        const stage = stagePayload(await db(req).getSpaceById(req.params.id));
        if (!stage || stage.visibility !== 'public') fail(403, 'このステージはゲスト参加できません。');
        info = { id: stage.id, stage, role: 'audience' };
    }
    const host = await db(req).getUserById(info.stage.owner_id);
    const participants = req.app.locals.calls.roster(req.app.locals.calls.rooms.get(`stage:${info.id}`) || new Map());
    res.json({ stage: info.stage, role: info.role, guest: !req.user, host: { id: info.stage.owner_id, name: host?.name || 'ホスト' }, participants, ...rtcPolicy(), ice_servers: ice() });
}));

router.post({ path: '/stages/:id/guest-session', auth: 'optional', summary: 'ゲスト通話セッションを作成' }, optionalAuth, wrap(async (req, res) => {
    if (req.user) fail(400, 'ログイン中のユーザーはゲスト参加を使えません。');
    if (!normalizeSpaceId(req.params.id)) fail(404, 'ステージが見つかりません。');
    const stage = stagePayload(await db(req).getSpaceById(req.params.id));
    if (!stage || stage.visibility !== 'public' || !stage.allow_guest_join || stage.status === 'ended') fail(403, 'このステージはゲスト参加できません。');
    revokeGuestCallSession(guestCookie(req));
    const guest = createGuestCallSession(stage.id);
    const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    res.set('Cache-Control', 'no-store');
    res.cookie('nyaitter_stage_guest', guest.token, { httpOnly: true, sameSite: 'strict', secure, path: guestCookiePath, maxAge: SESSION_TTL_MS });
    res.json({ guest_id: guest.guestId });
}));

router.delete({ path: '/stages/guest-session', auth: 'optional', summary: 'ゲスト通話セッションを終了' }, optionalAuth, async (req, res) => {
    revokeGuestCallSession(guestCookie(req));
    res.clearCookie('nyaitter_stage_guest', { httpOnly: true, sameSite: 'strict', path: guestCookiePath });
    res.json({ ok: true });
});

router.patch({ path: '/stages/:id', auth: 'required', summary: 'ステージの開始・終了・スピーカー招待' }, requireAuth, wrap(async (req, res) => {
    const info = await authorizeRoom(db(req), 'stage', req.params.id, req.user.id);
    if (info.role !== 'host') fail(403, 'ホストのみ操作できます。');
    const { stage } = info;
    const settings = { version: 1, scheduled_at: stage.scheduled_at, status: stage.status, speaker_ids: stage.speaker_ids, allow_guest_join: stage.allow_guest_join === true };
    if (req.body.status !== undefined) {
        if (!['live', 'ended'].includes(req.body.status) || stage.status === 'ended') fail(400, 'ステージの状態を変更できません。');
        settings.status = req.body.status;
    }
    if (req.body.speaker_ids !== undefined) settings.speaker_ids = ids(req.body.speaker_ids);
    if (req.body.allow_guest_join !== undefined) {
        if (typeof req.body.allow_guest_join !== 'boolean') fail(400, 'ゲスト参加の設定が正しくありません。');
        settings.allow_guest_join = req.body.allow_guest_join;
    }
    const invited = ids(req.body.invite_ids || []);
    for (const uid of [...new Set([...settings.speaker_ids, ...invited])]) {
        if (!await db(req).getUserById(uid)) fail(400, '招待先のユーザーが見つかりません。');
        if (uid !== req.user.id) await db(req).createSpaceMember({ spaceId: info.id, userId: uid, role: 'member' });
    }
    const updated = await db(req).updateSpace(info.id, { stage_settings: JSON.stringify(settings) });
    await req.app.locals.calls.refreshStage(info.id);
    res.json({ stage: stagePayload(updated) });
}));

router.get({ path: '/dm/:id', auth: 'required', summary: 'DM通話の参加情報' }, requireAuth, wrap(async (req, res) => {
    const info = await authorizeRoom(db(req), 'dm', req.params.id, req.user.id);
    const accepted = info.dm.accepted ?? info.dm.unread?._accepted ?? info.dm.member;
    const members = await Promise.all(info.dm.member.filter(id => accepted.map(Number).includes(Number(id))).map(async id => {
        const user = await db(req).getUserById(Number(id));
        return { id: Number(id), name: user?.name || '参加者' };
    }));
    const participants = req.app.locals.calls.roster(req.app.locals.calls.rooms.get(`dm:${info.id}`) || new Map());
    res.json({ title: info.dm.title || members.filter(user => user.id !== req.user.id).map(user => user.name).join('、') || '通話', members, participants, active: participants.length > 0, ...rtcPolicy(), ice_servers: ice() });
}));

module.exports = router;
