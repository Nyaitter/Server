const express = require('express');
const crypto = require('crypto');
const {
  generateVerificationCode,
  verifyPendingCode,
  consumeVerificationCode,
} = require('../utils/scratchVerifier');

const { verifyScratchAccount } = require('../utils/scratchAccountVerifier');
const SessionManager = require('../services/auth/SessionManager');
const BotTokenManager = require('../services/auth/BotTokenManager');
const {
  getCookieValue,
  readRememberedAccounts,
  setRememberedAccountsCookie,
  rememberAccountSession,
  getValidRememberedAccounts,
} = require('../services/auth/RememberedAccountService');
const { requireAuth, requireAuthAllowFrozen, optionalAuth } = require('../middleware/auth');

const config = require('../config');
const { isWithinRange } = require('../utils/settingFormats');
const { serializeUser } = require('../utils/serialize');
const {
  isImposter,
  getImposterRole,
  canOperateImposter,
  listAccessibleImposters,
  listAccessibleImpostersForOperators,
  listOwnedImposters,
} = require('../services/ImposterService');
const {
  formatNyaitterId,
  getPublicUrl,
  getUserNyaitterId,
} = require('../utils/nyaitterAddress');
const {
  getRequestLoginMetadata,
  generateApprovalPollToken,
  hashApprovalPollToken,
  isUnknownLoginProtectionEnabled,
} = require('../services/auth/LoginSecurityService');
const AuthService = require('../services/auth/AuthService');
const { defaultRegistry: authProviderRegistry } = require('../services/auth/AuthProviderRegistry');
const { AccountRecoveryService } = require('../services/auth/AccountRecoveryService');
const { createNotificationIfAllowed } = require('../services/NotificationDeliveryService');

const api = require("../utils/ApiRegistry");
const router = api.createRouter({
	tag: "auth",
	basePath: "/auth",
	description: "認証・セッション・ログインセキュリティ API",
});
const authService = new AuthService({ registry: authProviderRegistry, config });

function getDbAdapter(req) {
  return req.app.locals.dbAdapter;
}

function isValidScratchUsername(username) {
  return (
    typeof username === 'string' &&
    /^[a-zA-Z0-9_-]+$/.test(username) &&
    isWithinRange(username.length, config.limits.scratchUsernameLength)
  );
}

function requireInteractiveSession(req, res, next) {
  if (req.user?.tokenType !== 'session') {
    return res.status(403).json({ error: 'この操作にはログイン済み端末のセッションが必要です。' });
  }
  return next();
}

async function verifyTurnstileToken(token) {
  const secret = config.turnstile?.secret;
  if (!secret) return { success: false, code: 'not_configured' };
  if (!token || typeof token !== 'string') {
    return { success: false, code: 'token_required' };
  }

  try {
    const formData = new URLSearchParams();
    formData.append('secret', secret);
    formData.append('response', token);

    const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
    });

    const data = await verifyRes.json();
    if (data?.success) return { success: true };
    console.warn('[turnstile] siteverify failed:', data);
    return {
      success: false,
      code: 'invalid',
      errorCodes: Array.isArray(data?.['error-codes']) ? data['error-codes'] : null,
    };
  } catch (error) {
    console.error('[turnstile] siteverify network error:', error);
    return { success: false, code: 'error', error };
  }
}

function serializeLoginUser(user, req) {
  return {
    id: user.id,
    nyaitter_id: getUserNyaitterId(user),
    name: user.name,
    icon_data: user.icon_data || null,
    scid: user.scid || null,
    handle: getUserNyaitterId(user),
    auth_provider: user.auth_provider,
    provider_domain: user.provider_domain || null,
    external_profile: user.external_profile || null,
    is_imposter: isImposter(user),
    admin: !!user.admin,
  };
}

function setSessionCookie(req, res, token, expiresAt) {
  const maxAge = expiresAt
    ? new Date(expiresAt).getTime() - Date.now()
    : 30 * 24 * 60 * 60 * 1000;
  const isProduction = (process.env.NODE_ENV || 'development') === 'production';
  const isSecure = isProduction || req.secure || req.get('x-forwarded-proto') === 'https';

  res.cookie('nyaitter_session', token, {
    httpOnly: true,
    secure: isSecure,
    path: '/',
    maxAge: Math.max(maxAge, 3600000),
    sameSite: 'lax',
  });
}

function clearSessionCookie(res) {
  res.clearCookie('nyaitter_session', { path: '/' });
}

function setAuthenticatedSessionCookies(req, res, session) {
  setSessionCookie(req, res, session.token, session.expiresAt);
  rememberAccountSession(req, res, session);
}

function maskedIpUuid(ip) {
  return crypto
    .createHash('sha256')
    .update(String(ip || ''))
    .digest('hex')
    .slice(0, 32);
}

async function recordLoginLog(db, scid, userId, ip) {
  try {
    if (db && typeof db.addLog === 'function') {
      await db.addLog({
        scratch_id: scid,
        nyaitter_id: userId,
        masked_ip_uuid: maskedIpUuid(ip),
      });
    }
  } catch (err) {
    console.warn('[auth] login log record failed:', err.message);
  }
}

async function publishLoginApprovalNotification(req, userId, approval) {
  await createNotificationIfAllowed(getDbAdapter(req), {
    userId,
    type: 'login_approval',
    fromUserId: null,
    target: { kind: 'route', value: `#login-approval/${approval.id}` },
  });
}

async function createAuthenticatedSession(req, res, user, metadata) {
  const db = getDbAdapter(req);
  const sessionManager = new SessionManager({ dbAdapter: db });
  const session = await sessionManager.createSession(user.id, metadata);
  setAuthenticatedSessionCookies(req, res, session);
  await recordLoginLog(db, user.scid || user.handle || '', user.id, req.ip);
  return session;
}

function getAccountRecoveryService(req) {
  return new AccountRecoveryService({
    db: getDbAdapter(req),
    config: config.auth,
    registry: authProviderRegistry,
  });
}

