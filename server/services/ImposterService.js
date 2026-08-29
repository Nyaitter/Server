'use strict';

const IMPOSTER_ROLES = new Set(['manager', 'editor']);

function normalizeUserId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeRole(value, fallback = 'editor') {
  return IMPOSTER_ROLES.has(value) ? value : fallback;
}

function parseSettingsSafe(settings) {
  if (!settings) return {};
  let parsed = settings;
  while (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (_) {
      break;
    }
  }
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function getImposterMetadata(user) {
  if (!user || typeof user !== 'object') return null;
  const settings = parseSettingsSafe(user.settings);
  let source = settings.imposter;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch (_) {}
  }

  const parentId = normalizeUserId(
    source?.parent_id ||
    source?.parentId ||
    user?.imposter_parent_id ||
    user?.parentId
  );
  if (!parentId) {
    if (user.auth_provider === 'imposter') {
      // auth_provider が imposter なのに parent_id が未設定の場合のフォールバック
      return { parent_id: null, members: [] };
    }
    return null;
  }

  const rawMembers = Array.isArray(source?.members) ? source.members : [];
  const members = rawMembers
    .map((member) => {
      const userId = normalizeUserId(member?.user_id || member?.userId);
      return userId
        ? { user_id: userId, role: normalizeRole(member?.role) }
        : null;
    })
    .filter(Boolean);

  return {
    parent_id: parentId,
    members: [...new Map(members.map((member) => [member.user_id, member])).values()],
  };
}

function isImposter(user) {
  if (!user) return false;
  if (user.auth_provider === 'imposter') return true;
  return getImposterMetadata(user) != null;
}

function getImposterRole(user, operatorId) {
  const metadata = getImposterMetadata(user);
  const normalizedOperatorId = normalizeUserId(operatorId);
  const userId = normalizeUserId(user?.id);
  if (!metadata || !normalizedOperatorId) return null;
  if (metadata.parent_id === normalizedOperatorId) return 'owner';
  if (userId === normalizedOperatorId) return 'owner';
  return metadata.members.find((member) => member.user_id === normalizedOperatorId)?.role || null;
}

function canOperateImposter(user, operatorId) {
  return getImposterRole(user, operatorId) != null;
}

function canManageImposter(user, operatorId) {
  const role = getImposterRole(user, operatorId);
  return role === 'owner' || role === 'manager';
}

function toImposterSettings(parentId, members = []) {
  return {
    parent_id: normalizeUserId(parentId),
    members: (members || [])
      .map((member) => {
        const userId = normalizeUserId(member?.user_id || member?.userId);
        return userId ? { user_id: userId, role: normalizeRole(member?.role) } : null;
      })
      .filter(Boolean),
  };
}

async function listImposters(db) {
  const users = await db.getAllUsers();
  return (users || []).filter(isImposter);
}

async function listOwnedImposters(db, parentId) {
  const normalizedParentId = normalizeUserId(parentId);
  if (!normalizedParentId) return [];
  const imposters = await listImposters(db);
  return imposters.filter(
    (imposter) => getImposterMetadata(imposter)?.parent_id === normalizedParentId,
  );
}

async function listAccessibleImposters(db, operatorId) {
  const normalizedOperatorId = normalizeUserId(operatorId);
  if (!normalizedOperatorId) return [];

  const operatorUser = await db.getUserById(normalizedOperatorId);
  const operatorMetadata = getImposterMetadata(operatorUser);
  const effectiveParentId = operatorMetadata?.parent_id || normalizedOperatorId;

  const imposters = await listImposters(db);
  const allUsers = await db.getAllUsers();
  const existingUserIds = new Set((allUsers || []).map((u) => Number(u.id)));

  const accessible = [];
  for (const imposter of imposters) {
    let metadata = getImposterMetadata(imposter);

    // 自己修復:
    // もしインポスターの parent_id が現在のDBに存在せず孤立しており、かつ操作者が通常アカウントの場合
    if (metadata && !existingUserIds.has(metadata.parent_id) && operatorUser && operatorUser.auth_provider !== 'imposter') {
      metadata.parent_id = effectiveParentId;
      const updatedSettings = {
        ...parseSettingsSafe(imposter.settings),
        imposter: toImposterSettings(effectiveParentId, metadata.members),
      };
      imposter.settings = updatedSettings;
      void db.updateUserProfile?.(imposter.id, { settings: updatedSettings }).catch(() => {});
    }

    if (metadata && (metadata.parent_id === effectiveParentId || canOperateImposter(imposter, normalizedOperatorId))) {
      accessible.push(imposter);
    }
  }

  return accessible;
}

async function listAccessibleImpostersForOperators(db, operatorIds) {
  const normalizedOperatorIds = [...new Set((operatorIds || []).map(normalizeUserId).filter(Boolean))];
  if (normalizedOperatorIds.length === 0) return new Map();

  const allUsers = await db.getAllUsers();
  const usersById = new Map((allUsers || []).map((user) => [Number(user.id), user]));
  const imposters = (allUsers || []).filter(isImposter);
  const existingUserIds = new Set(usersById.keys());
  const result = new Map();

  for (const operatorId of normalizedOperatorIds) {
    const operatorUser = usersById.get(operatorId) || await db.getUserById(operatorId);
    const operatorMetadata = getImposterMetadata(operatorUser);
    const effectiveParentId = operatorMetadata?.parent_id || operatorId;
    const accessible = [];

    for (const imposter of imposters) {
      const metadata = getImposterMetadata(imposter);
      if (metadata && !existingUserIds.has(metadata.parent_id) && operatorUser && operatorUser.auth_provider !== 'imposter') {
        metadata.parent_id = effectiveParentId;
        const updatedSettings = {
          ...parseSettingsSafe(imposter.settings),
          imposter: toImposterSettings(effectiveParentId, metadata.members),
        };
        imposter.settings = updatedSettings;
        void db.updateUserProfile?.(imposter.id, { settings: updatedSettings }).catch(() => {});
      }
      if (metadata && (metadata.parent_id === effectiveParentId || canOperateImposter(imposter, operatorId))) {
        accessible.push(imposter);
      }
    }
    result.set(operatorId, accessible);
  }
  return result;
}

module.exports = {
  IMPOSTER_ROLES,
  normalizeUserId,
  normalizeRole,
  getImposterMetadata,
  isImposter,
  getImposterRole,
  canOperateImposter,
  canManageImposter,
  toImposterSettings,
  listOwnedImposters,
  listAccessibleImposters,
  listAccessibleImpostersForOperators,
};
