const crypto = require('crypto');
const { createNotificationIfAllowed } = require('./NotificationDeliveryService');
const config = require('../config');

const REPORT_TARGET_KINDS = new Set(['user', 'post', 'dm', 'dm_message']);
const REPORT_DESCRIPTION_MAX_LENGTH = config.moderation?.descriptionMaxLength || 2000;
const REPORT_REASSIGN_AFTER_MS = config.moderation?.reassignAfterMs || (24 * 60 * 60 * 1000);

function assignmentNotificationMessage() {
  return '新しいリクエストが割り当てられました。';
}

function cloneJson(value, fallback = {}) {
  try {
    return JSON.parse(JSON.stringify(value ?? fallback));
  } catch (_) {
    return fallback;
  }
}

function toSafeInteger(value, field, { minimum = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${field} is invalid`);
  }
  return parsed;
}

function snapshotUser(user) {
  if (!user) return null;
  return {
    id: Number(user.id),
    name: user.name || '',
    scid: user.scid || null,
    handle: user.handle || null,
    icon_data: user.icon_data || null,
    verify: Boolean(user.verify),
    freeze: user.freeze || null,
    shadow: Boolean(user.shadow),
  };
}

function attachmentKeys(attachments) {
  const parsed = typeof attachments === 'string'
    ? (() => { try { return JSON.parse(attachments); } catch (_) { return []; } })()
    : attachments;
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed
    .map((attachment) => attachment && (attachment.id || attachment.key || null))
    .filter((key) => typeof key === 'string' && key.length > 0))];
}

class ModerationReportService {
  constructor({ dbAdapter, storageAdapter = null, publishNotification = null, now = () => new Date(), config: serviceConfig = null } = {}) {
    this.db = dbAdapter;
    this.storage = storageAdapter;
    this.publishNotification = publishNotification;
    this.now = now;
    this.descriptionMaxLength = serviceConfig?.descriptionMaxLength || config.moderation?.descriptionMaxLength || REPORT_DESCRIPTION_MAX_LENGTH;
    this.reassignAfterMs = serviceConfig?.reassignAfterMs || config.moderation?.reassignAfterMs || REPORT_REASSIGN_AFTER_MS;
  }

  async createReport({ reporterUserId, reporterId: altReporterId, targetKind, targetId, description = '' }) {
    const reporterId = toSafeInteger(reporterUserId ?? altReporterId, 'reporterUserId');
    const kind = String(targetKind || '');
    if (!REPORT_TARGET_KINDS.has(kind)) throw new Error('targetKind is invalid');
    const id = ['dm', 'dm_message'].includes(kind)
      ? String(targetId ?? '').trim()
      : toSafeInteger(targetId, 'targetId', { minimum: kind === 'user' ? 0 : 1 });
    if (['dm', 'dm_message'].includes(kind) && (!id || id.length > 256)) {
      throw new Error('targetId is invalid');
    }

    const normalizedDescription = String(description || '').trim();
    if (normalizedDescription.length > this.descriptionMaxLength) {
      throw new Error(`description must be ${this.descriptionMaxLength} characters or less`);
    }

    const snapshot = await this._captureTargetSnapshot({
      reporterUserId: reporterId,
      targetKind: kind,
      targetId: id,
    });
    const report = await this.db.createModerationReport({
      reporterUserId: reporterId,
      targetKind: kind,
      targetId: id,
      description: normalizedDescription,
      targetSnapshot: snapshot,
      createdAt: this.now().toISOString(),
    });
    return (await this._assignReport(report)) || report;
  }

  async createFreezeAppeal({ userId, description = '' }) {
    const appellantId = toSafeInteger(userId, 'userId');
    const normalizedDescription = String(description || '').trim();
    if (!normalizedDescription) throw new Error('異議申し立ての説明を入力してください');
    if (normalizedDescription.length > this.descriptionMaxLength) {
      throw new Error(`description must be ${this.descriptionMaxLength} characters or less`);
    }

    const appellant = await this.db.getUserById(appellantId);
    if (!appellant || !appellant.freeze) throw new Error('凍結中のアカウントのみ異議申し立てできます');
    const existing = await this.db.getOpenModerationAppealByUserId(appellantId);
    if (existing) throw new Error('すでに確認中の異議申し立てがあります');

    const appeal = await this.db.createModerationReport({
      reporterUserId: appellantId,
      targetKind: 'user',
      targetId: appellantId,
      description: normalizedDescription,
      targetSnapshot: {
        subjectUser: snapshotUser(appellant),
        freezeReason: String(appellant.freeze),
      },
      assignmentType: 'freeze_appeal',
      createdAt: this.now().toISOString(),
    });
    return (await this._assignReport(appeal)) || appeal;
  }

  async getFreezeAppealStatus(userId) {
    return this.db.getOpenModerationAppealByUserId(toSafeInteger(userId, 'userId'));
  }

  async createVerificationApplication({ userId }) {
    const applicantId = toSafeInteger(userId, 'userId');
    const applicant = await this.db.getUserById(applicantId);
    if (!applicant) throw new Error('認証申請対象のユーザーが見つかりません');
    if (applicant.verify) throw new Error('このアカウントはすでに認証済みです');
    const existing = await this.db.getOpenModerationVerificationByUserId(applicantId);
    if (existing) throw new Error('すでに確認中の認証申請があります');

    const application = await this.db.createModerationReport({
      reporterUserId: applicantId,
      targetKind: 'user',
      targetId: applicantId,
      description: '',
      targetSnapshot: { subjectUser: snapshotUser(applicant) },
      assignmentType: 'verification_application',
      createdAt: this.now().toISOString(),
    });
    return (await this._assignReport(application)) || application;
  }

  async getVerificationApplicationStatus(userId) {
    return this.db.getOpenModerationVerificationByUserId(toSafeInteger(userId, 'userId'));
  }

  async getReportById(reportId) {
    const id = toSafeInteger(reportId, 'reportId', { minimum: 1 });
    return this.db.getModerationReportById(id);
  }

  async listReports({ status = 'assigned', limit = 50, offset = 0, adminId = null } = {}) {
    if (adminId != null && typeof this.db.listModerationReportsForAdmin === 'function') {
      return this.db.listModerationReportsForAdmin(adminId, { status, limit, offset });
    }
    if (typeof this.db.listModerationReports === 'function') {
      return this.db.listModerationReports({ status, limit, offset });
    }
    if (typeof this.db.getUnassignedModerationReports === 'function') {
      const reports = await this.db.getUnassignedModerationReports(limit + offset);
      return reports.slice(offset, offset + limit);
    }
    return [];
  }

  async updateReportStatus(reportId, { status, note, action, moderatorId } = {}) {
    const id = toSafeInteger(reportId, 'reportId', { minimum: 1 });
    const adminId = toSafeInteger(moderatorId, 'moderatorId');
    if (status === 'resolved' || status === 'closed') {
      const actions = {};
      if (action === 'delete_post') actions.deletePost = true;
      if (action === 'freeze') actions.freeze = true;
      if (action === 'search_exclude') actions.searchExclude = true;
      if (note) actions.notice = note;
      return this.resolveReport({ reportId: id, adminId, actions });
    }
    if (typeof this.db.updateModerationReport === 'function') {
      return this.db.updateModerationReport(id, { status, note, updatedAt: this.now().toISOString() });
    }
    return this.getReportById(id);
  }

  async _captureTargetSnapshot({ reporterUserId, targetKind, targetId }) {
    if (targetKind === 'user') {
      if (Number(reporterUserId) === Number(targetId)) throw new Error('自分自身は報告できません');
      const user = await this.db.getUserById(targetId);
      if (!user) throw new Error('報告対象のユーザーが見つかりません');
      return { subjectUser: snapshotUser(user) };
    }

    if (targetKind === 'post') {
      const post = await this.db.getPostById(targetId);
      if (!post) throw new Error('報告対象のポストが見つかりません');
      const authorId = Number(post.userId ?? post.user_id);
      if (authorId === Number(reporterUserId)) throw new Error('自分のポストは報告できません');
      const author = await this.db.getUserById(authorId);
      return {
        subjectUser: snapshotUser(author),
        post: {
          id: Number(post.id),
          userId: authorId,
          content: String(post.content || ''),
          attachments: cloneJson(post.attachments, []),
          mask: Boolean(post.mask),
          lock: Boolean(post.lock),
          createdAt: post.createdAt ?? post.created_at ?? null,
        },
      };
    }

    const [dmId, messageId] = targetKind === 'dm_message'
      ? String(targetId).split(':', 2)
      : [String(targetId), null];
    if (targetKind === 'dm_message' && (!dmId || !messageId)) {
      throw new Error('targetId is invalid');
    }

    const dm = await this.db.getGroupDm(dmId);
    if (!dm) throw new Error('報告対象のDMが見つかりません');
    const memberIds = [...new Set((dm.member || []).map(Number).filter(Number.isInteger))];
    if (!memberIds.includes(Number(reporterUserId))) {
      throw new Error('このDMを報告する権限がありません');
    }
    const messages = Array.isArray(dm.post) ? dm.post : [];
    const targetMessage = messageId
      ? messages.find((message) => String(message?.id) === String(messageId))
      : null;
    if (messageId && !targetMessage) {
      throw new Error('報告対象のDMメッセージが見つかりません');
    }
    if (targetMessage && Number(targetMessage.userid) === Number(reporterUserId)) {
      throw new Error('自分のメッセージは報告できません');
    }

    const members = await this.db.getUsersByIds(memberIds);
    const recentMessages = messages.slice(-10).map((message) => cloneJson(message, {}));
    const author = targetMessage
      ? await this.db.getUserById(Number(targetMessage.userid))
      : null;
    return {
      ...(targetMessage ? {
        subjectUser: snapshotUser(author),
        message: cloneJson(targetMessage, {}),
      } : {}),
      dm: {
        id: String(dm.id),
        title: dm.title || '',
        members: (members || []).map(snapshotUser).filter(Boolean),
        // E2E本文は復号せず、保存済みの暗号文を含む直近10件を証跡として保存する。
        recentMessages,
      },
    };
  }

  async _chooseLeastLoadedAdmin(excludedAdminIds = []) {
    const workloads = await this.db.getModerationAdminWorkloads(excludedAdminIds);
    if (!Array.isArray(workloads) || workloads.length === 0) return null;
    const minimum = Math.min(...workloads.map((row) => Number(row.activeCount || 0)));
    const candidates = workloads.filter((row) => Number(row.activeCount || 0) === minimum);
    return candidates[crypto.randomInt(candidates.length)];
  }

  async _assignReport(report, { expectedAdminId, excludedAdminIds } = {}) {
    if (!report || report.status === 'resolved') return null;
    const excluded = [...new Set((excludedAdminIds || report.excludedAdminIds || [])
      .map(Number)
      .filter(Number.isInteger))];
    const selected = await this._chooseLeastLoadedAdmin(excluded);
    if (!selected) return null;

    const assignment = {
      adminId: Number(selected.adminId),
      excludedAdminIds: excluded,
      assignedAt: this.now().toISOString(),
    };
    if (expectedAdminId !== undefined) assignment.expectedAdminId = expectedAdminId;
    const assigned = await this.db.assignModerationReport(report.id, assignment);
    if (assigned) await this._notifyAssignment(assigned);
    return assigned;
  }

  async _notifyAssignment(report) {
    const notification = await createNotificationIfAllowed(this.db, {
      userId: report.assignedAdminId,
      type: 'moderation_assignment',
      message: assignmentNotificationMessage(report),
      target: { kind: 'route', value: `#admin/reports/${report.id}` },
    });
    if (notification) await this._publishNotification(report.assignedAdminId, notification);
  }

  async _deleteCompletedRequest(report) {
    try {
      const deleted = await this.db.deleteModerationReport(report.id);
      if (!deleted) console.warn(`[moderation] completed request ${report.id} was not deleted`);
    } catch (error) {
      console.warn(`[moderation] completed request ${report.id} cleanup failed:`, error.message);
    }
  }

  async _notifyReporter(report, actionTaken) {
    const notification = await createNotificationIfAllowed(this.db, {
      userId: report.reporterUserId,
      type: actionTaken ? 'moderation_action_taken' : 'moderation_no_action',
      target: { kind: 'route', value: '#notifications' },
    });
    if (notification) await this._publishNotification(report.reporterUserId, notification);
  }

  async _publishNotification(userId, notification) {
    if (typeof this.publishNotification !== 'function') return;
    try {
      await this.publishNotification(userId, notification);
    } catch (error) {
      console.warn('[moderation] notification delivery failed:', error.message);
    }
  }

  async runAssignmentSweep() {
    const assigned = [];
    const pending = await this.db.getUnassignedModerationReports(100);
    for (const report of pending) {
      const result = await this._assignReport(report);
      if (result) assigned.push(result);
    }

    const cutoff = new Date(this.now().getTime() - this.reassignAfterMs).toISOString();
    const overdue = await this.db.getOverdueModerationReports(cutoff);
    for (const report of overdue) {
      const excluded = [...new Set([
        ...(report.excludedAdminIds || []),
        Number(report.assignedAdminId),
      ].filter(Number.isInteger))];
      const result = await this._assignReport(report, {
        expectedAdminId: report.assignedAdminId,
        excludedAdminIds: excluded,
      });
      if (result) assigned.push(result);
    }
    return assigned;
  }

  getReviewTargetUserIds(report) {
    const snapshot = report?.targetSnapshot || {};
    const ids = [];
    if (snapshot.subjectUser?.id != null) ids.push(Number(snapshot.subjectUser.id));
    for (const member of snapshot.dm?.members || []) {
      if (member?.id != null) ids.push(Number(member.id));
    }
    return [...new Set(ids.filter(Number.isInteger))];
  }

  async resolveReport({ reportId, adminId, actions = {} }) {
    const report = await this.db.getModerationReportById(reportId);
    if (!report || report.status !== 'assigned' || Number(report.assignedAdminId) !== Number(adminId)) {
      throw new Error('この報告を対応する権限がありません');
    }
    if (report.assignmentType === 'freeze_appeal') {
      throw new Error('異議申し立ては承認または拒否で対応してください');
    }
    if (report.assignmentType === 'verification_application') {
      throw new Error('認証申請は承認または拒否で対応してください');
    }

    const normalizedActions = {
      deletePost: Boolean(actions.deletePost),
      searchExclude: Boolean(actions.searchExclude),
      freeze: Boolean(actions.freeze),
      freezeReason: String(actions.freezeReason || '').trim(),
      notice: String(actions.notice || '').trim(),
      targetUserId: actions.targetUserId == null ? null : toSafeInteger(actions.targetUserId, 'targetUserId'),
    };
    if (normalizedActions.notice.length > this.descriptionMaxLength) {
      throw new Error(`notice must be ${this.descriptionMaxLength} characters or less`);
    }
    if (normalizedActions.freeze && !normalizedActions.freezeReason) {
      throw new Error('凍結する場合は理由が必要です');
    }
    if (normalizedActions.deletePost && report.targetKind !== 'post') {
      throw new Error('ポスト以外は削除できません');
    }

    const candidateUserIds = this.getReviewTargetUserIds(report);
    const needsTargetUser = normalizedActions.searchExclude || normalizedActions.freeze || normalizedActions.notice;
    if (needsTargetUser && !candidateUserIds.includes(Number(normalizedActions.targetUserId))) {
      throw new Error('対応対象ユーザーが報告対象に含まれていません');
    }

    const applied = { deletePost: false, searchExclude: false, freeze: false, notice: false };
    if (normalizedActions.deletePost) {
      const postId = Number(report.targetSnapshot?.post?.id || report.targetId);
      const post = await this.db.getPostById(postId);
      if (post && await this.db.adminDeletePost(postId)) {
        await this._deletePostAttachments(post.attachments);
        applied.deletePost = true;
      }
    }

    if (normalizedActions.searchExclude || normalizedActions.freeze) {
      const updates = {};
      if (normalizedActions.searchExclude) updates.shadow = true;
      if (normalizedActions.freeze) updates.freeze = normalizedActions.freezeReason;
      const updated = await this.db.updateUserProfile(normalizedActions.targetUserId, updates);
      if (!updated) throw new Error('対応対象ユーザーが見つかりません');
      applied.searchExclude = normalizedActions.searchExclude;
      applied.freeze = normalizedActions.freeze;
    }

    if (normalizedActions.notice) {
      const notification = await this.db.createNotification({
        userId: normalizedActions.targetUserId,
        type: 'admin_notice',
        fromUserId: adminId,
        message: normalizedActions.notice,
        target: { kind: 'route', value: '#notifications' },
      });
      if (notification) {
        await this._publishNotification(normalizedActions.targetUserId, notification);
      }
      applied.notice = true;
    }

    const actionTaken = applied.deletePost || applied.searchExclude || applied.freeze;
    const resolution = {
      actionTaken,
      applied,
      targetUserId: normalizedActions.targetUserId,
      notice: normalizedActions.notice || null,
      handledAt: this.now().toISOString(),
    };
    const resolved = await this.db.resolveModerationReport(report.id, adminId, resolution);
    if (!resolved) throw new Error('報告はすでに別の管理者により処理されています');
    await this._notifyReporter(resolved, actionTaken);
    await this._deleteCompletedRequest(resolved);
    return resolved;
  }

  async resolveFreezeAppeal({ reportId, adminId, decision }) {
    const appeal = await this.db.getModerationReportById(reportId);
    if (
      !appeal || appeal.assignmentType !== 'freeze_appeal' || appeal.status !== 'assigned' ||
      Number(appeal.assignedAdminId) !== Number(adminId)
    ) {
      throw new Error('この異議申し立てを対応する権限がありません');
    }
    if (!['approved', 'rejected'].includes(decision)) {
      throw new Error('異議申し立ての判断が不正です');
    }

    const appellantId = Number(appeal.reporterUserId);
    if (decision === 'approved') {
      const updated = await this.db.updateUserProfile(appellantId, { freeze: null });
      if (!updated) throw new Error('異議申し立て対象のユーザーが見つかりません');
    }

    const resolution = {
      appealDecision: decision,
      actionTaken: decision === 'approved',
      handledAt: this.now().toISOString(),
    };
    const resolved = await this.db.resolveModerationReport(appeal.id, adminId, resolution);
    if (!resolved) throw new Error('異議申し立てはすでに別の管理者により処理されています');

    const notification = await this.db.createNotification({
      userId: appellantId,
      type: decision === 'approved' ? 'appeal_approved' : 'appeal_rejected',
      target: { kind: 'route', value: '#notifications' },
    });
    if (notification) await this._publishNotification(appellantId, notification);
    await this._deleteCompletedRequest(resolved);
    return resolved;
  }

  async resolveVerificationApplication({ reportId, adminId, decision }) {
    const application = await this.db.getModerationReportById(reportId);
    if (
      !application || application.assignmentType !== 'verification_application' || application.status !== 'assigned' ||
      Number(application.assignedAdminId) !== Number(adminId)
    ) {
      throw new Error('この認証申請を対応する権限がありません');
    }
    if (!['approved', 'rejected'].includes(decision)) {
      throw new Error('認証申請の判断が不正です');
    }

    const applicantId = Number(application.reporterUserId);
    if (decision === 'approved') {
      const updated = await this.db.updateUserProfile(applicantId, { verify: true });
      if (!updated) throw new Error('認証申請対象のユーザーが見つかりません');
    }

    const resolution = {
      verificationDecision: decision,
      actionTaken: decision === 'approved',
      handledAt: this.now().toISOString(),
    };
    const resolved = await this.db.resolveModerationReport(application.id, adminId, resolution);
    if (!resolved) throw new Error('認証申請はすでに別の管理者により処理されています');

    const notification = await this.db.createNotification({
      userId: applicantId,
      type: decision === 'approved' ? 'verification_approved' : 'verification_rejected',
      target: { kind: 'route', value: '#notifications' },
    });
    if (notification) await this._publishNotification(applicantId, notification);
    await this._deleteCompletedRequest(resolved);
    return resolved;
  }

  async _deletePostAttachments(attachments) {
    const keys = attachmentKeys(attachments);
    if (keys.length === 0 || !this.storage) return;
    try {
      if (typeof this.storage.deleteMany === 'function') {
        await this.storage.deleteMany(keys);
      } else if (typeof this.storage.delete === 'function') {
        await Promise.all(keys.map((key) => this.storage.delete(key)));
      }
    } catch (error) {
      console.warn('[moderation] post attachment cleanup failed:', error.message);
    }
  }
}

module.exports = {
  ModerationReportService,
  REPORT_DESCRIPTION_MAX_LENGTH,
  REPORT_REASSIGN_AFTER_MS,
};