async function beginProtectedLogin(req, res, user, provider = null) {
  const db = getDbAdapter(req);
  const metadata = getRequestLoginMetadata(req);

  // 復旧依頼をブロックした場所からの再ログインは、信頼済み判定より前に恒久的に拒否する。
  if (typeof db.getBlockedLoginIp === 'function') {
    const blocked = await db.getBlockedLoginIp(user.id, metadata.ipHash);
    if (blocked) {
      return { kind: 'blocked' };
    }
  }

  const protectionEnabled = isUnknownLoginProtectionEnabled(user);
  const trusted = await db.getTrustedLoginIp(user.id, metadata.ipHash);
  const trustedIpCount = await db.countTrustedLoginIps(user.id);
  const existingSessions = trustedIpCount === 0 ? await db.getUserSessions(user.id) : [];

  // 初回ログインには通知を受け取る既存端末がないため、認証済みの初回ログインIPを信頼済みにする。
  // 既存セッションがある利用者は、信頼IPがまだ未記録でも承認を求める。
  if (!protectionEnabled || trusted || (trustedIpCount === 0 && existingSessions.length === 0)) {
    if (!trusted) await db.trustLoginIp(user.id, metadata);
    const session = await createAuthenticatedSession(req, res, user, metadata);
    return { kind: 'authenticated', session };
  }

  const pollToken = generateApprovalPollToken();
  const approval = await db.createLoginApproval({
    userId: user.id,
    ipHash: metadata.ipHash,
    ipMasked: metadata.ipMasked,
    userAgent: metadata.userAgent,
    authProvider: provider ? String(provider).toLowerCase() : null,
    pollTokenHash: hashApprovalPollToken(pollToken),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  await publishLoginApprovalNotification(req, user.id, approval);
  return { kind: 'approval_required', approval, pollToken };
}

function sendLoginResult(req, res, user, result, { external = false } = {}) {
  if (result.kind === 'blocked') {
    return res.status(403).json({
      success: false,
      code: 'login_ip_blocked',
      message: 'この場所からのログインは恒久的にブロックされています。別のネットワークからログインし、設定の「ブロックしたIPアドレス」一覧から解除してください。解除できない場合は認証プロバイダー側で措置を行ってください。',
    });
  }

  if (result.kind === 'approval_required') {
    return res.status(202).json({
      success: false,
      approval_required: true,
      approval_id: result.approval.id,
      approval_token: result.pollToken,
      expires_at: result.approval.expiresAt,
      account_recovery_enabled: getAccountRecoveryService(req).recoveryConfig.enabled,
      message: 'この場所からのログインには、ログイン済み端末での許可が必要です。',
    });
  }

  const session = result.session;
	return res.json({
		success: true,
		expires_at: session.expiresAt,
		user: serializeLoginUser(user, req),
		...(external ? { note: 'Logged in via external Nyaitter server. Profile was inherited from the external instance.' } : {}),
	});
}

/**
 * GET /server/auth/providers
 * 利用可能な認証プロバイダーの一覧と設定を返す
 */
router.get({
	path: '/providers',
	summary: '有効な認証プロバイダー一覧の取得',
	auth: 'none',
}, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    providers: authService.getPublicProviders(req),
  });
});

/**
 * POST /server/auth/:provider/initiate
 * 任意の認証プロバイダーの認証開始
 */
router.post({
	path: '/:provider/initiate',
	summary: '外部認証プロバイダーによるログイン開始',
	auth: 'none',
}, async (req, res) => {
  const provider = String(req.params.provider || '').toLowerCase();
  try {
    const data = await authService.initiate(provider, req, req.body, {
      config,
      verifyTurnstile: verifyTurnstileToken,
    });
    res.json(data);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      error: error.message || '認証の開始に失敗しました。',
      code: error.code || undefined,
    });
  }
});

/**
 * POST /server/auth/:provider/verify
 * 任意の認証プロバイダーの検証とログイン処理
 */
router.post({
	path: '/:provider/verify',
	summary: '外部認証プロバイダーによるログイン完了検証',
	auth: 'none',
}, async (req, res) => {
  const provider = String(req.params.provider || '').toLowerCase();
  const db = getDbAdapter(req);
  try {
    const { user } = await authService.verifyAndResolveUser(provider, req, req.body, {
      config,
      db,
      payload: req.body,
      req,
      verifyTurnstile: verifyTurnstileToken,
    });

    const result = await beginProtectedLogin(req, res, user, provider);
    if (result.kind === 'authenticated') {
      console.log(`[auth] ${provider}認証成功: ${user.name} (userId=${user.id})`);
    }
    return sendLoginResult(req, res, user, result);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      error: error.message || '認証に失敗しました。',
      code: error.code || undefined,
      ...(error.pendingToken ? { pending_token: error.pendingToken } : {}),
    });
  }
});

/**
 * GET /server/auth/linked-providers
 * ログイン中ユーザーに紐づけられている認証プロバイダー一覧を取得
 */
router.get({
	path: '/linked-providers',
	summary: '連携済み外部アカウント一覧の取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (isImposter(req.user)) {
    return res.json({ linked_providers: [] });
  }
  const db = getDbAdapter(req);
  try {
    const providers = await authService.getLinkedProviders(req.user.id, db);
    res.json({
      linked_providers: providers,
    });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      error: error.message || '連携済み認証方式の取得に失敗しました。',
      code: error.code || undefined,
    });
  }
});

/**
 * POST /server/auth/link/:provider/initiate
 * 既存アカウントへの新しい認証プロバイダー紐づけ認証を開始
 */
router.post({
	path: '/link/:provider/initiate',
	summary: '外部認証プロバイダー連携の開始',
	auth: 'required',
}, requireAuth, async (req, res) => {
  if (isImposter(req.user)) {
    return res.status(403).json({ error: 'インポスターアカウントでは認証プロバイダーの連携を行えません。' });
  }
  const provider = String(req.params.provider || '').toLowerCase();
  try {
    const data = await authService.initiate(provider, req, req.body, {
      config,
      verifyTurnstile: verifyTurnstileToken,
    });
    res.json(data);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      error: error.message || '認証の開始に失敗しました。',
      code: error.code || undefined,
    });
  }
});

/**
 * POST /server/auth/link/:provider/verify
 * 既存アカウントへ新しい認証プロバイダーを紐づけ
 */
