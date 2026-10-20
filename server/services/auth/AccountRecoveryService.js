'use strict';

const crypto = require('crypto');
const {
  hashApprovalPollToken,
  generateApprovalPollToken,
} = require('./LoginSecurityService');
const { defaultRegistry } = require('./AuthProviderRegistry');
const { createNotificationIfAllowed } = require('../NotificationDeliveryService');

const RECOVERY_NOTIFICATION_MESSAGE = '不明な場所からアカウントアクセスの復旧依頼が届いています。心当たりがあれば承認し、心当たりがなければブロックしてください。';
const RECOVERY_BLOCK_REASON = 'account_recovery_blocked';
// 承認が「いつでも消費できる」状態に残ると、侵害者が数週間後にトークンで入れてしまう。
const APPROVAL_VALIDITY_HOURS = 24;
// 待機中の依頼は 24h 間隔で再通知されるが、上限を置かないと通知が無限に増え続ける。
const MAX_RECOVERY_NOTIFICATIONS = 3;

function toTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/**
 * ユーザーの状態から信頼度を算出し、信頼度に応じた待機期間で
 * 不明な場所からのアクセス復旧を管理する。
 */
class AccountRecoveryService {
  constructor({ db, config, registry = defaultRegistry, logger = console } = {}) {
    this.db = db;
    this.config = config || {};
    this.registry = registry;
    this.logger = logger;
  }

  get recoveryConfig() {
    const cfg = this.config?.accountRecovery || {};
    const minWaitHours = Math.max(1, Number(cfg.minWaitHours) || 24);
    const maxWaitHours = Math.max(minWaitHours, Number(cfg.maxWaitHours) || 168);
    const notificationIntervalHours = Math.max(1, Number(cfg.notificationIntervalHours) || 24);
    return {
      enabled: cfg.enabled !== false,
      minWaitHours,
      maxWaitHours,
      notificationIntervalHours,
    };
  }

  describeProvider(providerName) {
    const provider = this.registry?.getProvider?.(providerName);
    return {
      name: String(providerName || '').toLowerCase(),
      displayName: provider?.displayName || providerName || '不明なログイン方法',
    };
  }

  _computeTrust(user, stats) {
    const createdAt = toTime(user?.created_at || user?.createdAt);
    const ageDays = createdAt ? (Date.now() - createdAt) / 86400000 : 0;

    let score = 0;
    if (ageDays >= 365) score += 30;
    else if (ageDays >= 180) score += 24;
    else if (ageDays >= 90) score += 18;
    else if (ageDays >= 30) score += 12;
    else if (ageDays >= 7) score += 6;

    const providerCount = stats.providers.length;
    if (providerCount >= 3) score += 25;
    else if (providerCount === 2) score += 15;
    else if (providerCount === 1) score += 5;

    if (stats.providers.some((p) => String(p.provider).toLowerCase() === 'passkey')) score += 10;

    if (stats.trustedIpCount >= 3) score += 20;
    else if (stats.trustedIpCount === 2) score += 12;
    else if (stats.trustedIpCount === 1) score += 6;

    if (stats.sessionCount >= 3) score += 15;
    else if (stats.sessionCount >= 1) score += 8;

    if (stats.postCount >= 10) score += 10;
    else if (stats.postCount >= 1) score += 4;

    return Math.max(0, Math.min(100, score));
  }

  _computeWait(score, now = new Date()) {
    const { minWaitHours, maxWaitHours } = this.recoveryConfig;
    const span = maxWaitHours - minWaitHours;
    const ratio = Math.max(0, Math.min(100, score)) / 100;
    const waitHours = Math.max(minWaitHours, Math.round(maxWaitHours - ratio * span));
    return {
      waitHours,
      waitUntil: new Date(now.getTime() + waitHours * 3600 * 1000),
    };
  }

  _resolveProvider(approval, providers) {
    const linked = new Set(providers.map((p) => String(p.provider).toLowerCase()));
    const claimed = approval?.authProvider ? String(approval.authProvider).toLowerCase() : null;
    if (claimed && linked.has(claimed)) return claimed;
    return providers[0] ? String(providers[0].provider).toLowerCase() : 'unknown';
  }

  async _gatherStats(user) {
    const db = this.db;
    const [providers, trustedIpCount, sessions, postCount] = await Promise.all([
      typeof db.getUserAuthProviders === 'function' ? db.getUserAuthProviders(user.id) : [],
      typeof db.countTrustedLoginIps === 'function' ? db.countTrustedLoginIps(user.id) : 0,
      typeof db.getUserSessions === 'function' ? db.getUserSessions(user.id) : [],
      typeof db.getPostCount === 'function' ? db.getPostCount(user.id) : 0,
    ]);
    return {
      providers: Array.isArray(providers) ? providers : [],
      trustedIpCount: Number(trustedIpCount) || 0,
      sessionCount: Array.isArray(sessions) ? sessions.length : 0,
      postCount: Number(postCount) || 0,
    };
  }

