'use strict';

const api = require('../utils/ApiRegistry');
const config = require('../config');
const { requireAuthAllowFrozen } = require('../middleware/auth');
const { serializeUserBrief } = require('../utils/serialize');
const { getPublicUrl } = require('../utils/nyaitterAddress');
const {
  normalizeUserId,
  normalizeRole,
  getImposterMetadata,
  getImposterRole,
  isImposter,
  canManageImposter,
  toImposterSettings,
  listOwnedImposters,
  listAccessibleImposters,
} = require('../services/ImposterService');

const router = api.createRouter({
  tag: 'imposters',
  basePath: '/imposters',
  description: 'インポスターAPI',
});

function getDbAdapter(req) {
  return req.app.locals.dbAdapter;
}

async function deleteStoredAttachments(storage, keys) {
  if (!storage || !Array.isArray(keys) || keys.length === 0) return;
  try {
    if (typeof storage.deleteMany === 'function') await storage.deleteMany(keys);
    else if (typeof storage.delete === 'function') await Promise.all(keys.map((key) => storage.delete(key)));
  } catch (error) {
    console.warn('[imposters] attachment deletion failed:', error.message);
  }
}

function requireInteractiveSession(req, res, next) {
  if (req.user?.tokenType !== 'session' || !req.user?.sessionTokenHash) {
    return res.status(403).json({ error: 'ログイン済み端末のセッションが必要です。' });
  }
  return next();
}

function serializeImposter(user, operatorId, publicUrl) {
  const metadata = getImposterMetadata(user);
  return {
    ...serializeUserBrief(user, publicUrl),
    imposter: {
      is_imposter: true,
      role: getImposterRole(user, operatorId),
      member_count: metadata?.members.length || 0,
      members: metadata?.members || [],
    },
  };
}

async function getManageableImposter(req, imposterId) {
  const db = getDbAdapter(req);
  const imposter = await db.getUserById(imposterId);
  if (!imposter || !isImposter(imposter)) return { db, imposter: null };
  if (!canManageImposter(imposter, req.user.id)) return { db, imposter: null };
  return { db, imposter };
}

router.get({
  path: '/',
  summary: 'アクセス可能なインポスター一覧の取得',
  auth: 'session',
}, requireAuthAllowFrozen, requireInteractiveSession, async (req, res) => {
  const db = getDbAdapter(req);
  try {
    const imposters = await listAccessibleImposters(db, req.user.id);
    res.json({
      imposters: imposters.map((imposter) => serializeImposter(
        imposter,
        req.user.id,
        getPublicUrl(req),
      )),
      limit: config.limits.impostersPerParent,
    });
  } catch (error) {
    console.error('[imposters] list error:', error);
    res.status(500).json({ error: 'インポスター一覧の取得に失敗しました。' });
  }
});

router.post({
  path: '/',
  summary: '新規インポスターの作成',
  auth: 'session',
}, requireAuthAllowFrozen, requireInteractiveSession, async (req, res) => {
  const db = getDbAdapter(req);
  const parent = await db.getUserById(req.user.id);
  if (!parent || isImposter(parent)) {
    return res.status(403).json({ error: 'インポスターから新しいインポスターを作成することはできません。' });
  }

  const name = String(req.body?.name || '').trim();
  if (!name || name.length > config.limits.userNameLength.max) {
    return res.status(400).json({ error: 'インポスター名の長さが正しくありません。' });
  }

  try {
    const owned = await listOwnedImposters(db, parent.id);
    if (owned.length >= config.limits.impostersPerParent) {
      return res.status(409).json({ error: `インポスターは最大${config.limits.impostersPerParent}件まで作成できます。` });
    }

    const imposter = await db.createUser({
      name,
      auth_provider: 'imposter',
      settings: {
        imposter: toImposterSettings(parent.id),
      },
    });
    res.status(201).json({
      imposter: serializeImposter(imposter, parent.id, getPublicUrl(req)),
    });
  } catch (error) {
    console.error('[imposters] create error:', error);
    res.status(500).json({ error: 'インポスターの作成に失敗しました。' });
  }
});

