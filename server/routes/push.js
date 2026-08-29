const api = require('../utils/ApiRegistry');
const config = require('../config');
const {
  requireAuth,
  extractToken,
  isSameOriginRequest,
} = require('../middleware/auth');
const SessionManager = require('../services/auth/SessionManager');

const router = api.createRouter({
  tag: 'push',
  basePath: '/push',
  description: 'Web Push 通知 API',
});

function getPushService(req) {
  return req.app.locals.pushNotificationService;
}

function requireSessionPrincipal(req, res, next) {
  if (req.user?.tokenType !== 'session') {
    return res.status(403).json({ error: 'Browser session authentication is required' });
  }
  return next();
}

function validateEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length < 16 || endpoint.length > 4096) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function validateKey(value, minLength, maxLength) {
  return typeof value === 'string'
    && value.length >= minLength
    && value.length <= maxLength
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function normalizeSubscription(value) {
  if (!value || typeof value !== 'object') return null;
  const endpoint = value.endpoint;
  const keys = value.keys;
  if (!validateEndpoint(endpoint) || !keys || typeof keys !== 'object') return null;
  if (!validateKey(keys.p256dh, 32, 256) || !validateKey(keys.auth, 16, 128)) return null;

  const expirationTime = value.expirationTime == null ? null : Number(value.expirationTime);
  if (expirationTime != null && (!Number.isFinite(expirationTime) || expirationTime < 0)) return null;

  return {
    endpoint,
    expirationTime,
    keys: {
      p256dh: keys.p256dh,
      auth: keys.auth,
    },
  };
}

router.get({
  path: '/config',
  summary: 'Web Push 設定の取得',
  auth: 'session',
}, requireAuth, requireSessionPrincipal, async (req, res) => {
  const pushService = getPushService(req);
  const publicConfig = pushService?.getPublicConfiguration?.() || {
    enabled: false,
    vapid_public_key: null,
  };

  let subscriptionCount = 0;
  try {
    subscriptionCount = (await req.app.locals.dbAdapter.getPushSubscriptions(req.user.id)).length;
  } catch (error) {
    console.warn('[push] Failed to count subscriptions:', error.message);
  }

  res.json({
    ...publicConfig,
    subscription_count: subscriptionCount,
  });
});

router.post({
  path: '/subscriptions',
  summary: 'Web Push 購読情報の登録',
  auth: 'session',
}, requireAuth, requireSessionPrincipal, async (req, res) => {
  if (!isSameOriginRequest(req)) {
    return res.status(403).json({ error: 'Cross-origin subscription requests are not allowed' });
  }

  const pushService = getPushService(req);
  if (!pushService?.enabled) {
    return res.status(503).json({ error: 'Web Push is not configured on this server' });
  }

  const subscription = normalizeSubscription(req.body?.subscription);
  if (!subscription) {
    return res.status(400).json({ error: 'Invalid PushSubscription' });
  }

  const sessionToken = extractToken(req);
  if (!sessionToken) {
    return res.status(401).json({ error: 'セッショントークンが見つかりません' });
  }

  try {
    const stored = await req.app.locals.dbAdapter.upsertPushSubscription(req.user.id, {
      ...subscription,
      sessionToken: SessionManager.hashToken(sessionToken),
    });
    if (!stored) return res.status(404).json({ error: 'User not found' });
    return res.status(201).json({ success: true });
  } catch (error) {
    console.error('[push] Subscription save error:', error);
    return res.status(500).json({ error: 'Push subscription could not be saved' });
  }
});

router.delete({
  path: '/subscriptions',
  summary: 'Web Push 購読情報の削除',
  auth: 'session',
}, requireAuth, requireSessionPrincipal, async (req, res) => {
  if (!isSameOriginRequest(req)) {
    return res.status(403).json({ error: 'Cross-origin subscription requests are not allowed' });
  }

  const endpoint = req.body?.endpoint;
  if (!validateEndpoint(endpoint)) {
    return res.status(400).json({ error: 'Invalid subscription endpoint' });
  }

  try {
    await req.app.locals.dbAdapter.deletePushSubscription(req.user.id, endpoint);
    return res.json({ success: true });
  } catch (error) {
    console.error('[push] Subscription delete error:', error);
    return res.status(500).json({ error: 'Push subscription could not be removed' });
  }
});

module.exports = router;