  /**
   * 復旧を開始する。同じ場所からの保留中リクエストがあれば待機期間を延長せずトークンだけ更新する。
   * @returns {Promise<{ request: object, token: string, resumed: boolean }>}
   */
  async startRecovery({ user, metadata, approval }) {
    if (!this.recoveryConfig.enabled) {
      const err = new Error('アカウントアクセスの復旧は現在利用できません。');
      err.status = 403;
      err.code = 'account_recovery_disabled';
      throw err;
    }

    const blocked = await this.db.getBlockedLoginIp(user.id, metadata.ipHash);
    if (blocked) {
      const err = new Error('この場所からの復旧は恒久的にブロックされています。');
      err.status = 403;
      err.code = 'account_recovery_blocked';
      throw err;
    }

    const stats = await this._gatherStats(user);

    const existing = await this.db.getActiveAccountRecoveryRequest(user.id, metadata.ipHash);
    if (existing) {
      const token = generateApprovalPollToken();
      const rotated = await this.db.rotateAccountRecoveryToken(existing.id, hashApprovalPollToken(token));
      if (!rotated) {
        // 別端末が先に承認/ブロックした（=waiting ではなくなった）。この新しいトークンは
        // 保存されていないので渡すと poll が必ず 404 になる。原因を特定できるよう 409 で止める。
        const settled = typeof this.db.getAccountRecoveryRequest === 'function'
          ? await this.db.getAccountRecoveryRequest(existing.id)
          : null;
        const err = new Error(settled && settled.status !== 'waiting'
          ? 'この復旧依頼はすでに処理済みです。ログインを最初からやり直してください。'
          : '復旧依頼を更新できませんでした。時間をおいて再度お試しください。');
        err.status = 409;
        err.code = 'account_recovery_stale';
        throw err;
      }
      return { request: rotated, token, resumed: true };
    }

    const authProvider = this._resolveProvider(approval, stats.providers);
    const trustScore = this._computeTrust(user, stats);
    const { waitUntil } = this._computeWait(trustScore);
    const token = generateApprovalPollToken();

    const request = await this.db.createAccountRecoveryRequest({
      userId: user.id,
      ipHash: metadata.ipHash,
      ipMasked: metadata.ipMasked,
      userAgent: metadata.userAgent,
      authProvider,
      requestTokenHash: hashApprovalPollToken(token),
      trustScore,
      waitUntil,
    });

    return { request, token, resumed: false };
  }

  // 復旧依頼の実状態を poll の応答語彙に写す（waiting は「まだ待機中」＝pending）。
  _pollStatusOf(request) {
    if (!request || !request.status) return 'invalid';
    return request.status === 'waiting' ? 'pending' : String(request.status);
  }

  /**
   * 要求元のポーリング。待機期間が過ぎていれば承認し、状態を返す。
   */
  async resolvePoll({ requestId, token, metadata }) {
    if (!requestId || !token) return { status: 'invalid' };
    const request = await this.db.getAccountRecoveryRequestByToken(requestId, hashApprovalPollToken(token));
    if (!request) return { status: 'invalid' };
    if (metadata && request.ipHash !== metadata.ipHash) {
      return { status: 'ip_mismatch', request };
    }

    if (request.status === 'waiting') {
      const waitUntil = toTime(request.waitUntil);
      if (waitUntil != null && waitUntil <= Date.now()) {
        const approved = await this._approve(request, 'timeout');
        const settled = approved || request;
        // 承認を適用できなかった（待ち時間に別端末がブロック/消費した）行を承認扱いすると、
        // 未承認のままセッション発行経路に入れてしまう。実際の状態だけを返す。
        return { status: this._pollStatusOf(settled), request: settled };
      }
      return { status: 'pending', request };
    }
    if (request.status === 'approved') {
      if (this._isApprovalStale(request)) return { status: 'expired', request };
      return { status: 'approved', request };
    }
    return { status: request.status, request };
  }

  // 承認から時間が経った依頼は消費させない。放置しておくと、漏れたトークンが
  // 何週間後も有効なままログイン手段になってしまう。
  _isApprovalStale(request) {
    const decidedAt = toTime(request?.decidedAt) ?? toTime(request?.waitUntil);
    if (decidedAt == null) return false;
    return Date.now() - decidedAt > APPROVAL_VALIDITY_HOURS * 3600 * 1000;
  }

