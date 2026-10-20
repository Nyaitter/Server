'use strict';

const crypto = require('crypto');
const { hasBlockedDmMember } = require('./DmVisibilityService');
const { hasBlockRelationship } = require('../utils/blockRelationship');
const { normalizeSpaceId, isActiveGroupMember } = require('./SpaceService');
const { createNotificationIfAllowed } = require('./NotificationDeliveryService');

function fail(statusCode, message) {
    throw Object.assign(new Error(message), { statusCode });
}

function stageSettings(space) {
    if (!space?.stage_settings) return null;
    let value;
    try { value = typeof space.stage_settings === 'string' ? JSON.parse(space.stage_settings) : space.stage_settings; }
    catch { return null; }
    return value?.version === 1 ? value : null;
}

function stagePayload(space) {
    const settings = stageSettings(space);
    if (!settings) return null;
    return {
        id: String(space.id), name: space.name, description: space.description,
        owner_id: Number(space.ownerId ?? space.owner_id), visibility: space.visibility,
        group_id: space.groupId ?? space.group_id ?? null,
        ...settings,
    };
}

async function authorizeRoom(db, kind, id, userId, { joining = false, guestStageId = null } = {}) {
    if (!id || String(id).length > 128) fail(400, '通話IDが正しくありません。');
    if (kind === 'stage') {
        if (!normalizeSpaceId(id)) fail(404, 'ステージが見つかりません。');
        const space = await db.getSpaceById(id);
        const stage = stagePayload(space);
        if (!stage) fail(404, 'ステージが見つかりません。');
        const isGuest = typeof userId === 'string' && userId.startsWith('guest:');
        const numericUserId = isGuest ? null : Number(userId);
        if (isGuest) {
            if (!stage.allow_guest_join || guestStageId !== String(id)) fail(403, 'ゲスト参加は許可されていません。');
        } else {
            const member = await db.getSpaceMember(id, numericUserId);
            if (stage.owner_id !== numericUserId && stage.visibility !== 'public') {
                const allowed = stage.visibility === 'group'
                    ? await isActiveGroupMember(db, stage.group_id, numericUserId)
                    : Boolean(member);
                if (!allowed) fail(403, '参加権限がありません。');
            }
            if (stage.owner_id !== numericUserId && await hasBlockRelationship(db, numericUserId, stage.owner_id)) fail(403, '参加できません。');
        }
        if (joining && stage.status === 'ended') fail(409, 'このステージは終了しました。');
        return { kind, id, title: stage.name, owner_id: stage.owner_id,
            role: isGuest ? 'audience' : stage.owner_id === numericUserId ? 'host' : (stage.speaker_ids || []).map(Number).includes(numericUserId) ? 'speaker' : 'audience', guest: isGuest, stage };
    }
    if (kind === 'dm') {
        const dm = await db.getGroupDm(id);
        if (!dm || !dm.member?.map(Number).includes(userId)) fail(403, 'このメッセージの通話には参加できません。');
        const accepted = dm.accepted ?? dm.unread?._accepted ?? dm.member;
        if (!accepted.map(Number).includes(userId)) fail(403, 'メッセージへの招待を承諾してから通話してください。');
        if (await hasBlockedDmMember(db, userId, dm.member)) fail(403, 'ブロック関係のあるメッセージでは通話できません。');
        return { kind, id, title: dm.title || 'メッセージの通話', role: 'member', dm };
    }
    fail(400, '通話の種類が正しくありません。');
}

class CallService {
    constructor(realtime, getDb) {
        this.realtime = realtime;
        this.getDb = getDb;
        this.rooms = new Map();
        this.rateWindows = new WeakMap();
        this.queues = new WeakMap();
        this.joinQueues = new Map();
        this.stageBans = new Map();
    }

    send(socket, event) {
        if (socket.readyState === 1 && socket.bufferedAmount < 1024 * 1024) socket.send(JSON.stringify(event));
    }