router.post({
	path: '/link/:provider/verify',
	summary: '外部認証プロバイダー連携の完了',
	auth: 'required',
}, requireAuth, async (req, res) => {
  if (isImposter(req.user)) {
    return res.status(403).json({ error: 'インポスターアカウントでは認証プロバイダーの連携を行えません。' });
  }
  const provider = String(req.params.provider || '').toLowerCase();
  const db = getDbAdapter(req);
  try {
    const result = await authService.linkProvider(provider, req.user.id, req, req.body, {
      config,
      db,
      verifyTurnstile: verifyTurnstileToken,
    });
    res.json({
      success: true,
      message: '認証方法の紐づけが完了しました。',
      linked_provider: result.linkedProvider,
    });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      error: error.message || '認証方法の紐づけに失敗しました。',
      code: error.code || undefined,
    });
  }
});

/**
 * DELETE /server/auth/link/:provider
 * 既存アカウントから認証プロバイダーの紐づけを解除
 */
router.delete({
	path: '/link/:provider',
	summary: '外部認証プロバイダー連携の解除',
	auth: 'required',
}, requireAuth, async (req, res) => {
  if (isImposter(req.user)) {
    return res.status(403).json({ error: 'インポスターアカウントでは認証プロバイダーの連携を行えません。' });
  }
  const provider = String(req.params.provider || '').toLowerCase();
  const providerUserId = req.body?.provider_user_id || req.query?.provider_user_id || null;
  const db = getDbAdapter(req);
  try {
    await authService.unlinkProvider(provider, req.user.id, db, providerUserId);
    res.json({
      success: true,
      message: '認証方法の連携を解除しました。',
    });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      error: error.message || '認証方法の連携解除に失敗しました。',
      code: error.code || undefined,
    });
  }
});

router.post({
	path: '/scratch/generate',
	summary: 'Scratch 認証用確認コードの生成',
	auth: 'none',
}, async (req, res) => {
  try {
    const data = await authService.initiate('scratch', req, {
      username: req.body?.username,
      turnstile_token: req.body?.turnstile_token,
    }, {
      config,
      verifyTurnstile: verifyTurnstileToken,
    });
    res.json(data);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      error: error.message || 'コードの生成に失敗しました。',
      code: error.code || undefined,
    });
  }
});

router.post({
	path: '/scratch/verify',
	summary: 'Scratch プロフィール認証コードの検証とログイン',
	auth: 'none',
}, async (req, res) => {
  const db = getDbAdapter(req);
  try {
    const { user } = await authService.verifyAndResolveUser('scratch', req, {
      username: req.body?.username,
      code: req.body?.code,
      turnstile_token: req.body?.turnstile_token,
    }, {
      config,
      db,
      payload: req.body,
      req,
      verifyTurnstile: verifyTurnstileToken,
    });

    const result = await beginProtectedLogin(req, res, user, 'scratch');
    if (result.kind === 'authenticated') {
      console.log(`[auth] Scratch認証成功: ${user.scid || user.name} (userId=${user.id})`);
    }
    return sendLoginResult(req, res, user, result);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      error: error.message || '認証に失敗しました。',
      code: error.code || undefined,
    });
  }
});

/**
 * POST /server/auth/login-approvals/:approvalId/poll
 * 未承認端末が短命の承認トークンで状態を照合する。許可済みかつ同一IPの時だけセッションを発行する。
 */
router.post({
	path: '/login-approvals/:approvalId/poll',
	summary: 'ログイン承認リクエストのポーリング待機',
	auth: 'none',
}, async (req, res) => {
  const approvalId = String(req.params.approvalId || '');
  const pollToken = String(req.body?.approval_token || '');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(approvalId) || !/^[A-Za-z0-9_-]{20,128}$/.test(pollToken)) {
    return res.status(400).json({ error: '承認情報が無効です。ログインを最初からやり直してください。' });
  }

  const db = getDbAdapter(req);
  const approval = await db.getLoginApprovalByPollToken(approvalId, hashApprovalPollToken(pollToken));
  if (!approval) {
    return res.status(404).json({ error: '承認待ちログインが見つかりません。' });
  }
  if (approval.status === 'pending') {
    return res.status(202).json({ success: false, approval_required: true, pending: true, expires_at: approval.expiresAt });
  }
  if (approval.status !== 'approved') {
    return res.status(403).json({ error: 'このログインは許可されなかったか、期限切れです。' });
  }

  const metadata = getRequestLoginMetadata(req);
  if (metadata.ipHash !== approval.ipHash) {
    return res.status(403).json({ error: 'ログイン要求時と異なるIPアドレスから承認を完了することはできません。' });
  }

  const consumed = await db.consumeLoginApproval(approval.id, hashApprovalPollToken(pollToken));
  if (!consumed) {
    return res.status(409).json({ error: 'この承認は既に使用されたか、期限切れです。' });
  }
  const user = await db.getUserById(approval.userId);
  if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません。' });

  await db.trustLoginIp(user.id, metadata);
  const session = await createAuthenticatedSession(req, res, user, metadata);
	return res.json({
		success: true,
		expires_at: session.expiresAt,
		user: serializeLoginUser(user, req),
	});
});

router.get({
	path: '/me',
	summary: 'ログイン中ユーザー情報・セッション情報の取得',
	auth: 'required',
}, requireAuthAllowFrozen, async (req, res) => {
  const db = getDbAdapter(req);
  // 認証ミドルウェアが取得済みの完全なユーザー行を使う。principalは認可用の
  // 最小情報だけなので、そのままシリアライズするとプロフィールと設定が欠落する。
  const user = req.user?.visibilityUser || await db.getUserById(req.user.id);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  // 設定・リアクション・プロフィールを含む本人専用の状態は、ETagの304や
  // ブラウザキャッシュから古い値を再利用させない。
  res.set('Cache-Control', 'no-store, private');
  res.json({
    user: await serializeUser(db, user, req.user.id, getPublicUrl(req)),
    isBot: req.user.isBot || false,
    tokenType: req.user.tokenType,
  });
});

