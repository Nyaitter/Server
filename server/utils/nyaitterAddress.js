const config = require('../config');

const DEFAULT_PORTS = new Map([
  ['http:', '80'],
  ['https:', '443'],
]);

function formatNyaitterId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new Error('Nyaitter ID must be a non-negative integer');
  }
  return `#${String(id).padStart(4, '0')}`;
}

function normalizePublicUrl(value) {
  if (!value || typeof value !== 'string') return null;

  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return null;
    }
    return parsed.origin;
  } catch (_) {
    return null;
  }
}

function isSafeHost(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 255) return false;
  if (/\s|[\\/@?#]/.test(host)) return false;
  try {
    const parsed = new URL(`http://${host}`);
    return parsed.hostname === host.split(':')[0] || host.startsWith('[');
  } catch (_) {
    return false;
  }
}

/**
 * Derive this instance's public origin from the active request. Behind a proxy,
 * Express's req.protocol and req.hostname follow forwarded headers only when
 * server.trustProxy is enabled. PUBLIC_URL is only a safe fallback for jobs
 * that have no request context.
 */
function getPublicUrl(req = null) {
  const configured = normalizePublicUrl(
    config.client?.publicUrl ||
    process.env.NYAITTER_CLIENT_PUBLIC_URL ||
    process.env.NYAITTER_PUBLIC_URL ||
    process.env.PUBLIC_URL ||
    config.federation?.publicUrl
  );

  // 本番は設定済みの正規URLを使い、利用者が送るHostヘッダーで認証コールバックや
  // 共有URLのオリジンが変化しないようにする。
  if (configured) {
    return configured;
  }

  if (req && typeof req.get === 'function') {
    const forwardedHost = config.server?.trustProxy === true
      ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
      : '';
    const host = forwardedHost || req.get('host');
    if (isSafeHost(host)) {
      const protocol = req.protocol === 'https' ? 'https' : 'http';
      const derived = normalizePublicUrl(`${protocol}://${host}`);
      if (derived) return derived;
    }
  }

  const port = config.server?.port || 3000;
  return `http://localhost:${port}`;
}

function getApiPublicUrl(req = null) {
  const configured = normalizePublicUrl(
    config.server?.publicUrl ||
    process.env.NYAITTER_API_PUBLIC_URL ||
    process.env.NYAITTER_API_URL
  );
  if (configured) return configured;
  return getPublicUrl(req);
}

function getPostShareUrl(req = null) {
  const portSetting = process.env.POST_SHARE_PORT || config.postSharePort;
  if (portSetting) {
    const port = Number(portSetting);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      const publicBase = getPublicUrl(req);
      try {
        const parsed = new URL(publicBase);
        parsed.port = (port === 80 || port === 443) ? '' : String(port);
        return parsed.origin;
      } catch (_) {}
    }
  }

  return getPublicUrl(req);
}

function getUserNyaitterId(user) {
	if (!user) return null;
	return formatNyaitterId(
		user.auth_provider === 'nyaitter' && user.external_id != null
			? user.external_id
			: user.id,
	);
}

module.exports = {
  formatNyaitterId,
  getPublicUrl,
  getApiPublicUrl,
  getPostShareUrl,
  getUserNyaitterId,
  normalizePublicUrl,
  isSafeHost,
};