  async _approve(request, decidedBy) {
    let approved = request;
    if (request.status === 'waiting') {
      approved = await this.db.approveDueAccountRecoveryRequest(request.id, decidedBy);
      if (!approved) {
        approved = await this.db.getAccountRecoveryRequest(request.id);
      }
    }
    if (approved && approved.status === 'approved') {
      await this.db.trustLoginIp(approved.userId, {
        ipHash: approved.ipHash,
        ipMasked: approved.ipMasked,
      });
    }
    return approved;
  }

  /**
   * 所有者による承認またはブロック。
   * ブロック時は、ログイン方法が2つ以上ある場合に侵害されたプロバイダーの連携を解除し、
   * 要求元IPを恒久的にブロックする。
   */
  async decideRecovery({ user, requestId, decision }) {
    const wantsBlock = !(decision === 'approve' || decision === 'approved');
    const request = await this.db.decideAccountRecoveryRequest(user.id, requestId, decision);
    if (!request) return null;

    if (wantsBlock) {
      // 承認済み（未消費）なら行も blocked に変わるが、消費済みで状態が据え置かれることもある。
      // どちらでも IP 遮断・セッション無効化・プロバイダ解除は実行しないと防御が効かない。
      request.revokedProvider = await this._applyBlock(request);
      return request;
    }
    if (request.status === 'approved') {
      await this.db.trustLoginIp(request.userId, { ipHash: request.ipHash, ipMasked: request.ipMasked });
    }
    return request;
  }

  async _applyBlock(request) {
    const db = this.db;
    let revoked = { revoked: false, reason: 'not_attempted' };

    const providers = typeof db.getUserAuthProviders === 'function'
      ? await db.getUserAuthProviders(request.userId)
      : [];
    if (providers.length >= 2 && typeof db.revokeAuthProvider === 'function') {
      try {
        revoked = await db.revokeAuthProvider(request.userId, request.authProvider);
      } catch (error) {
        this.logger?.warn?.(`[account-recovery] provider revoke failed: ${error.message}`);
        revoked = { revoked: false, reason: 'error' };
      }
    } else if (providers.length <= 1) {
      revoked = { revoked: false, reason: 'last_provider' };
    }

    await db.blockLoginIp(request.userId, {
      ipHash: request.ipHash,
      ipMasked: request.ipMasked,
      reason: RECOVERY_BLOCK_REASON,
      sourceRecoveryId: request.id,
    });

    if (typeof db.invalidateSessionsByIp === 'function') {
      await db.invalidateSessionsByIp(request.userId, request.ipHash);
    }
    return revoked;
  }

  async _approveDue(now) {
    const due = await this.db.listDueAccountRecoveryRequests(now);
    let approved = 0;
    for (const request of due) {
      try {
        const result = await this._approve(request, 'timeout');
        if (result?.status === 'approved') approved += 1;
      } catch (error) {
        this.logger?.warn?.(`[account-recovery] auto approve failed: ${error.message}`);
      }
    }
    return approved;
  }

  async _notifyPending(now) {
    const cutoff = new Date(now.getTime() - this.recoveryConfig.notificationIntervalHours * 3600 * 1000);
    const pending = await this.db.listAccountRecoveryRequestsToNotify(cutoff);
    let sent = 0;
    for (const request of pending) {
      // アドレス側が応答しない（端末が手元にない等）と、上限がないと通知と行が無限に増える。
      if (Number(request.notifiedCount || 0) >= MAX_RECOVERY_NOTIFICATIONS) continue;
      try {
        await this.publishNotification(request);
        await this.db.markAccountRecoveryNotified(request.id, now);
        sent += 1;
      } catch (error) {
        this.logger?.warn?.(`[account-recovery] notification failed: ${error.message}`);
      }
    }
    return sent;
  }

  async publishNotification(request) {
    await createNotificationIfAllowed(this.db, {
      userId: request.userId,
      type: 'account_recovery',
      fromUserId: null,
      target: { kind: 'route', value: `#account-recovery/${request.id}` },
      message: RECOVERY_NOTIFICATION_MESSAGE,
    });
  }

  async runCycle(now) {
    const approved = await this._approveDue(now);
    const notified = await this._notifyPending(now);
    return { approved, notified };
  }
}

module.exports = {
  AccountRecoveryService,
  RECOVERY_NOTIFICATION_MESSAGE,
  RECOVERY_BLOCK_REASON,
};
