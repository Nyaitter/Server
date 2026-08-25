const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../../data');
const AUDITS_FILE = path.join(DATA_DIR, 'nmt-audits.json');

const { requestOperatorCommand } = require('../../utils/operatorControl');

class AdminManager {
  constructor({ dbAdapter }) {
    this.dbAdapter = dbAdapter;
    this.auditLogs = [];
    this._load();
  }

  setDbAdapter(dbAdapter) {
    this.dbAdapter = dbAdapter;
  }

  _load() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (fs.existsSync(AUDITS_FILE)) {
        const raw = fs.readFileSync(AUDITS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) this.auditLogs = parsed.slice(-200);
      }
    } catch (_) {
      this.auditLogs = [];
    }
  }

  _save() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(AUDITS_FILE, JSON.stringify(this.auditLogs.slice(0, 200), null, 2), 'utf8');
    } catch (_) {}
  }

  async getAdmins() {
    // 1. ローカル専用 IPC (operatorControl) 経由で NyaitterServer 本体から優先取得
    try {
      const res = await requestOperatorCommand({ action: 'get-admins' }, { timeoutMs: 1500 });
      if (res?.ok && Array.isArray(res.admins)) {
        return res.admins;
      }
    } catch (_) {}

    // 2. ローカル dbAdapter へのフォールバック
    if (!this.dbAdapter) return [];
    try {
      if (typeof this.dbAdapter.getAllUsers === 'function') {
        const users = await this.dbAdapter.getAllUsers();
        return users.filter((u) => u.admin === true || u.is_admin === true);
      }
      if (typeof this.dbAdapter.searchUsers === 'function') {
        const users = await this.dbAdapter.searchUsers({ query: '', limit: 1000 });
        return users.filter((u) => u.admin === true || u.is_admin === true);
      }
      return [];
    } catch (err) {
      console.error('[NMT-Admin] Failed to list admins:', err);
      return [];
    }
  }

  async searchUsers(query, limit = 20) {
    const q = String(query || '').trim();
    if (!q) return [];

    // 1. ローカル専用 IPC (operatorControl) 経由で優先検索
    try {
      const res = await requestOperatorCommand({ action: 'search-users', query: q, limit }, { timeoutMs: 1500 });
      if (res?.ok && Array.isArray(res.users)) {
        return res.users;
      }
    } catch (_) {}

    // 2. ローカル dbAdapter へのフォールバック
    if (!this.dbAdapter) return [];
    try {
      const numId = Number(q.replace(/^#/, ''));
      if (Number.isInteger(numId) && numId > 0) {
        const user = await this.dbAdapter.getUserById(numId);
        if (user) return [user];
      }

      if (typeof this.dbAdapter.getUserByScid === 'function') {
        const user = await this.dbAdapter.getUserByScid(q);
        if (user) return [user];
      }

      if (typeof this.dbAdapter.searchUsers === 'function') {
        return await this.dbAdapter.searchUsers({ query: q, limit });
      }

      return [];
    } catch (err) {
      console.error('[NMT-Admin] User search error:', err);
      return [];
    }
  }

  async setAdminStatus(targetUserId, adminStatus, operatorUser) {
    const userId = Number(targetUserId);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error('無効なユーザーIDです。');
    }

    let updatedUser = null;

    // 1. ローカル専用 IPC (operatorControl) 経由で優先実行
    try {
      const res = await requestOperatorCommand({ action: 'set-admin', userId, admin: Boolean(adminStatus) }, { timeoutMs: 2000 });
      if (res?.ok && res.user) {
        updatedUser = res.user;
      }
    } catch (_) {}

    // 2. ローカル dbAdapter へのフォールバック
    if (!updatedUser) {
      if (!this.dbAdapter) throw new Error('NyaitterServer またはデータベースが利用できません');
      const user = await this.dbAdapter.getUserById(userId);
      if (!user) throw new Error(`ユーザー #${userId} が見つかりません。`);

      const updated = await this.dbAdapter.updateUserProfile(userId, { admin: Boolean(adminStatus) });
      if (!updated) throw new Error('ユーザー情報の更新に失敗しました。');
      updatedUser = updated;
    }

    // 監査ログ
    const log = {
      timestamp: new Date().toISOString(),
      operatorId: operatorUser?.id || null,
      operatorName: operatorUser?.name || 'Operator',
      targetUserId: userId,
      targetUserName: user.name,
      action: adminStatus ? 'grant_admin' : 'revoke_admin',
    };
    this.auditLogs.unshift(log);
    if (this.auditLogs.length > 200) this.auditLogs.pop();
    this._save();

    return {
      success: true,
      user: {
        id: updated.id,
        name: updated.name,
        scid: updated.scid,
        admin: updated.admin === true,
      },
      auditLog: log,
    };
  }

  getAuditLogs(limit = 50) {
    return this.auditLogs.slice(0, limit);
  }
}

module.exports = AdminManager;
