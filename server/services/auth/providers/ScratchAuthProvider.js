'use strict';

const BaseAuthProvider = require('./BaseAuthProvider');
const {
  generateVerificationCode,
  verifyPendingCode,
  consumeVerificationCode,
} = require('../../../utils/scratchVerifier');
const { verifyScratchAccount } = require('../../../utils/scratchAccountVerifier');
const { isWithinRange } = require('../../../utils/settingFormats');
const { getRequestLoginMetadata } = require('../LoginSecurityService');

function isValidScratchUsername(username, lengthConfig) {
  return (
    typeof username === 'string' &&
    /^[a-zA-Z0-9_-]+$/.test(username) &&
    isWithinRange(username.length, lengthConfig)
  );
}

class ScratchAuthProvider extends BaseAuthProvider {
  get name() {
    return 'scratch';
  }

  get displayName() {
    return 'Scratch';
  }

  isEnabled(config) {
    if (config?.auth?.methods?.scratch?.enabled !== undefined) {
      return Boolean(config.auth.methods.scratch.enabled);
    }
    return config?.auth?.scratch?.enabled !== false;
  }

  getPublicConfig(config, req = null) {
    const scratchConfig = config?.auth?.methods?.scratch || {};
    return {
      name: this.name,
      displayName: this.displayName,
      enabled: this.isEnabled(config, req),
      allowSignup: this.isSignupAllowed(config, req),
      verificationProjectId: scratchConfig.verificationProjectId || config?.scratch?.verificationProjectId || '',
      turnstileRequired: Boolean(config?.turnstile?.enabled),
      rejectNewScratcher: Boolean(scratchConfig.rejectNewScratcher),
      rejectStudentAccounts: Boolean(scratchConfig.rejectStudentAccounts),
      minQualifiedFollowers: Number(scratchConfig.minQualifiedFollowers || 0),
    };
  }

  async initiate(req, payload = {}, context = {}) {
    const { username } = payload;
    const { config } = context;

    if (!username || typeof username !== 'string') {
      const err = new Error('Scratchユーザー名を入力してください。');
      err.status = 400;
      throw err;
    }

    if (!isValidScratchUsername(username, config?.limits?.scratchUsernameLength)) {
      const err = new Error('Scratchユーザー名の形式が無効です。');
      err.status = 400;
      throw err;
    }

    const { ipHash } = getRequestLoginMetadata(req);
    const { code, expiresAt } = generateVerificationCode(username, ipHash);

    return {
      code,
      expiresAt,
      profileUrl: `https://scratch.mit.edu/users/${encodeURIComponent(username)}/`,
    };
  }

  async verify(req, payload = {}, context = {}) {
    const { username, code, turnstile_token } = payload;
    const { config, verifyTurnstile } = context;
    const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const { ipHash } = getRequestLoginMetadata(req);

    if (!username || !code) {
      const err = new Error('ユーザー名と認証コードが必要です。');
      err.status = 400;
      throw err;
    }
    if (!isValidScratchUsername(username, config?.limits?.scratchUsernameLength)) {
      const err = new Error('Scratchユーザー名の形式が無効です。');
      err.status = 400;
      throw err;
    }

    if (config?.turnstile?.enabled && typeof verifyTurnstile === 'function') {
      const turnstileResult = await verifyTurnstile(turnstile_token);
      if (turnstileResult.success !== true) {
        const err = new Error('Turnstileチャレンジを完了してください。');
        err.status = 403;
        err.code = 'turnstile_required';
        throw err;
      }
    }

    const bypassAuth = process.env.DEV_BYPASS_AUTH === 'true';
    const isProd = (process.env.NODE_ENV || 'development') === 'production';

    if (bypassAuth && isProd) {
      const err = new Error('DEV_BYPASS_AUTH is disabled in production');
      err.status = 403;
      throw err;
    }

    if (!bypassAuth) {
      const codeResult = await verifyPendingCode(username, code.toUpperCase(), ipHash);
      if (!codeResult.success) {
        const err = new Error(codeResult.reason);
        err.status = 400;
        throw err;
      }

      const accountCheck = await verifyScratchAccount(username, code, ip);
      if (!accountCheck.ok) {
        const err = new Error(accountCheck.reason || 'Scratchアカウントの検証に失敗しました。');
        err.status = 400;
        throw err;
      }

      const consumption = consumeVerificationCode(username, code, ipHash);
      if (!consumption.success) {
        const err = new Error(consumption.reason);
        err.status = 400;
        throw err;
      }
    } else {
      console.warn('[auth] DEV_BYPASS_AUTH が有効です。すべての検証をスキップしています。');
    }

    return {
      success: true,
      identity: {
        authProvider: 'scratch',
        scid: username,
        name: username,
      },
      profile: {
        scratchUsername: username,
      },
    };
  }

  async resolveUser(db, authResult, context = {}) {
    return await super.resolveUser(db, authResult, context);
  }
}

module.exports = ScratchAuthProvider;
