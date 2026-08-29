'use strict';

const BaseAuthProvider = require('./BaseAuthProvider');
const NyaitterAuthManager = require('../NyaitterAuthManager');
const { getPublicUrl } = require('../../../utils/nyaitterAddress');

class NyaitterAuthProvider extends BaseAuthProvider {
  get name() {
    return 'nyaitter';
  }

  get displayName() {
    return 'NyaitterAuth';
  }

  isEnabled(config, req = null) {
    if (config?.auth?.methods?.nyaitter?.enabled !== undefined) {
      return Boolean(config.auth.methods.nyaitter.enabled);
    }
    if (config?.auth?.nyaitterAuth?.enabled === false) return false;
    return true;
  }

  isSignupAllowed(config, req = null) {
    const methodConfig = config?.auth?.methods?.nyaitter || config?.auth?.nyaitterAuth || {};
    if (methodConfig.allowSignup !== undefined) {
      return Boolean(methodConfig.allowSignup);
    }
    return true;
  }

  getPublicConfig(config, req = null) {
    return {
      name: this.name,
      displayName: this.displayName,
      enabled: this.isEnabled(config, req),
      allowSignup: this.isSignupAllowed(config, req),
      turnstileRequired: Boolean(config?.turnstile?.enabled),
      description: '他のNyaitterサーバーのアカウントを使用してログイン・連携します。',
    };
  }

  _isSameServer(targetUrl, req) {
    if (!targetUrl) return true;
    try {
      const target = new URL(targetUrl.includes('://') ? targetUrl : `https://${targetUrl}`);
      const currentOrigin = req ? getPublicUrl(req) : 'http://localhost:3000';
      const current = new URL(currentOrigin);

      // Check identical origin
      if (target.origin.toLowerCase() === current.origin.toLowerCase()) {
        return true;
      }

      // Check identical host/port against request header
      const reqHost = req?.headers?.host ? req.headers.host.toLowerCase() : current.host.toLowerCase();
      if (target.host.toLowerCase() === reqHost) {
        return true;
      }

      // Check loopback / localhost equivalences
      const loopbacks = ['localhost', '127.0.0.1', '::1'];
      const isTargetLoopback = loopbacks.includes(target.hostname.toLowerCase());
      const isCurrentLoopback = loopbacks.includes(current.hostname.toLowerCase());
      const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80');
      const currentPort = current.port || (current.protocol === 'https:' ? '443' : '80');
      if (isTargetLoopback && isCurrentLoopback && targetPort === currentPort) {
        return true;
      }

      return false;
    } catch (_) {
      return false;
    }
  }