function serializeLoginApprovalForOwner(approval) {
  if (!approval) return null;
  return {
    id: approval.id,
    ip_masked: approval.ipMasked,
    user_agent: approval.userAgent,
    status: approval.status,
    created_at: approval.createdAt,
    expires_at: approval.expiresAt,
    decided_at: approval.decidedAt || null,
  };
}

/**
 * GET /server/auth/login-approvals/:approvalId
 * ログイン済み端末が未知IPログイン承認依頼を表示する。
 */
router.get({
	path: '/login-approvals/:approvalId',
	summary: 'ログイン承認リクエストの詳細取得',
	auth: 'session',
}, requireAuth, requireInteractiveSession, async (req, res) => {
  const db = getDbAdapter(req);
  const approval = await db.getLoginApproval(req.params.approvalId);
  if (!approval || Number(approval.userId) !== Number(req.user.id)) {
    return res.status(404).json({ error: 'ログイン承認依頼が見つかりません。' });
  }
  return res.json({ approval: serializeLoginApprovalForOwner(approval) });
});

/**
 * POST /server/auth/login-approvals/:approvalId/decision
 * 未知IPログインを許可または拒否する。許可時だけIPを信頼済みにする。
 */
router.post({
	path: '/login-approvals/:approvalId/decision',
	summary: 'ログイン承認リクエストへの承認・拒否',
	auth: 'session',
}, requireAuth, requireInteractiveSession, async (req, res) => {
  const decision = req.body?.decision;
  if (!['approve', 'deny'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approve or deny' });
  }
  const db = getDbAdapter(req);
  const approval = await db.decideLoginApproval(req.user.id, req.params.approvalId, decision);
  if (!approval) return res.status(404).json({ error: 'ログイン承認依頼が見つかりません。' });
  if (approval.status === 'approved') {
    await db.trustLoginIp(req.user.id, { ipHash: approval.ipHash, ipMasked: approval.ipMasked });
  }
  return res.json({ success: true, approval: serializeLoginApprovalForOwner(approval) });
});

function serializeAccountRecoveryForOwner(request, service, currentIpHash = null) {
  if (!request) return null;
  const provider = service.describeProvider(request.authProvider);
  return {
    id: request.id,
    ip_masked: request.ipMasked,
    user_agent: request.userAgent,
    auth_provider: provider.name,
    auth_provider_display_name: provider.displayName,
    status: request.status,
    trust_score: request.trustScore,
    wait_until: request.waitUntil,
    started_at: request.startedAt,
    decided_at: request.decidedAt || null,
    decided_by: request.decidedBy || null,
    // ブロックは恒久措置なので、依頼元が自分の現在のIPと同一なら警告できる材料を渡す。
    is_your_current_ip: Boolean(currentIpHash && request.ipHash && request.ipHash === currentIpHash),
  };
}

/**
 * POST /server/auth/account-recovery/start
 * 締め出された端末が、未承認ログインの承認トークンを使ってアクセス復旧を開始する。
 * ユーザーの状態から信頼度を算出し、信頼度に応じた待機期間を設定する。
 */
router.post({
	path: '/account-recovery/start',
	summary: '不明な場所からのアカウントアクセス復旧の開始',
	auth: 'none',
}, async (req, res) => {
  const approvalId = String(req.body?.approval_id || '');
  const approvalToken = String(req.body?.approval_token || '');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(approvalId) || !/^[A-Za-z0-9_-]{20,128}$/.test(approvalToken)) {
    return res.status(400).json({ error: '承認情報が無効です。ログインを最初からやり直してください。' });
  }

  const db = getDbAdapter(req);
  const approval = await db.getLoginApprovalByPollToken(approvalId, hashApprovalPollToken(approvalToken));
  if (!approval) {
    return res.status(404).json({ error: '承認待ちログインが見つかりません。' });
  }
  if (approval.status !== 'pending') {
    return res.status(409).json({ error: 'このログイン承認は既に処理済みか、期限切れです。' });
  }

  const metadata = getRequestLoginMetadata(req);
  if (metadata.ipHash !== approval.ipHash) {
    return res.status(403).json({ error: 'ログイン要求時と異なるIPアドレスから復旧を開始することはできません。' });
  }

  const user = await db.getUserById(approval.userId);
  if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません。' });

  const service = getAccountRecoveryService(req);
  try {
    const { request, token, resumed } = await service.startRecovery({ user, metadata, approval });
    if (!resumed) {
      await service.publishNotification(request);
    }
    return res.status(resumed ? 200 : 201).json({
      success: true,
      resumed,
      recovery_id: request.id,
      recovery_token: token,
      status: request.status,
      wait_until: request.waitUntil,
    });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({
      error: error.message || '復旧の開始に失敗しました。',
      code: error.code || undefined,
    });
  }
});

/**
 * POST /server/auth/account-recovery/:recoveryId/poll
 * 復旧依頼の要求元が待機期間の経過・承認・ブロックを照合する。
 * 承認済みかつ同一IPの時だけセッションを発行する。
 */
router.post({
	path: '/account-recovery/:recoveryId/poll',
	summary: 'アカウントアクセス復旧のポーリング待機',
	auth: 'none',
}, async (req, res) => {
  const recoveryId = String(req.params.recoveryId || '');
  const token = String(req.body?.recovery_token || '');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(recoveryId) || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) {
    return res.status(400).json({ error: '復旧情報が無効です。ログインを最初からやり直してください。' });
  }

  const db = getDbAdapter(req);
  const service = getAccountRecoveryService(req);
  const metadata = getRequestLoginMetadata(req);
  const result = await service.resolvePoll({ requestId: recoveryId, token, metadata });

  if (result.status === 'invalid') {
    return res.status(404).json({ error: '復旧依頼が見つかりません。' });
  }
  if (result.status === 'ip_mismatch') {
    return res.status(403).json({ error: '復旧を開始した場所と異なるIPアドレスです。' });
  }
  if (result.status === 'pending') {
    return res.status(202).json({
      success: false,
      pending: true,
      status: 'waiting',
      wait_until: result.request.waitUntil,
    });
  }
  if (result.status === 'blocked') {
    return res.status(403).json({
      success: false,
      status: 'blocked',
      error: 'この復旧依頼はブロックされました。心当たりがない場合は、認証プロバイダー側で措置を行ってください。',
    });
  }
  if (result.status === 'consumed') {
    return res.status(409).json({ success: false, status: 'consumed', error: 'この復旧は既に使用されています。' });
  }
  if (result.status !== 'approved') {
    return res.status(403).json({ success: false, status: result.status, error: 'この復旧依頼は利用できません。' });
  }

  const consumed = await db.consumeAccountRecoveryRequest(result.request.id, hashApprovalPollToken(token));
  if (!consumed) {
    return res.status(409).json({ error: 'この復旧は既に使用されたか、利用できません。' });
  }
  const user = await db.getUserById(result.request.userId);
  if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません。' });

  await db.trustLoginIp(user.id, metadata);
  const session = await createAuthenticatedSession(req, res, user, metadata);
  return res.json({
    success: true,
    expires_at: session.expiresAt,
    user: serializeLoginUser(user, req),
  });
});

