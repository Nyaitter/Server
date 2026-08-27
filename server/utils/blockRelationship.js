'use strict';

const {
    normalizeBlockUserId,
    normalizeBlockList,
} = require('./blockList');

function normalizeUserId(value) {
    return normalizeBlockUserId(value);
}

function blocksUser(user, targetUserId) {
    const targetId = normalizeUserId(targetUserId);
    if (targetId == null) return false;
    return normalizeBlockList(user?.block, user?.id).includes(targetId);
}

/**
 * 二者のどちらか一方が他方をブロックしているかを返す。
 * ブロックの可視性・通知・DM制御は、すべてこの対称的な関係で判断する。
 */
async function hasBlockRelationship(db, firstUserId, secondUserId) {
    const firstId = normalizeUserId(firstUserId);
    const secondId = normalizeUserId(secondUserId);
    if (firstId == null || secondId == null || firstId === secondId) return false;
    if (typeof db?.getUserById !== 'function') return false;

    let users = [];
    if (typeof db.getUsersByIds === 'function') {
        try {
            users = await db.getUsersByIds([firstId, secondId]);
        } catch (_) {}
    }
    const usersById = new Map((users || []).map((user) => [Number(user.id), user]));
    const missingIds = [firstId, secondId].filter((id) => !usersById.has(id));
    if (missingIds.length > 0) {
        const fetched = await Promise.all(missingIds.map((id) => db.getUserById(id)));
        for (const user of fetched.filter(Boolean)) usersById.set(Number(user.id), user);
    }
    const firstUser = usersById.get(firstId);
    const secondUser = usersById.get(secondId);
    return blocksUser(firstUser, secondId) || blocksUser(secondUser, firstId);
}

module.exports = {
    normalizeUserId,
    blocksUser,
    hasBlockRelationship,
};
