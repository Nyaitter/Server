const crypto = require('crypto');
const SessionManager = require('./SessionManager');

const REMEMBERED_ACCOUNTS_COOKIE = 'nyaitter_accounts';
const MAX_REMEMBERED_ACCOUNTS = 8;
// 本番では環境変数を指定すると再起動後も記憶済みアカウントを維持できる。
// 未指定時はプロセスごとの乱数を使い、推測可能な既定鍵を使わない。
const rememberedAccountsSecret = process.env.MULTI_ACCOUNT_COOKIE_SECRET
  || crypto.randomBytes(32).toString('base64url');

function getCookieValue(req, name) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${escapedName}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function signRememberedAccounts(payload) {
  return crypto.createHmac('sha256', rememberedAccountsSecret)
    .update(payload)
    .digest('base64url');
}

function readRememberedAccounts(req) {
  const value = getCookieValue(req, REMEMBERED_ACCOUNTS_COOKIE);
  if (!value) return [];
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return [];
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expectedSignature = signRememberedAccounts(payload);
  if (signature.length !== expectedSignature.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return [];
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    return parsed
      .filter((entry) => entry && typeof entry.token === 'string' && Number.isInteger(Number(entry.userId)))
      .map((entry) => ({ token: entry.token, userId: Number(entry.userId) }))
      .filter((entry) => {
        if (seen.has(entry.token)) return false;
        seen.add(entry.token);
        return true;
      })
      .slice(0, MAX_REMEMBERED_ACCOUNTS);
  } catch (_) {
    return [];
  }
}

function setRememberedAccountsCookie(res, accounts) {
  const normalized = (accounts || [])
    .filter((entry) => entry && typeof entry.token === 'string' && Number.isInteger(Number(entry.userId)))
    .map((entry) => ({ token: entry.token, userId: Number(entry.userId) }))
    .slice(0, MAX_REMEMBERED_ACCOUNTS);
  if (normalized.length === 0) {
    res.clearCookie(REMEMBERED_ACCOUNTS_COOKIE, { path: '/' });
    return;
  }
  const payload = Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64url');
  const isProduction = (process.env.NODE_ENV || 'development') === 'production';
  res.cookie(REMEMBERED_ACCOUNTS_COOKIE, `${payload}.${signRememberedAccounts(payload)}`, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function rememberAccountSession(req, res, session) {
  const existing = readRememberedAccounts(req)
    .filter((entry) => entry.token !== session.token && entry.userId !== Number(session.userId));
  setRememberedAccountsCookie(res, [
    { token: session.token, userId: Number(session.userId) },
    ...existing,
  ]);
}

const rememberedAccountCache = new Map();
const REMEMBERED_CACHE_TTL_MS = 120000;
const MAX_REMEMBERED_CACHE_ENTRIES = 1024;

SessionManager.onInvalidate(() => {
  rememberedAccountCache.clear();
});

async function getValidRememberedAccounts(req, db) {
  const remembered = readRememberedAccounts(req);
  if (remembered.length === 0) return [];

  const tokenHashes = remembered.map((acc) => SessionManager.hashToken(acc.token));
  const cacheKey = tokenHashes.join(':');
  const now = Date.now();
  const cached = rememberedAccountCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.accounts;
  }

  const valid = [];
  if (typeof db.getUsersAndSessionsByTokens === 'function') {
    const rawPairs = await db.getUsersAndSessionsByTokens(tokenHashes);
    const pairMap = new Map(rawPairs.map((p) => [p.session.token, p]));
    for (const account of remembered) {
      const hash = SessionManager.hashToken(account.token);
      const pair = pairMap.get(hash);
      if (pair && pair.user) {
        valid.push({
          token: account.token,
          userId: Number(pair.user.id),
          session: pair.session,
          user: pair.user,
        });
      }
    }
  } else {
    // Parallel fallback for adapters without batch support
    const results = await Promise.all(
      remembered.map(async (account) => {
        const session = await db.getSessionByToken(SessionManager.hashToken(account.token));
        if (!session) return null;
        const userId = Number(session.userId);
        const user = await db.getUserById(userId);
        if (!user) return null;
        return { token: account.token, userId, session, user };
      }),
    );
    for (const item of results) {
      if (item) valid.push(item);
    }
  }

  rememberedAccountCache.set(cacheKey, {
    accounts: valid,
    expiresAt: now + REMEMBERED_CACHE_TTL_MS,
  });
  while (rememberedAccountCache.size > MAX_REMEMBERED_CACHE_ENTRIES) {
    rememberedAccountCache.delete(rememberedAccountCache.keys().next().value);
  }

  return valid;
}

module.exports = {
  getCookieValue,
  readRememberedAccounts,
  setRememberedAccountsCookie,
  rememberAccountSession,
  getValidRememberedAccounts,
};