/**
 * GET /server/auth/account-recovery/:recoveryId
 * ログイン済み端末が復旧依頼の詳細を表示する。
 */
router.get({
	path: '/account-recovery/:recoveryId',
	summary: 'アカウントアクセス復旧依頼の詳細取得',
	auth: 'session',
}, requireAuth, requireInteractiveSession, async (req, res) => {
  const db = getDbAdapter(req);
  const request = await db.getAccountRecoveryRequest(req.params.recoveryId);
  if (!request || Number(request.userId) !== Number(req.user.id)) {
    return res.status(404).json({ error: '復旧依頼が見つかりません。' });
  }
  const service = getAccountRecoveryService(req);
  return res.json({ recovery: serializeAccountRecoveryForOwner(request, service, getRequestLoginMetadata(req).ipHash) });
});

/**
 * POST /server/auth/account-recovery/:recoveryId/decision
 * 復旧依頼を承認またはブロックする。ブロック時は、ログイン方法が2つ以上あるときだけ
 * 侵害されたプロバイダーの連携を解除し、要求元IPを恒久的にブロックする。
 */
router.post({
	path: '/account-recovery/:recoveryId/decision',
	summary: 'アカウントアクセス復旧依頼への承認・ブロック',
	auth: 'session',
}, requireAuth, requireInteractiveSession, async (req, res) => {
  const decision = req.body?.decision;
  if (!['approve', 'block'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approve or block' });
  }
  const decisionMetadata = getRequestLoginMetadata(req);
  const service = getAccountRecoveryService(req);
  const request = await service.decideRecovery({
    user: req.user,
    requestId: req.params.recoveryId,
    decision,
  });
  if (!request) return res.status(404).json({ error: '復旧依頼が見つかりません。' });

  const payload = {
    success: true,
    recovery: serializeAccountRecoveryForOwner(request, service, decisionMetadata.ipHash),
  };
  if (request.revokedProvider) {
    payload.provider_revoked = request.revokedProvider.revoked === true;
    payload.remaining_providers = request.revokedProvider.remainingProviders || null;
  }
  // 自分の現在のIPを恒久ブロックすると、この端末から再ログインできなくなる可能性がある。
  if (payload.recovery?.is_your_current_ip) payload.current_ip_blocked = true;
  return res.json(payload);
});

/**
 * GET /server/auth/blocked-ips
 * 復旧依頼のブロックで恒久的に遮断したIPを一覧する。
 * ip_hash はサーバー側ソルトのHMACなので元IPを復元できず、本人以外には使えない。
 */
router.get({
	path: '/blocked-ips',
	summary: 'ログインを恒久ブロックしたIP一覧',
	auth: 'session',
}, requireAuth, requireInteractiveSession, async (req, res) => {
  if (isImposter(req.user)) {
    return res.status(403).json({ error: 'インポスターアカウントではブロックされたIPを管理できません。' });
  }
  const db = getDbAdapter(req);
  if (typeof db.listBlockedLoginIps !== 'function') return res.json({ blocked_ips: [] });
  const currentIpHash = getRequestLoginMetadata(req).ipHash;
  const records = await db.listBlockedLoginIps(req.user.id);
  res.set('Cache-Control', 'no-store');
  return res.json({
    blocked_ips: (records || []).map((record) => ({
      ip_hash: record.ipHash,
      ip_masked: record.ipMasked || '不明なIPアドレス',
      reason: record.reason || null,
      source_recovery_id: record.sourceRecoveryId || null,
      created_at: record.createdAt || null,
      is_current_ip: Boolean(record.ipHash) && record.ipHash === currentIpHash,
    })),
  });
});

/**
 * DELETE /server/auth/blocked-ips/:ipHash
 * 誤ってブロックしたIPの遮断を解除する。恒久ブロックには有効期限がないため、
 * この経路がないと別の端末からログインできない場合に自己回復手段がなくなる。
 */
router.delete({
	path: '/blocked-ips/:ipHash',
	summary: '恒久ブロックしたIPの解除',
	auth: 'session',
}, requireAuth, requireInteractiveSession, async (req, res) => {
  if (isImposter(req.user)) {
    return res.status(403).json({ error: 'インポスターアカウントではブロックされたIPを管理できません。' });
  }
  const ipHash = String(req.params.ipHash || '');
  if (!/^[a-f0-9]{64}$/i.test(ipHash)) {
    return res.status(400).json({ error: 'IPアドレスの識別子が無効です。' });
  }
  const db = getDbAdapter(req);
  if (typeof db.unblockLoginIp !== 'function') {
    return res.status(501).json({ error: 'この環境ではブロックの解除を利用できません。' });
  }
  const removed = await db.unblockLoginIp(req.user.id, ipHash);
  if (!removed) return res.status(404).json({ error: 'ブロックされたIPが見つかりません。' });
  res.set('Cache-Control', 'no-store');
  return res.json({ success: true });
});

function serializeSessionForOwner(session, currentToken) {
  const currentTokenHash = currentToken ? SessionManager.hashToken(currentToken) : null;
  return {
    id: session.id,
    ip_masked: session.ipMasked || '旧セッション',
    user_agent: session.userAgent || '不明な端末',
    created_at: session.createdAt,
    expires_at: session.expiresAt,
    current: Boolean(currentTokenHash && session.token === currentTokenHash),
    can_revoke_trust: Boolean(session.ipHash),
	  };
	}

	/**
	 * POST /server/auth/login-security/trust-current-ip
 * 未知IP拒否を有効化する現在のログイン端末を信頼済みIPとして登録する。
 */
router.post({
	path: '/login-security/trust-current-ip',
	summary: '現在のIPアドレスを信頼済みIPとして登録',
	auth: 'session',
}, requireAuth, requireInteractiveSession, async (req, res) => {
  if (isImposter(req.user)) {
    return res.status(403).json({ error: 'インポスターアカウントではこの操作を行えません。' });
  }
  const db = getDbAdapter(req);
  const metadata = getRequestLoginMetadata(req);
  await db.trustLoginIp(req.user.id, metadata);
  return res.json({ success: true, ip_masked: metadata.ipMasked });
});

/**
 * GET /server/auth/sessions
 * 現在有効なセッションを、トークンや生IPを露出せずに返す。
 */
router.get({
	path: '/sessions',
	summary: 'アクティブなログインセッション一覧の取得',
	auth: 'session',
}, requireAuth, requireInteractiveSession, async (req, res) => {
  if (isImposter(req.user)) {
    return res.json({ sessions: [] });
  }
  const db = getDbAdapter(req);
  const currentToken = getCookieValue(req, 'nyaitter_session');
  const sessions = await db.getUserSessions(req.user.id);
  res.set('Cache-Control', 'no-store');
  return res.json({ sessions: sessions.map((session) => serializeSessionForOwner(session, currentToken)) });
});

/**
 * DELETE /server/auth/sessions/:sessionId
 * 自分の指定セッションだけを無効化する。現在のセッションの場合はCookieも解除する。
 */
router.delete({
	path: '/sessions/:sessionId',
	summary: '指定したログインセッションの切断',
	auth: 'session',
}, requireAuth, requireInteractiveSession, async (req, res) => {
  if (isImposter(req.user)) {
    return res.status(403).json({ error: 'インポスターアカウントではセッションの管理を行えません。' });
  }
  const db = getDbAdapter(req);
  let targetToken;
  if (typeof db.invalidateUserSessionById === 'function') {
    targetToken = await db.invalidateUserSessionById(req.user.id, req.params.sessionId);
    if (!targetToken) return res.status(404).json({ error: 'セッションが見つかりません。' });
  } else {
    const sessions = await db.getUserSessions(req.user.id);
    const target = sessions.find((session) => session.id === req.params.sessionId);
    if (!target) return res.status(404).json({ error: 'セッションが見つかりません。' });
    targetToken = target.token;
    await db.invalidateSession(targetToken);
  }

  const currentToken = getCookieValue(req, 'nyaitter_session');
  const remaining = readRememberedAccounts(req)
    .filter((account) => SessionManager.hashToken(account.token) !== targetToken);
  setRememberedAccountsCookie(res, remaining);
  const activeRemoved = Boolean(currentToken && SessionManager.hashToken(currentToken) === targetToken);
  if (activeRemoved) clearSessionCookie(res);
  res.set('Cache-Control', 'no-store');
  return res.json({ success: true, invalidated: 1, active_removed: activeRemoved });
});

/**
 * POST /server/auth/sessions/:sessionId/revoke-ip
 * 対象セッションと同一IPの全セッションを無効化し、そのIPを未知IPへ戻す。
 */
router.post({
	path: '/sessions/:sessionId/revoke-ip',
	summary: 'セッションに紐づくIPアドレスの信頼解除',
	auth: 'session',
}, requireAuth, requireInteractiveSession, async (req, res) => {
  if (isImposter(req.user)) {
    return res.status(403).json({ error: 'インポスターアカウントではセッションの管理を行えません。' });
  }
  const db = getDbAdapter(req);
  let affectedTokens;
  let revokedTrust;
  let invalidated;
  if (typeof db.revokeUserSessionsBySessionId === 'function') {
    const result = await db.revokeUserSessionsBySessionId(req.user.id, req.params.sessionId);
    if (!result.found) return res.status(404).json({ error: 'セッションが見つかりません。' });
    if (!result.ipHash) return res.status(409).json({ error: '旧セッションのため、このIPの信頼を取り消せません。' });
    affectedTokens = result.tokens;
    revokedTrust = result.trustRevoked;
    invalidated = result.invalidated;
  } else {
    const sessions = await db.getUserSessions(req.user.id);
    const target = sessions.find((session) => session.id === req.params.sessionId);
    if (!target) return res.status(404).json({ error: 'セッションが見つかりません。' });
    if (!target.ipHash) return res.status(409).json({ error: '旧セッションのため、このIPの信頼を取り消せません。' });
    affectedTokens = sessions
      .filter((session) => session.ipHash === target.ipHash)
      .map((session) => session.token);
    revokedTrust = await db.revokeTrustedLoginIp(req.user.id, target.ipHash);
    invalidated = await db.invalidateSessionsByIp(req.user.id, target.ipHash);
  }
  const currentToken = getCookieValue(req, 'nyaitter_session');
  const activeRemoved = Boolean(currentToken && affectedTokens.includes(SessionManager.hashToken(currentToken)));
  setRememberedAccountsCookie(res, readRememberedAccounts(req)
    .filter((account) => !affectedTokens.includes(SessionManager.hashToken(account.token))));
  if (activeRemoved) clearSessionCookie(res);

  res.set('Cache-Control', 'no-store');
  return res.json({ success: true, trust_revoked: revokedTrust, invalidated, active_removed: activeRemoved });
});

/**
 * GET /server/auth/accounts
 * 同一ブラウザで記憶したログイン済みアカウントを返す。
 * セッション文字列そのものは決してクライアントへ返さない。
 */
router.get({
	path: '/accounts',
	summary: '端末に記憶されているアカウント一覧の取得',
	auth: 'none',
}, async (req, res) => {
  const db = getDbAdapter(req);
  try {
    const remembered = readRememberedAccounts(req);
    const operatorIds = remembered.map((account) => account.userId);
    const [accounts, accessibleByOperator] = await Promise.all([
      getValidRememberedAccounts(req, db),
      listAccessibleImpostersForOperators(db, operatorIds),
    ]);
    setRememberedAccountsCookie(res, accounts);
    const activeToken = getCookieValue(req, 'nyaitter_session');
    const automaticallyAccessible = new Map();
    for (let index = 0; index < accounts.length; index += 1) {
      const account = accounts[index];
      for (const imposter of accessibleByOperator.get(account.userId) || []) {
        if (!automaticallyAccessible.has(imposter.id)) {
          automaticallyAccessible.set(imposter.id, {
            user: imposter,
            role: getImposterRole(imposter, account.userId),
          });
        }
      }
    }

    const directAccounts = accounts.map((account) => ({
      ...serializeLoginUser(account.user, req),
      imposter_role: account.user.settings?.imposter?.parent_id
        ? getImposterRole(account.user, account.user.settings.imposter.parent_id)
        : null,
      active: activeToken === account.token,
    }));
    const directIds = new Set(accounts.map((account) => account.userId));
    const imposterAccounts = [...automaticallyAccessible.values()]
      .filter(({ user }) => !directIds.has(user.id))
      .map(({ user, role }) => ({
        ...serializeLoginUser(user, req),
        imposter_role: role,
        active: false,
        automatic_imposter: true,
      }));

    res.json({ accounts: [...directAccounts, ...imposterAccounts] });
  } catch (error) {
    console.error('[auth] account list error:', error);
    res.status(500).json({ error: 'アカウント一覧の取得に失敗しました' });
  }
});

/**
 * POST /server/auth/accounts/switch
 * 署名済み・HTTPOnlyの記憶済みセッションからアクティブアカウントを切り替える。
 */
router.post({
	path: '/accounts/switch',
	summary: '操作対象アカウントの切り替え',
	auth: 'none',
}, async (req, res) => {
  const userId = Number(req.body?.user_id);
  if (!Number.isInteger(userId) || userId < 0) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  const db = getDbAdapter(req);
  try {
    const accounts = await getValidRememberedAccounts(req, db);
    const selected = accounts.find((account) => account.userId === userId);
    if (!selected) {
      return res.status(403).json({ error: 'このブラウザで認証済みのアカウントではありません' });
    }

    setSessionCookie(req, res, selected.token, selected.session.expiresAt);
    setRememberedAccountsCookie(res, [
      { token: selected.token, userId: selected.userId },
      ...accounts
        .filter((account) => account.token !== selected.token && account.userId !== selected.userId)
        .map((account) => ({ token: account.token, userId: account.userId })),
    ]);
    res.json({ success: true, user: serializeLoginUser(selected.user, req) });
  } catch (error) {
    console.error('[auth] account switch error:', error);
    res.status(500).json({ error: 'アカウントの切替に失敗しました' });
  }
});

router.post({
	path: '/imposters/:imposterId/switch',
	summary: '操作対象をインポスターに切り替え',
	auth: 'session',
}, requireAuth, requireInteractiveSession, async (req, res) => {
  const imposterId = Number(req.params.imposterId);
  if (!Number.isInteger(imposterId) || imposterId <= 0) {
    return res.status(400).json({ error: 'インポスターIDが正しくありません。' });
  }

  const db = getDbAdapter(req);
  try {
    const imposter = await db.getUserById(imposterId);
    const rememberedAccounts = await getValidRememberedAccounts(req, db);
    const authorizedAccount = rememberedAccounts.find((account) => (
      canOperateImposter(imposter, account.userId)
    ));
    if (!imposter || !authorizedAccount) {
      return res.status(403).json({ error: 'このインポスターへの切替権限がありません。' });
    }
    const session = await createAuthenticatedSession(req, res, imposter, getRequestLoginMetadata(req));
    return res.json({
      success: true,
      expires_at: session.expiresAt,
      user: serializeLoginUser(imposter, req),
    });
  } catch (error) {
    console.error('[auth] imposter switch error:', error);
    return res.status(500).json({ error: 'インポスターへの切替に失敗しました' });
  }
});

router.delete({
	path: '/accounts/:userId',
	summary: '端末の記憶アカウント一覧から特定アカウントを削除',
	auth: 'none',
}, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId < 0) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const db = getDbAdapter(req);
  try {
    const accounts = await getValidRememberedAccounts(req, db);
    const selected = accounts.find((account) => account.userId === userId);
    if (!selected) {
      return res.status(404).json({ error: '記憶済みアカウントが見つかりません' });
    }

    const selectedUser = await db.getUserById(selected.userId);
    if (selectedUser && isImposter(selectedUser)) {
      return res.status(403).json({ error: 'インポスターアカウントは個別に解除できません。' });
    }

    const sessionManager = new SessionManager({ dbAdapter: db });
    await sessionManager.invalidateSession(selected.userId, selected.token);

    // 親アカウントがログアウトした場合、その親が所有するインポスターも同時にログアウトする
    const imposterIds = new Set();
    try {
      const ownedImposters = await listOwnedImposters(db, selected.userId);
      for (const imposter of ownedImposters) {
        imposterIds.add(imposter.id);
        req.app.locals.realtime?.closeUser?.(imposter.id, 1012, 'Parent account logout');
        await db.invalidateAllSessions(imposter.id);
      }
    } catch (err) {
      console.warn('[auth] Failed to log out owned imposters on account removal:', err.message);
    }

    const removedTokens = new Set([selected.token]);
    const removedUserIds = new Set([selected.userId, ...imposterIds]);

    for (const account of accounts) {
      if (imposterIds.has(account.userId)) {
        removedTokens.add(account.token);
        await sessionManager.invalidateSession(account.userId, account.token).catch(() => {});
      }
    }

    const remaining = accounts
      .filter((account) => !removedUserIds.has(account.userId) && !removedTokens.has(account.token))
      .map((account) => ({ token: account.token, userId: account.userId }));
    setRememberedAccountsCookie(res, remaining);

    const currentToken = getCookieValue(req, 'nyaitter_session');
    const activeRemoved = Boolean(currentToken && removedTokens.has(currentToken));
    if (activeRemoved) clearSessionCookie(res);
    res.json({ success: true, active_removed: activeRemoved });
  } catch (error) {
    console.error('[auth] account removal error:', error);
    res.status(500).json({ error: 'アカウントの解除に失敗しました' });
  }
});

