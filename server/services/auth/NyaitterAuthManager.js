'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const { getPublicUrl } = require('../../utils/nyaitterAddress');

const DATA_DIR = path.resolve(__dirname, '../../data');
const PENDING_STORE_FILE = path.join(DATA_DIR, 'nyaitter-auth-pending.json');

const STANDARD_SCOPES = {
  'profile:read': {
    id: 'profile:read',
    name: '基本情報の閲覧',
    description: 'ユーザー名、アイコン、Nyaitter ID、自己紹介などの基本情報を閲覧します。',
    defaultRequired: true,
  },
  'posts:read': {
    id: 'posts:read',
    name: 'タイムライン・ポストの閲覧',
    description: 'タイムライン、公開ポスト、返信を閲覧します。',
    defaultRequired: false,
  },
  'posts:write': {
    id: 'posts:write',
    name: 'ポストの投稿・リアクション',
    description: 'あなたのアカウントからポストの投稿、返信、いいね、リポスト等を行います。',
    defaultRequired: false,
  },
  'dm:read': {
    id: 'dm:read',
    name: 'ダイレクトメッセージの閲覧',
    description: 'DMメッセージを閲覧します。',
    defaultRequired: false,
  },
  'dm:write': {
    id: 'dm:write',
    name: 'ダイレクトメッセージの送信',
    description: 'あなたのアカウントからDMメッセージを送信します。',
    defaultRequired: false,
  },
  'notifications:read': {
    id: 'notifications:read',
    name: '通知の閲覧',
    description: '通知一覧を確認します。',
    defaultRequired: false,
  },
  'continuous_access': {
    id: 'continuous_access',
    name: '継続してアカウントにアクセス',
    description: 'アプリケーションがバックグラウンド等で継続してAPIにアクセスするための専用トークンを発行します。',
    defaultRequired: false,
  },
};

// Aliases for compatibility
STANDARD_SCOPES['offline_access'] = { ...STANDARD_SCOPES['continuous_access'], id: 'offline_access' };
STANDARD_SCOPES['read:profile'] = { ...STANDARD_SCOPES['profile:read'], id: 'read:profile' };
STANDARD_SCOPES['read:posts'] = { ...STANDARD_SCOPES['posts:read'], id: 'read:posts' };
STANDARD_SCOPES['write:posts'] = { ...STANDARD_SCOPES['posts:write'], id: 'write:posts' };
STANDARD_SCOPES['read:dm'] = { ...STANDARD_SCOPES['dm:read'], id: 'read:dm' };
STANDARD_SCOPES['write:dm'] = { ...STANDARD_SCOPES['dm:write'], id: 'write:dm' };
STANDARD_SCOPES['read:notifications'] = { ...STANDARD_SCOPES['notifications:read'], id: 'read:notifications' };

class NyaitterAuthManager {
  constructor({ dbAdapter = null } = {}) {
    this.db = dbAdapter;
  }

  // Static stores synchronized across detached processes via pending store file
  static pendingRequests = new Map(); // requestId -> requestData
  static pendingCodes = new Map(); // code -> approvedData

