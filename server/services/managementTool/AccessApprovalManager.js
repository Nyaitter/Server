'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../../data');
const APPROVALS_FILE = path.join(DATA_DIR, 'nmt-approvals.json');

class AccessApprovalManager {
  constructor({ notificationManager = null } = {}) {
    this.notificationManager = notificationManager;
    this.pendingRequests = new Map(); // requestId -> requestData
    this.sessionGrants = new Map(); // sessionId -> Set of granted action types ('edit', 'bash')
    this.history = [];
    this._load();
  }

  setNotificationManager(notificationManager) {
    this.notificationManager = notificationManager;
  }

  _load() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (fs.existsSync(APPROVALS_FILE)) {
        const raw = fs.readFileSync(APPROVALS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) this.history = parsed.slice(-200);
      }
    } catch (_) {
      this.history = [];
    }
  }

  _save() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(APPROVALS_FILE, JSON.stringify(this.history.slice(-200), null, 2), 'utf8');
    } catch (_) {}
  }

  /**
   * セッションまたは全体で既に承認されているか確認
   */
  isGranted(type, sessionId = null) {
    if (!type) return false;
    if (sessionId && this.sessionGrants.has(sessionId)) {
      const grants = this.sessionGrants.get(sessionId);
      if (grants.has(type) || grants.has('*')) return true;
    }
    return false;
  }

  /**
   * 承認リクエストを発行
   */
  async requestAccess({ type, reason, target, command, sessionId = null, context = {} }) {
    // 既にセッションで承認されている場合は即座に true
    if (this.isGranted(type, sessionId)) {
      return { approved: true, autoApproved: true, sessionId };
    }

    const requestId = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10分有効

    const reqData = {
      id: requestId,
      type, // 'edit' | 'bash'
      reason: reason || 'AIエージェントによる操作実行',
      target: target || null, // ファイル名など
      command: command || null, // bashコマンドなど
      sessionId,
      context,
      status: 'pending', // 'pending' | 'approved' | 'denied' | 'expired'
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };

    this.pendingRequests.set(requestId, reqData);

    // 通知マネージャー経由で管理者に通知
    if (this.notificationManager) {
      this.notificationManager.broadcast({
        type: 'approval_request',
        title: `⚠️ AI操作の承認リクエスト [${type.toUpperCase()}]`,
        message: `${reqData.reason}${target ? ` (${target})` : ''}`,
        requestId,
        data: reqData,
      });
    }

    return {
      approved: false,
      pending: true,
      requestId,
      request: reqData,
    };
  }

  getPendingRequests() {
    const now = Date.now();
    const result = [];
    for (const [id, req] of this.pendingRequests.entries()) {
      if (new Date(req.expiresAt).getTime() <= now) {
        req.status = 'expired';
        this.pendingRequests.delete(id);
        this.history.unshift(req);
      } else {
        result.push(req);
      }
    }
    return result;
  }

  approveRequest(requestId, operatorUser = null, { scope = 'session' } = {}) {
    const req = this.pendingRequests.get(requestId);
    if (!req) throw new Error('承認リクエストが見つからないか、期限切れです。');

    req.status = 'approved';
    req.approvedAt = new Date().toISOString();
    req.approvedBy = operatorUser ? { id: operatorUser.id, name: operatorUser.name } : 'Admin';
    req.grantScope = scope;

    // セッション継続承認の記録
    if (req.sessionId) {
      if (!this.sessionGrants.has(req.sessionId)) {
        this.sessionGrants.set(req.sessionId, new Set());
      }
      this.sessionGrants.get(req.sessionId).add(req.type);
    }

    this.pendingRequests.delete(requestId);
    this.history.unshift(req);
    if (this.history.length > 200) this.history.pop();
    this._save();

    if (this.notificationManager) {
      this.notificationManager.broadcast({
        type: 'approval_resolved',
        title: `✅ リクエスト承認完了 [${req.type.toUpperCase()}]`,
        message: `${operatorUser?.name || '管理者'}によって承認されました。`,
        requestId,
      });
    }

    return { success: true, request: req };
  }

  denyRequest(requestId, operatorUser = null) {
    const req = this.pendingRequests.get(requestId);
    if (!req) throw new Error('リクエストが見つかりません。');

    req.status = 'denied';
    req.deniedAt = new Date().toISOString();
    req.deniedBy = operatorUser ? { id: operatorUser.id, name: operatorUser.name } : 'Admin';

    this.pendingRequests.delete(requestId);
    this.history.unshift(req);
    if (this.history.length > 200) this.history.pop();
    this._save();

    return { success: true, request: req };
  }

  getHistory(limit = 50) {
    return this.history.slice(0, limit);
  }
}

module.exports = AccessApprovalManager;