/**
 * POST /server/auth/logout
 * 現在のセッションを無効化しCookieを削除
 */
router.post({
	path: '/logout',
	summary: 'ログアウト処理',
	auth: 'none',
}, optionalAuth, async (req, res) => {
  const db = getDbAdapter(req);

  if (req.user && isImposter(req.user)) {
    return res.status(403).json({ error: 'インポスターアカウントから直接ログアウトすることはできません。アカウント切替をご利用ください。' });
  }

  const cookieToken = getCookieValue(req, 'nyaitter_session');

  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  const token = headerToken || cookieToken;

  const sessionManager = new SessionManager({ dbAdapter: db });

  const imposterIds = new Set();
  if (token && req.user?.id) {
    await sessionManager.invalidateSession(req.user.id, token);

    // 親アカウントがログアウトした場合、その親が所有するインポスターも同時にログアウトする
    try {
      const ownedImposters = await listOwnedImposters(db, req.user.id);
      for (const imposter of ownedImposters) {
        imposterIds.add(imposter.id);
        req.app.locals.realtime?.closeUser?.(imposter.id, 1012, 'Parent account logout');
        await db.invalidateAllSessions(imposter.id);
      }
    } catch (err) {
      console.warn('[auth] Failed to log out owned imposters on logout:', err.message);
    }
  }

  const currentRemembered = readRememberedAccounts(req);
  const remainingAccounts = [];
  for (const account of currentRemembered) {
    if (
      account.token === cookieToken ||
      (req.user?.id && account.userId === req.user.id) ||
      imposterIds.has(account.userId)
    ) {
      if (account.token && account.token !== token) {
        await sessionManager.invalidateSession(account.userId, account.token).catch(() => {});
      }
    } else {
      remainingAccounts.push(account);
    }
  }

  setRememberedAccountsCookie(res, remainingAccounts);
  clearSessionCookie(res);
  res.json({ message: 'Logged out successfully' });
});

