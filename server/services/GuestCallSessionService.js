'use strict';

const crypto = require('crypto');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();

function prune(now = Date.now()) {
    for (const [tokenHash, session] of sessions) if (session.expiresAt <= now) sessions.delete(tokenHash);
}

function createGuestCallSession(stageId) {
    prune();
    const token = crypto.randomBytes(32).toString('base64url');
    const guestId = `guest:${crypto.randomUUID()}`;
    const expiresAt = Date.now() + SESSION_TTL_MS;
    sessions.set(crypto.createHash('sha256').update(token).digest('hex'), { guestId, stageId: String(stageId), expiresAt });
    return { token, guestId, expiresAt };
}

function getGuestCallSession(token) {
    if (!token) return null;
    prune();
    const session = sessions.get(crypto.createHash('sha256').update(String(token)).digest('hex'));
    return session && session.expiresAt > Date.now() ? session : null;
}

function revokeGuestCallSession(token) {
    if (token) sessions.delete(crypto.createHash('sha256').update(String(token)).digest('hex'));
}

module.exports = { createGuestCallSession, getGuestCallSession, revokeGuestCallSession, SESSION_TTL_MS };