  static _loadPendingStore() {
    try {
      if (fs.existsSync(PENDING_STORE_FILE)) {
        const raw = fs.readFileSync(PENDING_STORE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.requests)) {
            for (const r of parsed.requests) {
              if (r && r.requestId) NyaitterAuthManager.pendingRequests.set(r.requestId, r);
            }
          }
          if (Array.isArray(parsed.codes)) {
            for (const c of parsed.codes) {
              if (c && c.code) NyaitterAuthManager.pendingCodes.set(c.code, c);
            }
          }
        }
      }
    } catch (_) {}
  }

  static _savePendingStore() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const data = {
        requests: Array.from(NyaitterAuthManager.pendingRequests.values()),
        codes: Array.from(NyaitterAuthManager.pendingCodes.values()),
      };
      fs.writeFileSync(PENDING_STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (_) {}
  }

  static _sweepExpired() {
    NyaitterAuthManager._loadPendingStore();
    const now = Date.now();
    let changed = false;
    for (const [key, value] of NyaitterAuthManager.pendingRequests.entries()) {
      if (value.expiresAt <= now) {
        NyaitterAuthManager.pendingRequests.delete(key);
        changed = true;
      }
    }
    for (const [key, value] of NyaitterAuthManager.pendingCodes.entries()) {
      if (value.expiresAt <= now) {
        NyaitterAuthManager.pendingCodes.delete(key);
        changed = true;
      }
    }
    if (changed) NyaitterAuthManager._savePendingStore();
  }

  static computeAppTokenHash(appId, apiToken) {
    return crypto.createHash('sha256').update(`${appId}:${apiToken}`).digest('hex');
  }

  normalizeRequestedScopes(scopes) {
    if (!Array.isArray(scopes) || scopes.length === 0) {
      return [
        { ...STANDARD_SCOPES['profile:read'], required: true },
        { ...STANDARD_SCOPES['posts:read'], required: false },
        { ...STANDARD_SCOPES['posts:write'], required: false },
        { ...STANDARD_SCOPES['continuous_access'], required: false },
      ];
    }

    const normalized = [];
    const seen = new Set();

    for (const item of scopes) {
      let scopeId = '';
      let scopeName = '';
      let scopeDesc = '';
      let required = false;

      if (typeof item === 'string') {
        scopeId = item.trim();
        const std = STANDARD_SCOPES[scopeId];
        scopeName = std?.name || scopeId;
        scopeDesc = std?.description || '';
        required = std?.defaultRequired || false;
      } else if (item && typeof item === 'object') {
        scopeId = String(item.scope || item.id || '').trim();
        const std = STANDARD_SCOPES[scopeId];
        scopeName = String(item.name || std?.name || scopeId);
        scopeDesc = String(item.description || std?.description || '');
        required = item.required !== undefined ? Boolean(item.required) : Boolean(std?.defaultRequired);
      }

      if (!scopeId || seen.has(scopeId)) continue;
      seen.add(scopeId);

      normalized.push({
        scope: scopeId,
        name: scopeName,
        description: scopeDesc,
        required,
      });
    }

    return normalized;
  }

  async createAuthorizationRequest(params = {}, req = null) {
    NyaitterAuthManager._sweepExpired();

    const appId = String(params.app_id || params.appId || params.client_id || '').trim();
    const apiToken = String(params.api_token || params.apiToken || params.client_secret || '').trim();
    const name = String(params.name || params.app_name || params.appName || '').trim();
    const iconUrl = params.icon_url || params.iconUrl || params.app_icon_url || null;
    const redirectUri = String(params.redirect_uri || params.redirectUri || '').trim();
    const state = params.state ? String(params.state) : null;
    const rawScopes = params.scopes || params.permissions || [];

    if (!appId) {
      const err = new Error('アプリケーションID (app_id) が必要です。');
      err.status = 400;
      throw err;
    }
    if (!apiToken) {
      const err = new Error('アプリケーションのAPIトークン (api_token) が必要です。');
      err.status = 400;
      throw err;
    }
    if (!name) {
      const err = new Error('アプリケーション名 (name) が必要です。');
      err.status = 400;
      throw err;
    }
    if (!redirectUri) {
      const err = new Error('リダイレクト先URL (redirect_uri) が必要です。');
      err.status = 400;
      throw err;
    }

    try {
      // Validate redirectUri format
      new URL(redirectUri);
    } catch (_) {
      const err = new Error('リダイレクト先URL (redirect_uri) の形式が無効です。');
      err.status = 400;
      throw err;
    }

    const appTokenHash = NyaitterAuthManager.computeAppTokenHash(appId, apiToken);
    const scopes = this.normalizeRequestedScopes(rawScopes);
    const requestId = 'req_' + crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes TTL

    const requestData = {
      requestId,
      appId,
      appTokenHash,
      name,
      iconUrl: iconUrl ? String(iconUrl) : null,
      redirectUri,
      scopes,
      state,
      createdAt: Date.now(),
      expiresAt,
    };

    NyaitterAuthManager._loadPendingStore();
    NyaitterAuthManager.pendingRequests.set(requestId, requestData);
    NyaitterAuthManager._savePendingStore();

    const baseUrl = req ? getPublicUrl(req) : (config.federation?.publicUrl || 'http://localhost:3000');
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
    const authUrl = `${normalizedBaseUrl}/#nyaitter-auth?request_id=${encodeURIComponent(requestId)}`;

    return {
      success: true,
      request_id: requestId,
      auth_url: authUrl,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  async getAuthorizationRequest(requestId, currentUserId = null, db = this.db) {
    NyaitterAuthManager._sweepExpired();

    const requestData = NyaitterAuthManager.pendingRequests.get(String(requestId));
    if (!requestData || requestData.expiresAt <= Date.now()) {
      const err = new Error('認証リクエストが見つからないか、有効期限が切れています。');
      err.status = 404;
      err.code = 'request_not_found';
      throw err;
    }

    let alreadyAuthorized = false;
    let existingScopes = [];

    if (currentUserId && db && typeof db.getAuthorizedAppByUserAndAppToken === 'function') {
      try {
        const existing = await db.getAuthorizedAppByUserAndAppToken(currentUserId, requestData.appId, requestData.appTokenHash);
        if (existing) {
          alreadyAuthorized = true;
          existingScopes = Array.isArray(existing.scopes) ? existing.scopes : [];
        }
      } catch (e) {
        console.warn('[nyaitter-auth] Failed to check existing authorized app:', e.message);
      }
    }

    // 権限の変更・追加差分（New Scopes）の計算
    const requestedScopes = Array.isArray(requestData.scopes) ? requestData.scopes : [];
    const newScopes = alreadyAuthorized
      ? requestedScopes.filter((s) => !existingScopes.includes(s.scope))
      : requestedScopes;
    const hasScopeChanges = alreadyAuthorized && newScopes.length > 0;
    const canPassThrough = alreadyAuthorized && newScopes.length === 0;

    return {
      request_id: requestData.requestId,
      app_id: requestData.appId,
      name: requestData.name,
      icon_url: requestData.iconUrl,
      redirect_uri: requestData.redirectUri,
      scopes: requestData.scopes,
      state: requestData.state,
      already_authorized: alreadyAuthorized,
      existing_scopes: existingScopes,
      has_scope_changes: hasScopeChanges,
      new_scopes: newScopes,
      can_pass_through: canPassThrough,
      expires_at: new Date(requestData.expiresAt).toISOString(),
    };
  }

  async checkUserGrant(userId, appId, appTokenHash, db = this.db) {
    if (!userId || !appId || !db || typeof db.getAuthorizedAppByUserAndAppToken !== 'function') {
      return { granted: false, scopes: [] };
    }
    try {
      const existing = await db.getAuthorizedAppByUserAndAppToken(userId, appId, appTokenHash);
      if (existing) {
        return {
          granted: true,
          scopes: Array.isArray(existing.scopes) ? existing.scopes : [],
          app_id: existing.app_id || appId,
          name: existing.name || '',
          authorized_at: existing.authorized_at || existing.created_at || null,
        };
      }
    } catch (e) {
      console.warn('[nyaitter-auth] Failed to checkUserGrant:', e.message);
    }
    return { granted: false, scopes: [] };
  }

  async approveAuthorization(requestId, userId, grantedScopes = [], db = this.db) {
    NyaitterAuthManager._sweepExpired();

    const requestData = NyaitterAuthManager.pendingRequests.get(String(requestId));
    if (!requestData || requestData.expiresAt <= Date.now()) {
      const err = new Error('認証リクエストが見つからないか、有効期限が切れています。');
      err.status = 404;
      throw err;
    }

    if (!userId) {
      const err = new Error('認証を完了するにはログインが必要です。');
      err.status = 401;
      throw err;
    }

    const requestedScopes = requestData.scopes || [];
    const grantedSet = new Set(Array.isArray(grantedScopes) ? grantedScopes : []);

    // Ensure all required scopes are granted
    for (const s of requestedScopes) {
      if (s.required && !grantedSet.has(s.scope)) {
        grantedSet.add(s.scope); // Auto-include required scope
      }
    }

    const finalGrantedScopes = Array.from(grantedSet);
    const hasContinuousAccess = finalGrantedScopes.includes('continuous_access') || finalGrantedScopes.includes('offline_access');

    let accessTokenId = null;
    let accessTokenHash = null;
    let fullAccessToken = null;

    if (hasContinuousAccess) {
      accessTokenId = crypto.randomBytes(16).toString('hex');
      const rawAccessToken = crypto.randomBytes(32).toString('hex');
      accessTokenHash = crypto.createHash('sha256').update(rawAccessToken).digest('hex');
      fullAccessToken = `nyauth_${accessTokenId}_${rawAccessToken}`;
    }

    // Upsert into authorized_apps table
    if (db && typeof db.createAuthorizedApp === 'function') {
      await db.createAuthorizedApp(
        userId,
        requestData.appId,
        requestData.appTokenHash,
        requestData.name,
        requestData.iconUrl,
        finalGrantedScopes,
        accessTokenId,
        accessTokenHash,
      );
    }

    // 承認ユーザーのスナップショット情報取得（プロセス分離時の確実な共有のため）
    let userSnapshot = null;
    if (db && typeof db.getUserById === 'function') {
      try {
        const u = await db.getUserById(userId);
        if (u) {
          userSnapshot = {
            id: u.id,
            username: u.username,
            name: u.name,
            admin: u.admin === true,
            icon_url: u.icon_url || null,
          };
        }
      } catch (_) {}
    }

    // Generate temporary one-time authorization code
    const code = 'authcode_' + crypto.randomBytes(32).toString('hex');
    const codeExpiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes TTL

    NyaitterAuthManager._loadPendingStore();
    NyaitterAuthManager.pendingCodes.set(code, {
      code,
      requestId: requestData.requestId,
      appId: requestData.appId,
      appTokenHash: requestData.appTokenHash,
      userId: Number(userId),
      user: userSnapshot,
      grantedScopes: finalGrantedScopes,
      accessToken: fullAccessToken,
      createdAt: Date.now(),
      expiresAt: codeExpiresAt,
    });

    // Remove pending request
    NyaitterAuthManager.pendingRequests.delete(requestId);
    NyaitterAuthManager._savePendingStore();

    // Build redirect URI
    const targetUrl = new URL(requestData.redirectUri);
    targetUrl.searchParams.set('token', code);
    targetUrl.searchParams.set('code', code);
    if (requestData.state) {
      targetUrl.searchParams.set('state', requestData.state);
    }

    return {
      success: true,
      redirect_uri: targetUrl.toString(),
      code,
    };
  }

  async denyAuthorization(requestId) {
    NyaitterAuthManager._sweepExpired();

    const requestData = NyaitterAuthManager.pendingRequests.get(String(requestId));
    if (!requestData) {
      const err = new Error('認証リクエストが見つかりません。');
      err.status = 404;
      throw err;
    }

    NyaitterAuthManager.pendingRequests.delete(requestId);

    const targetUrl = new URL(requestData.redirectUri);
    targetUrl.searchParams.set('error', 'access_denied');
    targetUrl.searchParams.set('error_description', 'ユーザーによってアクセスが拒否されました。');
    if (requestData.state) {
      targetUrl.searchParams.set('state', requestData.state);
    }

    return {
      success: true,
      redirect_uri: targetUrl.toString(),
    };
  }

  async exchangeCodeForToken(params = {}, db = this.db) {
    NyaitterAuthManager._sweepExpired();

    const appId = String(params.app_id || params.appId || params.client_id || '').trim();
    const apiToken = String(params.api_token || params.apiToken || params.client_secret || '').trim();
    const code = String(params.code || params.token || '').trim();

    if (!appId || !apiToken) {
      const err = new Error('アプリケーションIDとAPIトークンが必要です。');
      err.status = 400;
      throw err;
    }
    if (!code) {
      const err = new Error('認証コード (token / code) が必要です。');
      err.status = 400;
      throw err;
    }

    const approvedData = NyaitterAuthManager.pendingCodes.get(code);
    if (!approvedData || approvedData.expiresAt <= Date.now()) {
      const err = new Error('認証コードが無効か、有効期限が切れています。');
      err.status = 400;
      err.code = 'invalid_code';
      throw err;
    }

    const appTokenHash = NyaitterAuthManager.computeAppTokenHash(appId, apiToken);
    if (approvedData.appId !== appId || approvedData.appTokenHash !== appTokenHash) {
      const err = new Error('アプリケーションの認証情報が一致しません。');
      err.status = 401;
      err.code = 'invalid_credentials';
      throw err;
    }

    // Consume code (single-use)
    NyaitterAuthManager.pendingCodes.delete(code);

    let user = null;
    if (db && typeof db.getUserById === 'function') {
      user = await db.getUserById(approvedData.userId);
    }

    if (!user) {
      const err = new Error('ユーザーが見つかりません。');
      err.status = 404;
      throw err;
    }

    const responseData = {
      success: true,
      user: {
        id: user.id,
        name: user.name,
        scid: user.scid || null,
        handle: user.handle || null,
        icon_data: user.icon_data || null,
        me: user.me || null,
        created_at: user.created_at || null,
      },
      granted_scopes: approvedData.grantedScopes,
    };

    if (approvedData.accessToken) {
      responseData.access_token = approvedData.accessToken;
      responseData.token_type = 'Bearer';
    }

    return responseData;
  }

  async validateAccessToken(token, db = this.db) {
    if (!token || typeof token !== 'string' || !token.startsWith('nyauth_') || !db) {
      return null;
    }

    const withoutPrefix = token.slice('nyauth_'.length);
    const parts = withoutPrefix.split('_');
    if (parts.length !== 2) return null;

    const accessTokenId = parts[0];
    const rawAccessToken = parts[1];
    const tokenHash = crypto.createHash('sha256').update(rawAccessToken).digest('hex');

    if (typeof db.getAuthorizedAppByAccessTokenId !== 'function') return null;

    const record = await db.getAuthorizedAppByAccessTokenId(accessTokenId);
    if (!record || record.accessTokenHash !== tokenHash) return null;

    if (typeof db.updateAuthorizedAppLastUsed === 'function') {
      void db.updateAuthorizedAppLastUsed(record.id).catch(() => {});
    }

    return {
      id: record.id,
      userId: record.userId,
      appId: record.appId,
      appName: record.appName,
      scopes: Array.isArray(record.scopes) ? record.scopes : [],
    };
  }

  async getUserAuthorizedApps(userId, db = this.db) {
    if (!db || typeof db.getUserAuthorizedApps !== 'function') return [];
    const apps = await db.getUserAuthorizedApps(userId);
    return apps.map((app) => ({
      id: app.id,
      app_id: app.appId,
      app_name: app.appName,
      app_icon_url: app.appIconUrl,
      scopes: app.scopes,
      has_continuous_access: Boolean(app.accessTokenId),
      created_at: app.createdAt,
      last_used_at: app.lastUsedAt,
    }));
  }

  async updateAuthorizedAppScopes(id, userId, newScopes, db = this.db) {
    if (!db || typeof db.getAuthorizedAppById !== 'function' || typeof db.updateAuthorizedAppScopes !== 'function') {
      throw new Error('データベースが連携アプリ更新に対応していません');
    }

    const existing = await db.getAuthorizedAppById(id, userId);
    if (!existing) {
      const err = new Error('連携アプリが見つかりません。');
      err.status = 404;
      throw err;
    }

    const scopes = Array.isArray(newScopes) ? newScopes : [];
    const hasContinuousAccess = scopes.includes('continuous_access') || scopes.includes('offline_access');

    let accessTokenId = existing.accessTokenId;
    let accessTokenHash = existing.accessTokenHash;

    if (hasContinuousAccess && !accessTokenId) {
      accessTokenId = crypto.randomBytes(16).toString('hex');
      const rawToken = crypto.randomBytes(32).toString('hex');
      accessTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    } else if (!hasContinuousAccess && accessTokenId) {
      accessTokenId = null;
      accessTokenHash = null;
    }

    const updated = await db.updateAuthorizedAppScopes(id, userId, scopes, accessTokenId, accessTokenHash);
    return {
      id: updated.id,
      app_id: updated.appId,
      app_name: updated.appName,
      app_icon_url: updated.appIconUrl,
      scopes: updated.scopes,
      has_continuous_access: Boolean(updated.accessTokenId),
      updated_at: updated.updatedAt,
    };
  }

  async revokeAuthorizedApp(id, userId, db = this.db) {
    if (!db || typeof db.deleteAuthorizedApp !== 'function') {
      throw new Error('データベースが連携アプリ削除に対応していません');
    }
    const success = await db.deleteAuthorizedApp(id, userId);
    if (!success) {
      const err = new Error('連携アプリが見つからないか、既に削除されています。');
      err.status = 404;
      throw err;
    }
    return { success: true };
  }
}

module.exports = NyaitterAuthManager;