router.post({
	path: '/turnstile/verify',
	summary: 'Cloudflare Turnstile キャプチャ検証',
	auth: 'none',
}, async (req, res) => {
  const { token } = req.body;
  if (!config.turnstile?.secret) {
    return res.status(500).json({ error: 'Turnstileがサーバー側で設定されていません' });
  }

  const result = await verifyTurnstileToken(token);
  if (result.code === 'token_required') {
    return res.status(400).json({ error: 'token is required' });
  }
  if (result.success) {
    res.json({ success: true });
  } else {
    res.status(400).json({ success: false, error: result.errorCodes || '検証に失敗しました' });
  }
});

router.get({
	path: '/test-protected',
	summary: '認証保護テストエンドポイント',
	auth: 'required',
}, requireAuth, (req, res) => {
  res.json({
    message: '認証に成功しました！',
    userId: req.user.id,
    isBot: req.user.isBot,
    tokenType: req.user.tokenType,
  });
});

/**
 * POST /server/auth/dev-login
 * 開発用簡易ログイン
 * 実際のScratch認証をスキップして即座にユーザー+セッションを作成する
 */
router.post({
	path: '/dev-login',
	summary: '開発環境用簡易ログイン',
	auth: 'none',
}, async (req, res) => {
  const isProd = (process.env.NODE_ENV || 'development') === 'production';
  if (process.env.DEV_BYPASS_AUTH !== 'true' || isProd) {
    return res.status(403).json({ error: 'DEV_BYPASS_AUTH が有効な場合のみ使用可能です' });
  }

  const { username } = req.body;
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'username is required' });
  }
  if (!isValidScratchUsername(username)) {
    return res.status(400).json({ error: 'Invalid username format' });
  }

  const db = getDbAdapter(req);
  const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';

  let user = await db.getUserByScid(username);
  if (!user) {
    user = await db.createUser({
      scid: username,
      name: username,
      auth_provider: 'local',
    });
  }

  const result = await beginProtectedLogin(req, res, user, 'local');
  const payload = sendLoginResult(req, res, user, result);
  return payload;
});