    roster(room) {
        return [...room.values()].map(({ user_id, name, handle, nyaitterId, guest, role, muted, camera, screenStreamId, screenLabel, chatDisabled, forceMuted, forceCameraOff, forcePinned }) => ({ user_id, name, handle, nyaitter_id: nyaitterId || null, guest: Boolean(guest), role, muted: Boolean(muted || forceMuted), camera: Boolean(camera && !forceCameraOff), chat_disabled: Boolean(chatDisabled), force_muted: Boolean(forceMuted), force_camera_off: Boolean(forceCameraOff), force_pinned: Boolean(forcePinned), screen_stream_id: screenStreamId || null, screen_label: screenLabel || null }));
    }

    publish(key, event) {
        for (const entry of this.rooms.get(key)?.values() || []) this.send(entry.socket, { ...event, room: key });
    }

    publishRoster(key) {
        this.publish(key, { type: 'call:roster', roster: this.roster(this.rooms.get(key) || new Map()) });
    }

    disconnect(socket) {
        for (const [key, room] of this.rooms) {
            for (const [id, entry] of room) if (entry.socket === socket) room.delete(id);
            if (!room.size) this.rooms.delete(key);
            else this.publishRoster(key);
        }
    }

    disconnectRoom(key, socket) {
        const room = this.rooms.get(key);
        if (!room) return false;
        let removed = false;
        for (const [id, entry] of room) {
            if (entry.socket === socket) {
                room.delete(id);
                removed = true;
            }
        }
        if (!room.size) this.rooms.delete(key);
        else if (removed) this.publishRoster(key);
        return removed;
    }

    resolveRoomKey(message) {
        if (typeof message?.room === 'string' && message.room) return message.room;
        if (typeof message?.kind !== 'string' || !message.kind) return null;
        if (message.id === undefined || message.id === null || message.id === '') return null;
        return `${message.kind}:${String(message.id)}`;
    }

    async refreshStage(id) {
        const key = `stage:${id}`;
        const stage = stagePayload(await this.getDb().getSpaceById(id));
        if (!stage || stage.status === 'ended') this.stageBans.delete(String(id));
        const room = this.rooms.get(key);
        if (!room) return;
        let stageStatus = null;
        for (const [uid, entry] of room) {
            try {
                const info = await authorizeRoom(this.getDb(), 'stage', id, uid, { joining: true, guestStageId: entry.guestStageId });
                stageStatus = info.stage.status;
                if (info.role === 'audience' && entry.screenStreamId) {
                    entry.screenStreamId = null;
                    entry.screenLabel = null;
                    this.publish(key, { type: 'call:screen', user_id: uid, active: false });
                }
                if (entry.role !== info.role) {
                    entry.role = info.role;
                    entry.muted = true;
                    entry.camera = false;
                }
            } catch (error) {
                this.send(entry.socket, { type: 'call:ended', room: key, message: error.message });
                room.delete(uid);
            }
        }
        if (!room.size) this.rooms.delete(key);
        else {
            this.publishRoster(key);
            if (stageStatus) this.publish(key, { type: 'call:stage', status: stageStatus });
        }
    }

    async refreshDm(id) {
        const key = `dm:${id}`;
        const room = this.rooms.get(key);
        if (!room) return;
        for (const [uid, entry] of room) {
            try { await authorizeRoom(this.getDb(), 'dm', String(id), uid); }
            catch (error) {
                if (!error.statusCode) throw error;
                this.send(entry.socket, { type: 'call:ended', room: key, message: 'メッセージの参加権限が変更されたため通話から退出しました。' });
                room.delete(uid);
            }
        }
        if (!room.size) this.rooms.delete(key);
        else this.publishRoster(key);
    }

