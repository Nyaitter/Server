const express = require('express');
const { authenticateKey } = require('../services/ExtensionKeyService');
const NyaitterAuthManager = require('../services/auth/NyaitterAuthManager');

const router = express.Router();

router.use(async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const token = req.get('x-nyaitter-extension-key');
    const extension = await authenticateKey(token, 'nyaitter-auth');
    if (!extension) return res.status(401).json({ error: '拡張APIキーが無効または失効しています。' });
    req.extension = extension;
    req.extensionToken = token;
    next();
  } catch {
    res.status(503).json({ error: '拡張APIキーの設定を読み取れません。' });
  }
});

function identity(req) {
  return { app_id: `extension:${req.extension.id}`, api_token: req.extensionToken, name: req.extension.name };
}

function sendError(res, error) {
  return res.status(error.status || 500).json({ error: error.status ? error.message : '拡張認証の処理に失敗しました。', code: error.code || undefined });
}

router.post('/nyaitter-auth/initiate', async (req, res) => {
  try {
    const body = req.body || {};
    let redirect;
    try { redirect = new URL(body.redirect_uri); } catch { return res.status(400).json({ error: '戻り先URLが無効です。' }); }
    if (!req.extension.redirectOrigins.includes(redirect.origin) || redirect.username || redirect.password) {
      return res.status(403).json({ error: 'この拡張キーに許可されていない戻り先です。' });
    }
    const scopes = body.scopes || [{ scope: 'profile:read', required: true }, { scope: 'continuous_access', required: true }];
    if (!Array.isArray(scopes) || scopes.some(scope => !['profile:read', 'storage:access', 'continuous_access'].includes(typeof scope === 'string' ? scope : scope?.scope))) {
      return res.status(400).json({ error: '許可されていない認証スコープです。' });
    }
    const manager = new NyaitterAuthManager({ dbAdapter: req.app.locals.dbAdapter });
    return res.json(await manager.createAuthorizationRequest({ ...identity(req), redirect_uri: redirect.href, state: body.state, scopes }, req));
  } catch (error) { return sendError(res, error); }
});

router.post('/nyaitter-auth/token', async (req, res) => {
  try {
    const manager = new NyaitterAuthManager({ dbAdapter: req.app.locals.dbAdapter });
    return res.json(await manager.exchangeCodeForToken({ ...identity(req), code: req.body?.code || req.body?.token }));
  } catch (error) { return sendError(res, error); }
});

router.post('/nyaitter-auth/userinfo', async (req, res) => {
  try {
    const manager = new NyaitterAuthManager({ dbAdapter: req.app.locals.dbAdapter });
    const token = /^Bearer (.+)$/i.exec(req.get('authorization') || '')?.[1];
    const grant = await manager.validateAccessToken(token);
    if (!grant || grant.appId !== identity(req).app_id || !grant.scopes.includes('profile:read')) {
      return res.status(401).json({ error: 'この拡張に対するユーザー認証が無効です。' });
    }
    const user = await req.app.locals.dbAdapter.getUserById(grant.userId);
    if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません。' });
    return res.json({ success: true, app_id: grant.appId, granted_scopes: grant.scopes, scopes: grant.scopes, token_type: 'app', user: {
      id: user.id, name: user.name, scid: user.scid || null, handle: user.handle || null,
      icon_data: user.icon_data || null, me: user.me || null, created_at: user.created_at || null, frozen: Boolean(user.frozen), account_operation: user.account_operation || null,
    } });
  } catch (error) { return sendError(res, error); }
});

module.exports = router;
