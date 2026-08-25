'use strict';

class AdminManager {
  constructor({ dbAdapter }) {
    this.dbAdapter = dbAdapter;
    this.auditLogs = [];
  }

  setDbAdapter(dbAdapter) {
    this.dbAdapter = dbAdapter;
  }

  async getAdmins() {
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
    if (!this.dbAdapter) return [];
    try {
      const q = String(query || '').trim();
      if (!q) return [];

      // 数値指定の場合は直接ID検索
      const numId = Number(q.replace(/^#/, ''));
      if (Number.isInteger(numId) && numId > 0) {
        const user = await this.dbAdapter.getUserById(numId);
        if (user) return [user];
      }

      // SCID検索
      if (typeof this.dbAdapter.getUserByScid === 'function') {
        const user = await this.dbAdapter.getUserByScid(q);
        if (user) return [user];
      }

      // 一般検索
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
    if (!this.dbAdapter) throw new Error('Database adapter not available');
    const userId = Number(targetUserId);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error('無効なユーザーIDです。');
    }

    const user = await this.dbAdapter.getUserById(userId);
    if (!user) throw new Error(`ユーザー #${userId} が見つかりません。`);

    const updated = await this.dbAdapter.updateUserProfile(userId, { admin: Boolean(adminStatus) });
    if (!updated) throw new Error('ユーザー情報の更新に失敗しました。');

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
