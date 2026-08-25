'use strict';

const api = require('../utils/ApiRegistry');
const NyaitterAuthManager = require('../services/auth/NyaitterAuthManager');
const { requireAuth } = require('../middleware/auth');

const router = api.createRouter({
  tag: 'nyaitter-auth',
  basePath: '/nyaitter-auth',
  description: 'NyaitterAuth 外部連携・認可 API',
});

function getAuthManager(req) {
  return new NyaitterAuthManager({
    dbAdapter: req.app.locals.dbAdapter,
  });
}

// 1. Initiate authorization request (called by external app with its API credentials)
router.post({
  path: '/initiate',
  summary: '外部アプリによる認証リクエストの開始',
  auth: 'none',
}, async (req, res) => {
  try {
    const manager = getAuthManager(req);
    const result = await manager.createAuthorizationRequest(req.body, req);
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || '認証リクエストの作成に失敗しました。',
    });
  }
});

// 2. Get authorization request details (called by Nyaitter client on #nyaitter-auth)
router.get({
  path: '/requests/:requestId',
  summary: '認証リクエストの詳細取得',
  auth: 'optional',
}, async (req, res) => {
  try {
    const manager = getAuthManager(req);
    const currentUserId = req.user?.id || null;
    const result = await manager.getAuthorizationRequest(req.params.requestId, currentUserId, req.app.locals.dbAdapter);
    return res.json({
      success: true,
      request: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || '認証リクエストの取得に失敗しました。',
      code: error.code || undefined,
    });
  }
});

// 3. User approves authorization (requires user login)
router.post({
  path: '/approve',
  summary: 'ユーザーによるアプリ連携リクエストの承認',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const { request_id, granted_scopes } = req.body;
    if (!request_id) {
      return res.status(400).json({
        success: false,
        error: 'リクエストID (request_id) が必要です。',
      });
    }

    const manager = getAuthManager(req);
    const result = await manager.approveAuthorization(
      request_id,
      req.user.id,
      granted_scopes,
      req.app.locals.dbAdapter,
    );
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || '認証の承認に失敗しました。',
    });
  }
});

// 3.5 Auto pass-through for already-authorized apps without scope changes
router.post({
  path: '/auto-pass',
  summary: '許可済みアプリの自動パススルー承認',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const { request_id } = req.body;
    if (!request_id) {
      return res.status(400).json({ success: false, error: 'リクエストID (request_id) が必要です。' });
    }

    const manager = getAuthManager(req);
    const authReq = await manager.getAuthorizationRequest(request_id, req.user.id, req.app.locals.dbAdapter);

    if (!authReq.can_pass_through) {
      return res.status(400).json({
        success: false,
        error: '権限の変更または未許可の権限があるため、ユーザーの明示的な承認が必要です。',
        has_scope_changes: authReq.has_scope_changes,
        new_scopes: authReq.new_scopes,
      });
    }

    // 以前の許可済みスコープをそのまま適用して承認
    const result = await manager.approveAuthorization(
      request_id,
      req.user.id,
      authReq.existing_scopes,
      req.app.locals.dbAdapter,
    );
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || '自動パススルーに失敗しました。',
    });
  }
});

// 3.6 Check if application is already granted
router.get({
  path: '/check-grant',
  summary: 'アプリが許可済みかどうかの確認',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const { app_id, api_token, app_token_hash } = req.query;
    if (!app_id) {
      return res.status(400).json({ success: false, error: 'app_id が必要です。' });
    }

    const hash = app_token_hash || (api_token ? NyaitterAuthManager.computeAppTokenHash(app_id, api_token) : null);
    const manager = getAuthManager(req);
    const grant = await manager.checkUserGrant(req.user.id, app_id, hash, req.app.locals.dbAdapter);

    return res.json({ success: true, ...grant });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || '許可状態の取得に失敗しました。',
    });
  }
});

// 4. User denies authorization
router.post({
  path: '/deny',
  summary: 'ユーザーによるアプリ連携リクエストの拒否',
  auth: 'none',
}, async (req, res) => {
  try {
    const { request_id } = req.body;
    if (!request_id) {
      return res.status(400).json({
        success: false,
        error: 'リクエストID (request_id) が必要です。',
      });
    }

    const manager = getAuthManager(req);
    const result = await manager.denyAuthorization(request_id);
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || '認証の拒否処理に失敗しました。',
    });
  }
});

// 5. Exchange temporary token/code for user info & persistent access token (called by external app)
router.post({
  path: '/token',
  summary: '認可コードとアクセストークンの交換',
  auth: 'none',
}, async (req, res) => {
  try {
    const manager = getAuthManager(req);
    const result = await manager.exchangeCodeForToken(req.body, req.app.locals.dbAdapter);
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || 'トークンの検証・交換に失敗しました。',
      code: error.code || undefined,
    });
  }
});

// 6. Userinfo endpoint (called with Authorization: Bearer nyauth_...)
router.get({
  path: '/userinfo',
  summary: 'アクセストークンに紐づくユーザー情報とスコープの取得',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const db = req.app.locals.dbAdapter;
    const user = await db.getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'ユーザーが見つかりません。' });
    }
    return res.json({
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
      scopes: req.user.scopes || ['*'],
      app_id: req.user.appId || null,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'ユーザー情報の取得に失敗しました。',
    });
  }
});

// 7. Get user's authorized applications (Settings screen)
router.get({
  path: '/authorized-apps',
  summary: '連携中アプリケーション一覧の取得',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const manager = getAuthManager(req);
    const apps = await manager.getUserAuthorizedApps(req.user.id, req.app.locals.dbAdapter);
    return res.json({
      success: true,
      apps,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || '連携アプリ一覧の取得に失敗しました。',
    });
  }
});

// 8. Update authorized application scopes (Settings screen)
router.patch({
  path: '/authorized-apps/:id',
  summary: '連携アプリケーションのスコープ更新',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const manager = getAuthManager(req);
    const { scopes } = req.body;
    if (!Array.isArray(scopes)) {
      return res.status(400).json({
        success: false,
        error: 'scopes は配列である必要があります。',
      });
    }
    const updated = await manager.updateAuthorizedAppScopes(
      req.params.id,
      req.user.id,
      scopes,
      req.app.locals.dbAdapter,
    );
    return res.json({
      success: true,
      app: updated,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || '連携アプリの権限更新に失敗しました。',
    });
  }
});

// 9. Revoke authorized application (Settings screen)
router.delete({
  path: '/authorized-apps/:id',
  summary: '連携アプリケーションの連携解除',
  auth: 'required',
}, requireAuth, async (req, res) => {
  try {
    const manager = getAuthManager(req);
    const result = await manager.revokeAuthorizedApp(
      req.params.id,
      req.user.id,
      req.app.locals.dbAdapter,
    );
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || '連携アプリの解除に失敗しました。',
    });
  }
});

module.exports = router;
