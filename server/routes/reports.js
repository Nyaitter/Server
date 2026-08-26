const api = require('../utils/ApiRegistry');
const { requireAuth, requireAuthAllowFrozen } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');
const config = require('../config');

const router = api.createRouter({
  tag: 'reports',
  basePath: '/reports',
  description: '通報（報告）およびモデレーション審査 API',
});

const reportRateLimiter = createRateLimiter(config.rateLimit.report);

function getModerationService(req) {
  return req.app.locals.moderationReportService || null;
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin' && !req.user.admin) {
    return res.status(403).json({ error: '管理者権限が必要です。' });
  }
  return next();
}

function getAdminDisplayName(req) {
  const user = req.user?.visibilityUser || req.user || {};
  return user.name || user.username || user.scratch_name || `#${req.user?.id ?? 'unknown'}`;
}

function serializeReportBrief(report) {
  if (!report) return null;
  return {
    id: Number(report.id),
    status: report.status,
    assignment_type: report.assignmentType,
    reporter_id: report.reporterUserId ?? report.reporterId ?? null,
    target_kind: report.targetKind ?? null,
    target_id: report.targetId ?? null,
    assigned_at: report.assignedAt || null,
    created_at: report.createdAt || null,
  };
}

function serializeReport(report) {
  if (!report) return null;
  return {
    ...serializeReportBrief(report),
    reporter_id: report.reporterUserId ?? report.reporter_id ?? null,
    description: report.description || '',
    target_snapshot: report.targetSnapshot || report.target_snapshot || {},
    assigned_admin_id: report.assignedAdminId ?? report.assigned_admin_id ?? null,
    excluded_admin_ids: report.excludedAdminIds || report.excluded_admin_ids || [],
    resolution: report.resolution || null,
    resolved_at: report.resolvedAt || report.resolved_at || null,
  };
}

router.post({
  path: '/',
  summary: '不適切な投稿またはユーザーの通報・報告',
  auth: 'required',
}, requireAuthAllowFrozen, reportRateLimiter, async (req, res) => {
  const service = getModerationService(req);
  if (!service) return res.status(503).json({ error: 'Moderation service is unavailable' });

  const { target_kind, target_id, description, post_as_user_id } = req.body || {};
  if (!['post', 'user'].includes(target_kind)) {
    return res.status(400).json({ error: 'target_kind must be post or user' });
  }

  const parsedTargetId = parseInt(target_id, 10);
  if (!Number.isInteger(parsedTargetId) || parsedTargetId <= 0) {
    return res.status(400).json({ error: 'Invalid target_id' });
  }

  try {
    const report = await service.createReport({
      reporterUserId: req.user.id,
      targetKind: target_kind,
      targetId: parsedTargetId,
      description: typeof description === 'string' ? description.trim() : '',
      postAsUserId: post_as_user_id,
    });
    return res.status(201).json({ success: true, report: serializeReportBrief(report) });
  } catch (error) {
    console.error('[reports] create error:', error);
    return res.status(500).json({ error: error.message || '通報を送信できませんでした' });
  }
});

router.get({
  path: '/',
  summary: '通報一覧の取得（管理者専用）',
  auth: 'admin',
}, requireAuth, requireAdmin, async (req, res) => {
  const service = getModerationService(req);
  if (!service) return res.status(503).json({ error: 'Moderation service is unavailable' });
  try {
    const status = req.query.status || 'assigned';
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const reports = await service.listReports({ status, limit, offset, adminId: req.user.id });
    res.json({ reports: reports.map(serializeReport) });
  } catch (error) {
    console.error('[reports] list error:', error);
    res.status(500).json({ error: '通報一覧の取得に失敗しました' });
  }
});

router.get({
  path: '/assigned',
  summary: '自分に割り当てられた通報一覧の取得（管理者専用）',
  auth: 'admin',
}, requireAuth, requireAdmin, async (req, res) => {
  const service = getModerationService(req);
  if (!service) return res.status(503).json({ error: 'Moderation service is unavailable' });
  try {
    const status = req.query.status || 'assigned';
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const reports = await service.listReports({ status, limit, offset, adminId: req.user.id });
    res.json({ reports: reports.map(serializeReport) });
  } catch (error) {
    console.error('[reports] list assigned error:', error);
    res.status(500).json({ error: '割り当てられた通報一覧の取得に失敗しました' });
  }
});