  async initiate(req, payload = {}, context = {}) {
    const { turnstile_token } = payload;
    const { config, verifyTurnstile } = context;

    if (config?.turnstile?.enabled && typeof verifyTurnstile === 'function') {
      const turnstileResult = await verifyTurnstile(turnstile_token);
      if (turnstileResult.success !== true) {
        const err = new Error('Turnstileチャレンジを完了してください。');
        err.status = 400;
        err.code = 'turnstile_required';
        throw err;
      }
    }

    const rawServerUrl = String(payload.serverUrl || payload.server_url || '').trim();
    if (!rawServerUrl) {
      const err = new Error('連携元のNyaitterサーバーURLを入力してください。同一サーバーでのNyaitterAuthログインは利用できません。');
      err.status = 400;
      err.code = 'same_server_nyauth_disallowed';
      throw err;
    }

    const currentOrigin = req ? getPublicUrl(req) : 'http://localhost:3000';
    const serverUrl = (rawServerUrl.includes('://') ? rawServerUrl : `https://${rawServerUrl}`).replace(/\/+$/, '');

    if (this._isSameServer(serverUrl, req)) {
      const err = new Error('同一のNyaitterサーバーを認証先として指定することはできません。別のNyaitterサーバーのURLを入力してください。');
      err.status = 400;
      err.code = 'same_server_nyauth_disallowed';
      throw err;
    }

    const redirectUri = `${currentOrigin}/#login-callback?provider=nyaitter&server_url=${encodeURIComponent(serverUrl)}`;
    const remoteRes = await fetch(`${serverUrl}/server/auth/nyaitter-auth/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: 'nyaitter_client_login',
        api_token: 'nyaitter_login_token',
        name: 'Nyaitter Client',
        redirect_uri: redirectUri,
        scopes: [
          { scope: 'profile:read', required: true, name: '基本情報の閲覧' },
        ],
      }),
    });
    const remoteData = await remoteRes.json().catch(() => ({}));
    if (!remoteRes.ok || !remoteData.success || !remoteData.auth_url) {
      throw new Error(remoteData.error || 'リモートNyaitterでの認証開始に失敗しました。');
    }
    return {
      success: true,
      auth_url: remoteData.auth_url,
      request_id: remoteData.request_id,
      server_url: serverUrl,
    };
  }

  async verify(req, payload = {}, context = {}) {
    const code = String(payload.code || payload.token || '').trim();
    if (!code) {
      throw new Error('認証コード (token / code) が必要です。');
    }

    const rawServerUrl = String(payload.serverUrl || payload.server_url || '').trim();
    if (!rawServerUrl) {
      const err = new Error('連携元のNyaitterサーバーURLが必要です。');
      err.status = 400;
      err.code = 'same_server_nyauth_disallowed';
      throw err;
    }

    const serverUrl = (rawServerUrl.includes('://') ? rawServerUrl : `https://${rawServerUrl}`).replace(/\/+$/, '');

    if (this._isSameServer(serverUrl, req)) {
      const err = new Error('同一のNyaitterサーバーからの認証は許可されていません。別のNyaitterサーバーを使用してください。');
      err.status = 400;
      err.code = 'same_server_nyauth_disallowed';
      throw err;
    }

    let serverDomain = '';
    try {
      serverDomain = new URL(serverUrl).hostname;
    } catch (_) {
      serverDomain = 'remote';
    }

    const tokenRes = await fetch(`${serverUrl}/server/auth/nyaitter-auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: 'nyaitter_client_login',
        api_token: 'nyaitter_login_token',
        code,
      }),
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.success || !tokenData.user) {
      throw new Error(tokenData.error || 'リモート認証トークンの交換に失敗しました。');
    }
    const userData = tokenData.user;

    if (!userData || !userData.name) {
      throw new Error('認証ユーザー情報の取得に失敗しました。');
    }

    return {
      success: true,
      identity: {
        authProvider: 'nyaitter',
        externalId: String(userData.id),
        name: userData.name,
        scid: userData.scid || null,
        handle: userData.handle || null,
        providerDomain: serverDomain,
      },
      profile: {
        name: userData.name,
        icon_data: userData.icon_data || null,
        me: userData.me || null,
        scid: userData.scid || null,
        handle: userData.handle || null,
      },
    };
  }

  async resolveUser(db, authResult, context = {}) {
    const { identity, profile } = authResult;
    const providerName = identity.authProvider || this.name;
    const providerUserId = String(identity.externalId);

    // 1. Check if user is linked by auth provider and ID
    if (typeof db.findUserByAuthProvider === 'function') {
      const existing = await db.findUserByAuthProvider(providerName, providerUserId);
      if (existing) return existing;
    }

    // 2. Check if there's a user by matching scratch ID
    if (identity.scid) {
      const existingScidUser = await db.getUserByScid(identity.scid);
      if (existingScidUser) {
        if (typeof db.linkAuthProvider === 'function') {
          try {
            await db.linkAuthProvider(existingScidUser.id, providerName, providerUserId, profile || {});
          } catch (_) {}
        }
        return existingScidUser;
      }
    }

    // 3. Create new user account
    if (!this.isSignupAllowed(context.config || {}, context.req || null)) {
      const err = new Error(`この認証方式での新規アカウント作成は無効化されています。`);
      err.status = 403;
      err.code = 'signup_disabled';
      throw err;
    }

    const newUser = await db.createUser({
      scid: identity.scid || null,
      name: identity.name,
      auth_provider: providerName,
      external_id: providerUserId,
      provider_domain: identity.providerDomain || null,
      external_profile: profile || null,
      icon_data: profile?.icon_data || null,
    });

    if (typeof db.linkAuthProvider === 'function') {
      try {
        await db.linkAuthProvider(newUser.id, providerName, providerUserId, profile || {});
      } catch (_) {}
    }

    return newUser;
  }
}

module.exports = NyaitterAuthProvider;