router.post({
  path: '/:imposterId/members',
  summary: 'インポスターに共同運用メンバーを追加',
  auth: 'session',
}, requireAuthAllowFrozen, requireInteractiveSession, async (req, res) => {
  const imposterId = normalizeUserId(req.params.imposterId);
  const memberId = normalizeUserId(req.body?.user_id);
  if (!imposterId || !memberId) {
    return res.status(400).json({ error: 'インポスターIDと共同運用者IDが必要です。' });
  }

  try {
    const { db, imposter } = await getManageableImposter(req, imposterId);
    if (!imposter) return res.status(403).json({ error: 'インポスターの管理権限がありません。' });
    const metadata = getImposterMetadata(imposter);
    if (memberId === metadata.parent_id || memberId === imposter.id) {
      return res.status(400).json({ error: '親IDまたはインポスター自身を共同運用者に追加することはできません。' });
    }
    const member = await db.getUserById(memberId);
    if (!member) return res.status(404).json({ error: '共同運用者が見つかりません。' });

    const members = metadata.members.filter((entry) => entry.user_id !== memberId);
    members.push({ user_id: memberId, role: normalizeRole(req.body?.role) });
    const updated = await db.updateUserProfile(imposter.id, {
      settings: {
        ...(imposter.settings || {}),
        imposter: toImposterSettings(metadata.parent_id, members),
      },
    });
    res.json({ imposter: serializeImposter(updated, req.user.id, getPublicUrl(req)) });
  } catch (error) {
    console.error('[imposters] add member error:', error);
    res.status(500).json({ error: '共同運用者の追加に失敗しました。' });
  }
});

router.patch({
  path: '/:imposterId/members/:memberId',
  summary: 'インポスターの共同運用メンバーのロール変更',
  auth: 'session',
}, requireAuthAllowFrozen, requireInteractiveSession, async (req, res) => {
  const imposterId = normalizeUserId(req.params.imposterId);
  const memberId = normalizeUserId(req.params.memberId);
  if (!imposterId || !memberId) {
    return res.status(400).json({ error: 'インポスターIDと共同運用者IDが必要です。' });
  }

  try {
    const { db, imposter } = await getManageableImposter(req, imposterId);
    if (!imposter) return res.status(403).json({ error: 'インポスターの管理権限がありません。' });
    const metadata = getImposterMetadata(imposter);
    const target = metadata.members.find((entry) => entry.user_id === memberId);
    if (!target) return res.status(404).json({ error: '共同運用者が見つかりません。' });

    const members = metadata.members.map((entry) => {
      if (entry.user_id !== memberId) return entry;
      return { ...entry, role: normalizeRole(req.body?.role) };
    });
    const updated = await db.updateUserProfile(imposter.id, {
      settings: {
        ...(imposter.settings || {}),
        imposter: toImposterSettings(metadata.parent_id, members),
      },
    });
    res.json({ imposter: serializeImposter(updated, req.user.id, getPublicUrl(req)) });
  } catch (error) {
    console.error('[imposters] update member role error:', error);
    res.status(500).json({ error: '共同運用者のロール変更に失敗しました。' });
  }
});

router.delete({
  path: '/:imposterId/members/:memberId',
  summary: 'インポスターから共同運用メンバーを削除',
  auth: 'session',
}, requireAuthAllowFrozen, requireInteractiveSession, async (req, res) => {
  const imposterId = normalizeUserId(req.params.imposterId);
  const memberId = normalizeUserId(req.params.memberId);
  if (!imposterId || !memberId) {
    return res.status(400).json({ error: 'インポスターIDと共同運用者IDが必要です。' });
  }

  try {
    const { db, imposter } = await getManageableImposter(req, imposterId);
    if (!imposter) return res.status(403).json({ error: 'インポスターの管理権限がありません。' });
    const metadata = getImposterMetadata(imposter);
    const members = metadata.members.filter((entry) => entry.user_id !== memberId);
    const updated = await db.updateUserProfile(imposter.id, {
      settings: {
        ...(imposter.settings || {}),
        imposter: toImposterSettings(metadata.parent_id, members),
      },
    });
    res.json({ imposter: serializeImposter(updated, req.user.id, getPublicUrl(req)) });
  } catch (error) {
    console.error('[imposters] delete member error:', error);
    res.status(500).json({ error: '共同運用者の削除に失敗しました。' });
  }
});

router.delete({
  path: '/:imposterId',
  summary: 'インポスターの削除',
  auth: 'session',
}, requireAuthAllowFrozen, requireInteractiveSession, async (req, res) => {
  const imposterId = normalizeUserId(req.params.imposterId);
  if (!imposterId) return res.status(400).json({ error: 'インポスターIDが必要です。' });

  try {
    const { db, imposter } = await getManageableImposter(req, imposterId);
    if (!imposter) return res.status(403).json({ error: 'インポスターの削除権限がありません。' });

    const metadata = getImposterMetadata(imposter);
    if (metadata.parent_id !== req.user.id) {
      return res.status(403).json({ error: 'インポスターの削除は親アカウントのみ実行できます。' });
    }

    const attachments = await db.getAttachmentsByUserId?.(imposter.id);
    if (Array.isArray(attachments) && attachments.length > 0) {
      await deleteStoredAttachments(
        req.app.locals.storageAdapter,
        attachments.map((entry) => entry.key || entry.id).filter(Boolean),
      );
    }

    await db.deleteAccount(imposter.id);
    res.json({ success: true });
  } catch (error) {
    console.error('[imposters] delete error:', error);
    res.status(500).json({ error: 'インポスターの削除に失敗しました。' });
  }
});

module.exports = router;
