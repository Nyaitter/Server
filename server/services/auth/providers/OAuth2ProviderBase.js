'use strict';

const crypto = require('crypto');
const BaseAuthProvider = require('./BaseAuthProvider');
const { getPublicUrl } = require('../../../utils/nyaitterAddress');

const STATE_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_TOKEN_LENGTH = 4096;

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function fromBase64url(value) {
  return Buffer.from(String(value), 'base64url');
}

/**
 * Shared OAuth 2.0 Authorization Code + PKCE implementation for redirect-based
 * identity providers. The state token is encrypted with the provider client
 * secret, so no server-side session store is needed and any instance that
 * shares the client credentials can complete the flow.
 */
class OAuth2ProviderBase extends BaseAuthProvider {
  constructor({ authorizeUrl, tokenUrl, userinfoUrl, scope, configKey = null }) {
    super();
    this.authorizeUrl = authorizeUrl;
    this.tokenUrl = tokenUrl;
    this.userinfoUrl = userinfoUrl;
    this.scope = scope;
    this.configKey = configKey || this.name;
  }

  _methodConfig(config) {
    return config?.auth?.methods?.[this.configKey] || {};
  }

  isEnabled(config) {
    const method = this._methodConfig(config);
    return Boolean(method.enabled && method.clientId && method.clientSecret);
  }

  getPublicConfig(config, req = null) {
    return {
      name: this.name,
      displayName: this.displayName,
      enabled: this.isEnabled(config, req),
      allowSignup: this.isSignupAllowed(config, req),
      type: 'redirect',
      turnstileRequired: Boolean(config?.turnstile?.enabled),
    };
  }

  _key(config) {
    const secret = String(this._methodConfig(config).clientSecret || '');
    return crypto.createHash('sha256').update(`nyaitter-oauth:${this.name}:${secret}`).digest();
  }