router.post({
	path: '/bot-tokens',
	summary: 'Bot API トークンの新規発行',
	auth: 'required',
}, requireAuth, async (req, res) => {
  const { name } = req.body;
  const userId = req.user?.id;
  const db = getDbAdapter(req);

  if (!userId) {
    return res.status(401).json({ error: '認証が必要です' });
  }

  const botTokenManager = new BotTokenManager({ dbAdapter: db });

  try {
    const result = await botTokenManager.createBotToken(userId, { name });
    res.json({
      message: 'Botトークンを生成しました。このトークンは一度だけ表示されます。',
      token: result.token,
      tokenId: result.tokenId,
      name: result.name,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Botトークンの生成に失敗しました' });
  }
});

router.get({
	path: '/bot-tokens',
	summary: '発行済み Bot API トークン一覧の取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
  const userId = req.user?.id;
  const db = getDbAdapter(req);
  if (!userId) return res.status(401).json({ error: '認証が必要です' });

  const botTokenManager = new BotTokenManager({ dbAdapter: db });
  const tokens = await botTokenManager.getUserBotTokens(userId);

  res.json({ tokens });
});

router.delete({
	path: '/bot-tokens/:tokenId',
	summary: 'Bot API トークンの削除',
	auth: 'required',
}, requireAuth, async (req, res) => {
  const userId = req.user?.id;
  const { tokenId } = req.params;
  const db = getDbAdapter(req);

  if (!userId) return res.status(401).json({ error: '認証が必要です' });

  const botTokenManager = new BotTokenManager({ dbAdapter: db });
  const success = await botTokenManager.revokeBotToken(userId, tokenId);

  if (success) {
    res.json({ message: 'Botトークンを無効化しました' });
  } else {
    res.status(404).json({ error: 'トークンが見つかりません' });
  }
});

module.exports = router;