    handle(socket, userId, message, guestStageId = null) {
        if (!message?.type?.startsWith('call:')) return Promise.resolve();
        let rate = this.rateWindows.get(socket);
        if (!rate || Date.now() - rate.at > 10000) this.rateWindows.set(socket, rate = { at: Date.now(), count: 0 });
        if (++rate.count > 1000) { socket.close(1008, 'Too many call messages'); return Promise.resolve(); }
        const previous = this.queues.get(socket) || Promise.resolve();
        const next = previous.then(async () => {
            if (socket.readyState !== 1) return;
            if (!['call:join', 'call:watch'].includes(message.type)) return this.process(socket, userId, message, guestStageId);
            const key = `${message.kind}:${message.id}`;
            const earlier = this.joinQueues.get(key) || Promise.resolve();
            const join = earlier.catch(() => {}).then(() => this.process(socket, userId, message, guestStageId));
            this.joinQueues.set(key, join);
            try { await join; }
            finally { if (this.joinQueues.get(key) === join) this.joinQueues.delete(key); }
        }).catch(error => {
            this.send(socket, { type: 'call:error', request_id: message.request_id, message: error.statusCode ? error.message : '通話の処理に失敗しました。' });
            if (!error.statusCode) console.error('[calls]', error);
        });
        this.queues.set(socket, next);
        void next.finally(() => { if (this.queues.get(socket) === next) this.queues.delete(socket); });
        return next;
    }