  _seal(payload, config) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this._key(config), iv);
    cipher.setAAD(Buffer.from(this.name));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const sealed = [base64url(iv), base64url(encrypted), base64url(cipher.getAuthTag())].join('.');
    return `${this.name}.${sealed}`;
  }

  _open(token, config) {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
    const prefix = `${this.name}.`;
    if (!token.startsWith(prefix)) return null;
    const parts = token.slice(prefix.length).split('.');
    if (parts.length !== 3) return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this._key(config), fromBase64url(parts[0]));
      decipher.setAAD(Buffer.from(this.name));
      decipher.setAuthTag(fromBase64url(parts[2]));
      const decrypted = Buffer.concat([decipher.update(fromBase64url(parts[1])), decipher.final()]);
      const payload = JSON.parse(decrypted.toString('utf8'));
      if (!payload || payload.p !== this.name || typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
        return null;
      }
      return payload;
    } catch (_) {
      return null;
    }
  }

  _redirectUri(req, config) {
    const configured = String(this._methodConfig(config).redirectUri || '').trim();
    if (configured) return configured;
    const base = getPublicUrl(req).replace(/\/+$/, '');
    return `${base}/?oauth=${encodeURIComponent(this.name)}`;
  }

  _authorizeEndpoint(config) {
    const tenant = String(this._methodConfig(config).tenant || '').trim();
    return tenant ? this.authorizeUrl.replace('{tenant}', encodeURIComponent(tenant)) : this.authorizeUrl;
  }

  _tokenEndpoint(config) {
    const tenant = String(this._methodConfig(config).tenant || '').trim();
    return tenant ? this.tokenUrl.replace('{tenant}', encodeURIComponent(tenant)) : this.tokenUrl;
  }

  async initiate(req, payload = {}, context = {}) {
    const { config, verifyTurnstile } = context;
    if (config?.turnstile?.enabled && typeof verifyTurnstile === 'function') {
      const turnstileResult = await verifyTurnstile(payload.turnstile_token);
      if (turnstileResult.success !== true) {
        const err = new Error('Turnstileチャレンジを完了してください。');
        err.status = 400;
        err.code = 'turnstile_required';
        throw err;
      }
    }

    const method = this._methodConfig(config);
    const redirectUri = this._redirectUri(req, config);
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const nonce = crypto.randomBytes(16).toString('base64url');
    const state = this._seal({
      p: this.name,
      v: verifier,
      n: nonce,
      r: redirectUri,
      exp: Date.now() + STATE_TTL_MS,
    }, config);

    const params = new URLSearchParams({
      client_id: String(method.clientId),
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.scope,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (this.name === 'google') {
      params.set('access_type', 'online');
      params.set('prompt', 'select_account');
    } else if (this.name === 'microsoft') {
      params.set('response_mode', 'query');
      params.set('prompt', 'select_account');
    }

    return {
      success: true,
      auth_url: `${this._authorizeEndpoint(config)}?${params.toString()}`,
      state,
    };
  }

  async _exchangeCode(code, redirectUri, statePayload, config) {
    const method = this._methodConfig(config);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: String(method.clientId),
      client_secret: String(method.clientSecret),
      code_verifier: statePayload.v,
    });
    const response = await fetch(this._tokenEndpoint(config), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      const providerError = String(data.error || '').slice(0, 80);
      const err = new Error('認証プロバイダーでのトークン交換に失敗しました。');
      err.status = 400;
      err.code = 'oauth_token_exchange_failed';
      err.providerError = providerError || undefined;
      throw err;
    }
    return data;
  }

  _decodeIdToken(idToken) {
    if (typeof idToken !== 'string') return null;
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    try {
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch (_) {
      return null;
    }
  }

  async _fetchUserInfo(accessToken, idToken, statePayload, config) {
    let info = null;
    try {
      const response = await fetch(this.userinfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
      if (response.ok) info = await response.json().catch(() => null);
    } catch (_) {
      info = null;
    }

    const idPayload = this._decodeIdToken(idToken);
    if (idPayload) {
      if (idPayload.nonce && statePayload.n && idPayload.nonce !== statePayload.n) {
        const err = new Error('認証応答の検証に失敗しました。もう一度ログインしてください。');
        err.status = 400;
        err.code = 'oauth_nonce_mismatch';
        throw err;
      }
      const audience = Array.isArray(idPayload.aud) ? idPayload.aud : [idPayload.aud];
      const method = this._methodConfig(config);
      if (idPayload.aud && !audience.includes(String(method.clientId))) {
        const err = new Error('認証応答の検証に失敗しました。もう一度ログインしてください。');
        err.status = 400;
        err.code = 'oauth_audience_mismatch';
        throw err;
      }
    }

    const merged = { ...(idPayload || {}), ...(info || {}) };
    const externalId = merged.sub || merged.oid || merged.id;
    if (!externalId) {
      const err = new Error('認証プロバイダーからユーザー情報を取得できませんでした。');
      err.status = 400;
      err.code = 'oauth_userinfo_failed';
      throw err;
    }

    const rawEmail = merged.email || merged.preferred_username || merged.upn || '';
    const email = typeof rawEmail === 'string' && rawEmail.includes('@') ? rawEmail.trim() : '';
    if (!email) {
      const err = new Error('認証プロバイダーのアカウントにメールアドレスが設定されていません。');
      err.status = 400;
      err.code = 'oauth_email_required';
      throw err;
    }
    if (merged.email_verified === false || merged.email_verified === 'false') {
      const err = new Error('メールアドレスが未確認のためログインできません。認証プロバイダーで確認を完了してください。');
      err.status = 403;
      err.code = 'oauth_email_unverified';
      throw err;
    }

    const name = String(merged.name || merged.display_name || merged.given_name || '').trim();
    return {
      externalId: String(externalId),
      email,
      name,
      picture: merged.picture || null,
      emailVerified: merged.email_verified !== false && merged.email_verified !== 'false',
    };
  }

  async verify(req, payload = {}, context = {}) {
    const { config } = context;

    if (payload.pending_token) {
      const pending = this._open(payload.pending_token, config);
      if (!pending || pending.t !== 'pending' || !pending.identity) {
        const err = new Error('認証の続行情報が無効か期限切れです。もう一度ログインしてください。');
        err.status = 400;
        err.code = 'oauth_pending_invalid';
        throw err;
      }
      return {
        success: true,
        identity: pending.identity,
        profile: pending.profile || null,
      };
    }

    const code = String(payload.code || '').trim();
    if (!code) {
      const err = new Error('認証コードが必要です。');
      err.status = 400;
      err.code = 'oauth_code_required';
      throw err;
    }
    if (code.length > 4096) {
      const err = new Error('認証コードが不正です。');
      err.status = 400;
      err.code = 'oauth_code_invalid';
      throw err;
    }

    const statePayload = this._open(payload.state, config);
    if (!statePayload || statePayload.p !== this.name || !statePayload.v || !statePayload.r) {
      const err = new Error('認証の状態を確認できませんでした。もう一度ログインしてください。');
      err.status = 400;
      err.code = 'oauth_state_invalid';
      throw err;
    }

    const tokenData = await this._exchangeCode(code, statePayload.r, statePayload, config);
    const user = await this._fetchUserInfo(tokenData.access_token, tokenData.id_token, statePayload, config);
    let providerDomain = null;
    try {
      providerDomain = new URL(`https://${user.email.split('@').pop()}`).hostname;
    } catch (_) {
      providerDomain = null;
    }

    return {
      success: true,
      identity: {
        authProvider: this.name,
        externalId: user.externalId,
        name: user.name,
        email: user.email,
        providerDomain,
      },
      profile: {
        sub: user.externalId,
        name: user.name,
        email: user.email,
        email_verified: user.emailVerified,
        picture: user.picture,
      },
    };
  }

  async _findExistingUser(db, providerName, providerUserId) {
    if (typeof db.findUserByAuthProvider === 'function') {
      return await db.findUserByAuthProvider(providerName, providerUserId);
    }
    if (typeof db.getUserByExternalId === 'function') {
      return await db.getUserByExternalId(providerName, providerUserId);
    }
    return null;
  }

  async resolveUser(db, authResult, context = {}) {
    const { identity, profile } = authResult;
    const providerName = identity.authProvider || this.name;
    const providerUserId = identity.externalId || identity.scid;
    const providedName = String(context.payload?.name || context.payload?.username || '').trim();

    if (providedName) {
      authResult.identity = { ...identity, name: providedName };
    } else {
      const existing = await this._findExistingUser(db, providerName, providerUserId);
      if (!existing) {
        const err = new Error('ユーザー名を設定してください。');
        err.status = 400;
        err.code = 'username_required';
        err.pendingToken = this._seal({
          p: this.name,
          t: 'pending',
          identity,
          profile: profile || null,
          exp: Date.now() + PENDING_TTL_MS,
        }, context.config || {});
        throw err;
      }
    }

    return await super.resolveUser(db, authResult, {
      ...context,
      payload: { ...(context.payload || {}), name: providedName || undefined },
    });
  }
}

module.exports = OAuth2ProviderBase;
