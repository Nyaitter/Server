'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function getOrPersistHmacSecret() {
  if (process.env.LOGIN_SECURITY_HMAC_SECRET) {
    return process.env.LOGIN_SECURITY_HMAC_SECRET;
  }
  if (process.env.MULTI_ACCOUNT_COOKIE_SECRET) {
    return process.env.MULTI_ACCOUNT_COOKIE_SECRET;
  }
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }

  // 永続化ファイルから読み込み、なければ自動生成して保存
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const secretPath = path.join(dataDir, '.auth_hmac_secret');

  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    if (fs.existsSync(secretPath)) {
      const stored = fs.readFileSync(secretPath, 'utf8').trim();
      if (stored && stored.length >= 16) return stored;
    }
    const generated = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(secretPath, generated, { encoding: 'utf8', mode: 0o600 });
    return generated;
  } catch (_) {
    // ファイルシステムへの書き込みが制限されている場合のフォールバック
    return 'nyaitter-auth-default-secure-hmac-secret-salt';
  }
}

const ipHashSecret = getOrPersistHmacSecret();

/**
 * IPアドレスを正規化します。
 * IPv6の一時アドレスによる下位64ビットの頻繁なローテーションに対応するため、
 * IPv6の場合は /64 プレフィックスに正規化します。
 * @param {string} ip
 * @returns {string}
 */
function normalizeIp(ip) {
  let value = String(ip || '').trim();
  if (!value) return 'unknown';

  // IPv4-mapped IPv6 (e.g. ::ffff:192.168.1.1)
  if (value.startsWith('::ffff:')) {
    value = value.slice(7);
  }

  // IPv4 with port (e.g. 192.168.1.1:8080)
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(value)) {
    return value.split(':')[0];
  }

  // IPv6
  if (value.includes(':')) {
    // 展開またはプレフィックス抽出
    const cleanIpv6 = value.replace(/^\[|\]$/g, '').split('%')[0]; // スコープIDやブラケット除去
    const parts = cleanIpv6.split(':').filter(Boolean);
    if (parts.length >= 4) {
      return `${parts.slice(0, 4).join(':')}::/64`;
    }
    return cleanIpv6;
  }

  return value;
}

function hashIp(ip) {
  return crypto
    .createHmac('sha256', ipHashSecret)
    .update(normalizeIp(ip))
    .digest('hex');
}

function maskIp(ip) {
  const normalized = normalizeIp(ip);
  if (normalized === 'unknown') return '不明なIPアドレス';
  if (normalized.includes('.')) {
    const parts = normalized.split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.*` : 'IPv4アドレス';
  }
  if (normalized.includes('::/64')) {
    const prefix = normalized.replace('::/64', '');
    return `${prefix}::/64`;
  }
  const parts = normalized.split(':').filter(Boolean);
  return parts.length > 0 ? `${parts.slice(0, 4).join(':')}::/64` : 'IPv6アドレス';
}

function normalizeUserAgent(userAgent) {
  return String(userAgent || '不明な端末').replace(/[\r\n\t]+/g, ' ').slice(0, 512);
}

function getRequestLoginMetadata(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return {
    ipHash: hashIp(ip),
    ipMasked: maskIp(ip),
    userAgent: normalizeUserAgent(req.get?.('user-agent') || req.headers?.['user-agent']),
  };
}

function generateApprovalPollToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashApprovalPollToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function isUnknownLoginProtectionEnabled(user) {
  return user?.settings?.reject_unknown_login !== false;
}

module.exports = {
  getRequestLoginMetadata,
  hashIp,
  maskIp,
  generateApprovalPollToken,
  hashApprovalPollToken,
  isUnknownLoginProtectionEnabled,
};