    async process(socket, userId, message, guestStageId = null) {
        if (message.type === 'call:leave') {
            const leaveKey = this.resolveRoomKey(message);
            if (!leaveKey) this.disconnect(socket);
            else this.disconnectRoom(leaveKey, socket);
            return;
        }
        const kind = message.kind;
        const id = String(message.id || '');
        if (id.length > 100) fail(400, '通話IDが正しくありません。');
        const key = `${kind}:${id}`;
        const db = this.getDb();
        const info = await authorizeRoom(db, kind, id, userId, { joining: true, guestStageId });
        if (kind === 'stage' && this.stageBans.get(String(id))?.has(String(userId))) fail(403, 'このステージのセッションから追放されています。');
        if (socket.readyState !== 1) return;
        if (message.type === 'call:watch' && info.stage?.status === 'live') message.type = 'call:join';
        if (message.type === 'call:watch') {
            if (kind !== 'stage' || info.role !== 'audience' || info.stage.status !== 'scheduled') fail(409, 'このステージは待機できません。');
            const room = this.rooms.get(key) || new Map();
            const existing = room.get(userId);
            if (existing && existing.socket !== socket) fail(409, '別のタブでこのステージを開いています。');
            if (!existing) room.set(userId, { socket, user_id: userId, name: info.guest ? 'ゲスト' : (await db.getUserById(userId))?.name || `ユーザー ${userId}`, guest: info.guest, guestStageId, role: 'audience', muted: true, camera: false, watching: true });
            this.rooms.set(key, room);
            this.send(socket, { type: 'call:watching', room: key });
            this.publishRoster(key);
            return;
        }
        if (message.type === 'call:join') {
            const currentRoom = this.rooms.get(key);
            const existing = currentRoom?.get(userId);
            if (existing?.socket === socket) {
                this.send(socket, { type: 'call:joined', room: key, role: existing.role, roster: this.roster(this.rooms.get(key)), request_id: message.request_id });
                return;
            }
            if (existing) fail(409, '別のタブでこの通話に参加しています。');
            this.disconnectRoom(key, socket);
            const user = info.guest ? null : await db.getUserById(userId);
            if (socket.readyState !== 1) return;
            const first = !this.rooms.get(key)?.size;
            if (first && kind === 'dm') {
                const msg = { id: crypto.randomUUID(), type: 'system', userid: userId,
                    content: '通話を開始しました。メッセージ右上の通話ボタンから参加できます。', created_at: new Date().toISOString() };
                await db.appendToGroupDm(id, msg, userId);
                const accepted = info.dm.accepted ?? info.dm.unread?._accepted ?? info.dm.member;
                const callType = info.dm.member.length > 2 ? 'group_call' : 'dm_call';
                for (const uid of accepted.map(Number)) {
                    this.realtime.publishDmMessage(uid, id, msg, { id: userId, name: user?.name || '' });
                    await this.realtime.publishDmUnreadCount(uid, db);
                    if (uid === userId) continue;
                    try {
                        await createNotificationIfAllowed(db, { userId: uid, type: callType, fromUserId: userId, target: { kind: 'dm', id } });
                    } catch (error) {
                        console.warn('[calls] call notification delivery failed:', error.message);
                    }
                }
            }
            const confirmed = await authorizeRoom(db, kind, id, userId, { joining: true, guestStageId });
            info.role = confirmed.role;
            if (socket.readyState !== 1) return;
            if (!this.rooms.has(key)) this.rooms.set(key, new Map());
            const room = this.rooms.get(key);
            room.set(userId, { socket, user_id: userId, name: user?.name || (info.guest ? 'ゲスト' : `ユーザー ${userId}`), guest: info.guest, guestStageId,
                handle: user?.scid || user?.username || user?.name || (info.guest ? 'ゲスト' : `ユーザー ${userId}`), nyaitterId: user?.nyaitter_id || user?.nyaitterId || user?.id || null, role: info.role,
                muted: info.role === 'audience' || message.muted !== false,
                camera: info.role !== 'audience' && Boolean(message.camera), transcriptionEnabled: false, chatDisabled: false, forceMuted: false, forceCameraOff: false });
            this.send(socket, { type: 'call:joined', room: key, role: info.role, owner_id: info.owner_id, roster: this.roster(room), request_id: message.request_id });
            this.publishRoster(key);
            return;
        }
        const room = this.rooms.get(key);
        const entry = room?.get(userId);
        if (!entry || entry.socket !== socket) fail(403, '通話に参加してください。');
        if (entry.role !== info.role) { await this.refreshStage(id); fail(409, '発言権が変更されました。'); }
        if (message.type === 'call:signal') {
            const target = room.get(message.to) || room.get(Number(message.to));
            if (!target || target.user_id === userId) return;
            if (kind === 'stage' && userId !== info.owner_id && target.user_id !== info.owner_id) fail(403, 'ステージの接続先が正しくありません。');
            const data = message.data;
            if (!data || typeof data !== 'object') fail(400, 'シグナルが正しくありません。');
            if (data.description) {
                const { type, sdp } = data.description;
                if (!['offer', 'answer'].includes(type) || typeof sdp !== 'string' || sdp.length > 50000) fail(400, 'SDPが正しくありません。');
                if (info.role === 'audience') {
                    const sections = sdp.split(/\r?\nm=/).slice(1);
                    if (sections.some(section => /^(audio|video) /.test(section) && !/\r?\na=(recvonly|inactive)(?:\r?\n|$)/.test(section))) fail(403, '視聴者は音声・映像を送信できません。');
                }
            } else if (!data.candidate || typeof data.candidate.candidate !== 'string' || data.candidate.candidate.length > 4000) fail(400, 'ICEが正しくありません。');
            this.send(target.socket, { type: 'call:signal', room: key, from: userId, data });
        } else if (message.type === 'call:state') {
            entry.muted = info.role === 'audience' || entry.forceMuted || Boolean(message.muted);
            entry.camera = info.role !== 'audience' && !entry.forceCameraOff && Boolean(message.camera);
            if (message.transcription_enabled !== undefined) entry.transcriptionEnabled = Boolean(message.transcription_enabled);
            this.publishRoster(key);
        } else if (message.type === 'call:moderate') {
            if (kind !== 'stage' || info.role !== 'host') fail(403, 'ホストのみ操作できます。');
            const targetId = String(message.target || '');
            const action = String(message.action || '');
            if (!['mute', 'camera', 'chat', 'kick', 'pin', 'promote', 'demote'].includes(action)) fail(400, '操作が正しくありません。');
            const target = [...room.values()].find(candidate => String(candidate.user_id) === targetId);
            if (!target) fail(404, '対象ユーザーが見つかりません。');
            if (target === entry && action !== 'pin') fail(404, '対象ユーザーが見つかりません。');
            if (target.role === 'host' && action !== 'pin') fail(404, '対象ユーザーが見つかりません。');
            if (action === 'kick') {
                let banned = this.stageBans.get(id);
                if (!banned) this.stageBans.set(id, banned = new Set());
                banned.add(targetId);
                this.send(target.socket, { type: 'call:kicked', room: key, message: 'ホストによりこのステージのセッションから退出させられました。ステージ終了まで再参加できません。' });
                room.delete(target.user_id);
                if (room.size) this.publishRoster(key);
                else this.rooms.delete(key);
                return;
            }
            if (action === 'mute') { target.forceMuted = true; target.muted = true; }
            if (action === 'camera') { target.forceCameraOff = true; target.camera = false; }
            if (action === 'chat') target.chatDisabled = true;
            if (action === 'pin') { target.forcePinned = !target.forcePinned; }
            if (action === 'promote') {
                if (target.role !== 'audience') fail(400, 'リスナーのみ昇格できます。');
                const speakerIds = await stageSpeakerIds(this.getDb(), id);
                await updateStageSpeakers(this.getDb(), id, [...new Set([...speakerIds, target.user_id])]);
                target.role = 'speaker'; target.muted = true; target.camera = false;
                target.forceMuted = false; target.forceCameraOff = false;
            }
            if (action === 'demote') {
                if (target.role !== 'speaker') fail(400, 'スピーカーのみ降格できます。');
                const speakerIds = await stageSpeakerIds(this.getDb(), id);
                await updateStageSpeakers(this.getDb(), id, speakerIds.filter(uid => String(uid) !== String(target.user_id)));
                target.role = 'audience'; target.muted = true; target.camera = false;
                target.screenStreamId = null; target.screenLabel = null;
                this.publish(key, { type: 'call:screen', user_id: target.user_id, active: false });
            }
            this.send(target.socket, { type: 'call:moderated', room: key, action });
            this.publishRoster(key);
        } else if (message.type === 'call:screen') {
            if (info.role === 'audience') fail(403, '画面共有には発言権が必要です。');
            if (message.active) {
                const streamId = String(message.stream_id || '');
                if (!streamId || streamId.length > 200) fail(400, '画面共有を確認できません。');
                entry.screenStreamId = streamId;
                entry.screenLabel = `@${String(entry.handle).replace(/^@/, '')}のスクリーン`;
            } else {
                entry.screenStreamId = null;
                entry.screenLabel = null;
            }
            this.publish(key, { type: 'call:screen', user_id: userId, active: Boolean(message.active), stream_id: entry.screenStreamId, label: entry.screenLabel });
        } else if (message.type === 'call:chat' || message.type === 'call:transcript') {
            if (entry.guest) fail(403, 'ゲストはコメントできません。');
            if (message.type === 'call:chat' && entry.chatDisabled) fail(403, 'ホストによりチャットが無効になっています。');
            if (message.type === 'call:transcript' && info.role === 'audience') fail(403, '発言権がありません。');
            if (message.type === 'call:transcript' && entry.muted) fail(403, 'マイクが無効なため文字起こしを受け付けません。');
            const text = String(message.text || '').trim();
            if (!text || text.length > 2000) fail(400, '2000文字以内で入力してください。');
            const event = { type: message.type, user_id: userId, name: entry.name, handle: entry.handle, nyaitter_id: entry.nyaitterId, guest: Boolean(entry.guest), text, at: new Date().toISOString() };
            if (message.type === 'call:transcript') {
                for (const recipient of room.values()) if (recipient.transcriptionEnabled) this.send(recipient.socket, { ...event, room: key });
            } else this.publish(key, event);
        }
    }
}


async function stageSpeakerIds(db, id) {
    const space = await db.getSpaceById(id);
    const settings = stageSettings(space);
    return Array.isArray(settings?.speaker_ids) ? settings.speaker_ids.map(Number) : [];
}
async function updateStageSpeakers(db, id, speakerIds) {
    const space = await db.getSpaceById(id);
    const settings = stageSettings(space);
    if (!settings) return;
    settings.speaker_ids = [...new Set(speakerIds.map(Number))];
    await db.updateSpace(id, { stage_settings: JSON.stringify(settings) });
}

module.exports = { CallService, authorizeRoom, stagePayload, stageSettings, fail };
