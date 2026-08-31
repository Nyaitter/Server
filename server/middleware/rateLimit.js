'use strict';

const config = require('../config');

/**
 * 堅牢なIPアドレス抽出ヘルパー
 * プロキシ背後および直接接続から安全にIPを取得
 */
function getClientIp(req) {
  if (config.server?.trustProxy) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim();

    if (req.ip) return req.ip;

    const xRealIp = req.headers['x-real-ip'];
    if (typeof xRealIp === 'string' && xRealIp.trim()) return xRealIp.trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || config.rateLimit?.general?.windowMs || 60000;
  const max = options.max || config.rateLimit?.general?.max || 1000;
  const keyGenerator = options.keyGenerator || ((req) => {
    if (req.user?.id) return `user:${req.user.id}`;
    return `ip:${getClientIp(req)}`;
  });

  const store = new Map(); // key -> { count, resetTime, blockedUntil }
  const maxTrackedKeys = Math.max(
    100,
    Number(options.maxTrackedKeys ?? config.rateLimit?.maxTrackedKeys) || 10000,
  );

  const pruneExpiredEntries = (now = Date.now()) => {
    for (const [key, entry] of store) {
      if (!entry || (entry.resetTime <= now && (!entry.blockedUntil || entry.blockedUntil <= now))) {
        store.delete(key);
      }
    }
  };

  const trimStore = (now = Date.now()) => {
    pruneExpiredEntries(now);
    while (store.size >= maxTrackedKeys) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) break;
      store.delete(oldestKey);
    }
  };

  const timer = setInterval(() => {
    pruneExpiredEntries();
  }, Math.max(10000, windowMs));
  timer.unref();

  return function rateLimitMiddleware(req, res, next) {
    if (!config.rateLimit?.enabled) {
      return next();
    }

    const key = keyGenerator(req);
    const now = Date.now();
    let entry = store.get(key);

    // 継続的過剰リクエストによる一時ブロック判定
    if (entry?.blockedUntil && now < entry.blockedUntil) {
      const retryAfterSec = Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000));
      res.setHeader('Retry-After', retryAfterSec);
      return res.status(429).json({
        error: 'Too Many Requests',
        message: '過剰なリクエストが検出されたため、一時的にアクセスを制限しています。',
      });
    }

    if (!entry || now >= entry.resetTime) {
      if (!entry) trimStore(now);
      entry = { count: 0, resetTime: now + windowMs, blockedUntil: 0 };
      store.set(key, entry);
    }

    entry.count += 1;

    // 上限の2倍を超える過剰リクエストを発行した場合はクールダウンブロック
    if (entry.count > max * 2) {
      entry.blockedUntil = now + Math.max(windowMs * 5, 300000);
      res.setHeader('Retry-After', Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)));
      return res.status(429).json({
        error: 'Too Many Requests',
        message: '過剰なリクエストが検出されたため、一時的にアクセスを制限しています。',
      });
    }

    if (entry.count > max) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((entry.resetTime - now) / 1000)));
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'リクエストが多すぎます。しばらく待ってから再度お試しください。',
      });
    }

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - entry.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetTime / 1000));

    next();
  };
}

const generalLimiter = createRateLimiter();
const authLimiter = createRateLimiter({
  windowMs: config.rateLimit?.auth?.windowMs,
  max: config.rateLimit?.auth?.max || 20,
});

module.exports = {
  createRateLimiter,
  generalLimiter,
  authLimiter,
  getClientIp,
};