router.get({
  path: '/:id',
  summary: '通報詳細の取得（管理者専用）',
  auth: 'admin',
}, requireAuth, requireAdmin, async (req, res) => {
  const service = getModerationService(req);
  if (!service) return res.status(503).json({ error: 'Moderation service is unavailable' });
  try {
    const reportId = parseInt(req.params.id, 10);
    if (!Number.isInteger(reportId) || reportId < 1) {
      return res.status(400).json({ error: '通報IDが不正です' });
    }
    const report = await service.getReportById(reportId);
    if (!report) return res.status(404).json({ error: '通報が見つかりません' });
    res.json({ report: serializeReport(report) });
  } catch (error) {
    console.error('[reports] get error:', error);
    res.status(500).json({ error: '通報詳細の取得に失敗しました' });
  }
});

router.patch({
  path: '/:id',
  summary: '通報の審査ステータス更新・処置実行（管理者専用）',
  auth: 'admin',
}, requireAuth, requireAdmin, async (req, res) => {
  const service = getModerationService(req);
  if (!service) return res.status(503).json({ error: 'Moderation service is unavailable' });
  try {
    const reportId = parseInt(req.params.id, 10);
    if (!Number.isInteger(reportId) || reportId < 1) {
      return res.status(400).json({ error: '通報IDが不正です' });
    }
    const { status, note, action } = req.body || {};
    const updated = await service.updateReportStatus(reportId, { status, note, action, moderatorId: req.user.id });

    try {
      const LogHubManager = require('../services/managementTool/LogHubManager');
      LogHubManager.appendExternalLog({
        type: 'moderation',
        level: 'info',
        source: 'moderation',
        message: `[Moderation] 管理者 @${req.user.name || req.user.username} (#${req.user.id}) が通報 #${reportId} を更新 (status: ${status}, action: ${action || 'none'})`,
        details: { moderatorId: req.user.id, reportId, status, note, action },
      });
    } catch (_) {}

    res.json({ success: true, report: updated });
  } catch (error) {
    console.error('[reports] update error:', error);
    res.status(500).json({ error: error.message || '通報の更新に失敗しました' });
  }
});

router.post({
  path: '/:id/resolve',
  summary: '通報・申請の対応完了（管理者専用）',
  auth: 'admin',
}, requireAuth, requireAdmin, async (req, res) => {
  const service = getModerationService(req);
  if (!service) return res.status(503).json({ error: 'Moderation service is unavailable' });
  try {
    const reportId = parseInt(req.params.id, 10);
    if (!Number.isInteger(reportId) || reportId < 1) {
      return res.status(400).json({ error: '通報IDが不正です' });
    }

    const report = await service.getReportById(reportId);
    if (!report) return res.status(404).json({ error: '通報が見つかりません' });

    let resolved = null;
    if (report.assignmentType === 'freeze_appeal') {
      const decision = req.body?.decision || (req.body?.action === 'approve' || req.body?.approved ? 'approved' : 'rejected');
      resolved = await service.resolveFreezeAppeal({ reportId, adminId: req.user.id, decision });
    } else if (report.assignmentType === 'verification_application') {
      const decision = req.body?.decision || (req.body?.action === 'approve' || req.body?.approved ? 'approved' : 'rejected');
      resolved = await service.resolveVerificationApplication({ reportId, adminId: req.user.id, decision });
    } else {
      const actions = req.body?.actions || req.body || {};
      resolved = await service.resolveReport({ reportId, adminId: req.user.id, actions });
    }

    try {
      const LogHubManager = require('../services/managementTool/LogHubManager');
      LogHubManager.appendExternalLog({
        type: 'admin',
        level: 'info',
        source: 'request',
        message: `[Request] 管理者 @${getAdminDisplayName(req)} (#${req.user.id}) がリクエスト #${reportId} を対応完了`,
        details: { moderatorId: req.user.id, reportId, body: req.body },
      });
    } catch (_) {}

    res.json({ success: true, report: resolved });
  } catch (error) {
    console.error('[reports] resolve error:', error);
    res.status(500).json({ error: error.message || '通報の処理に失敗しました' });
  }
});

module.exports = router;
