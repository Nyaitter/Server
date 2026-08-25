const api = require('../utils/ApiRegistry');
const { requireAuthAllowFrozen } = require('../middleware/auth');

const router = api.createRouter({
  tag: 'appeals',
  basePath: '/appeals',
  description: '凍結アカウント異議申し立て API',
});

function getModerationService(req) {
  return req.app.locals.moderationReportService || null;
}

function requireFrozenSession(req, res, next) {
  if (req.user?.isBot) {
    return res.status(403).json({ error: 'Bot tokens cannot submit appeals' });
  }
  if (!req.user?.frozen) {
    return res.status(403).json({ error: 'Only frozen accounts can submit appeals' });
  }
  return next();
}

function serializeAppeal(appeal) {
  if (!appeal || appeal.assignmentType !== 'freeze_appeal') return null;
  return {
    id: Number(appeal.id),
    status: appeal.status,
    assigned_at: appeal.assignedAt || null,
    created_at: appeal.createdAt || null,
    freeze_reason: appeal.targetSnapshot?.freezeReason || null,
  };
}

router.get({
  path: '/me',
  summary: '自分の凍結異議申し立て状態の取得',
  auth: 'frozen_session',
}, requireAuthAllowFrozen, requireFrozenSession, async (req, res) => {
  const service = getModerationService(req);
  if (!service) return res.status(503).json({ error: 'Moderation service is unavailable' });
  try {
    const appeal = await service.getFreezeAppealStatus(req.user.id);
    return res.json({ appeal: serializeAppeal(appeal) });
  } catch (error) {
    console.error('[appeals] get status error:', error);
    return res.status(500).json({ error: '異議申し立ての状態を取得できませんでした' });
  }
});

router.post({
  path: '/',
  summary: '凍結異議申し立ての提出',
  auth: 'frozen_session',
}, requireAuthAllowFrozen, requireFrozenSession, async (req, res) => {
  const service = getModerationService(req);
  if (!service) return res.status(503).json({ error: 'Moderation service is unavailable' });
  try {
    const appeal = await service.createFreezeAppeal({
      userId: req.user.id,
      description: req.body?.description,
    });
    return res.status(201).json({ appeal: serializeAppeal(appeal) });
  } catch (error) {
    const message = error.message || '異議申し立てを送信できませんでした';
    const status = /すでに確認中|説明を入力|characters or less|凍結中のアカウント/.test(message) ? 400 : 500;
    return res.status(status).json({ error: message });
  }
});

module.exports = router;
