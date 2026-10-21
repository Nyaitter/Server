'use strict';

/**
 * 待ち受けアドレスの解決。
 *
 * 後方互換のため、未指定なら従来どおり全インターフェースで待ち受ける
 * (Node の listen(port) と同じ)。`0.0.0.0:3000` のような host:port 形式には
 * `NYAITTER_BIND` を使える。`NYAITTER_HOST` / `HOST` と `PORT` の組み合わせも
 * 引き続き受け付ける。
 */

const DEFAULT_PORT = 3000;

function parsePort(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
  return null;
}

function isValidIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function isValidIpv6(host) {
  if (!host.includes(':')) return false;
  // 簡易チェック: 16進とコロン、最大1つの "::" のみ許可する。
  if (!/^[0-9a-fA-F:]+$/.test(host)) return false;
  if ((host.match(/::/g) || []).length > 1) return false;
  return true;
}

function isValidHost(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 255) return false;
  if (/\s|[\\/@?#]/.test(host)) return false;
  if (isValidIpv4(host)) return true;
  // 数字とドットだけの場合はIPv4として扱い、範囲外は拒否する。
  if (/^[\d.]+$/.test(host)) return false;
  if (isValidIpv6(host)) return true;
  // ホスト名・ドメイン名。
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(host);
}

/**
 * `0.0.0.0:3000`、`[::]:3000`、`:3000`、`3000`、`127.0.0.1` を解釈する。
 * 解釈できない場合は null を返す。
 */
function parseBindAddress(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return null;

  // ポート番号のみ。
  if (/^\d+$/.test(raw)) {
    const port = parsePort(raw);
    return port === null ? null : { host: '', port };
  }

  if (raw.startsWith('[')) {
    const match = raw.match(/^\[([^\]]*)\](?::(\d+))?$/);
    if (!match) return null;
    const port = match[2] === undefined ? null : parsePort(match[2]);
    if (match[2] !== undefined && port === null) return null;
    return { host: match[1], port };
  }

  const colonIndex = raw.lastIndexOf(':');
  if (colonIndex === -1) {
    return isValidHost(raw) ? { host: raw, port: null } : null;
  }

  const host = raw.slice(0, colonIndex);
  const portText = raw.slice(colonIndex + 1);
  const port = portText === '' ? null : parsePort(portText);
  if (portText !== '' && port === null) return null;
  if (host === '' || isValidHost(host)) return { host, port };
  return null;
}

/**
 * config.server から実際に listen する host/port を決める。
 * - bind が指定されていれば host/port を上書きする。
 * - host 未設定なら undefined を返し、全インターフェースで待ち受ける。
 */
function resolveListenTarget(serverConfig = {}) {
  const port = parsePort(serverConfig.port) ?? DEFAULT_PORT;
  const configuredHost = String(serverConfig.host || '').trim();
  const bind = parseBindAddress(serverConfig.bind);

  let host = configuredHost;
  let finalPort = port;

  if (bind) {
    if (bind.host) host = bind.host;
    if (bind.port !== null && bind.port !== undefined) finalPort = bind.port;
  }

  if (host && !isValidHost(host)) {
    console.warn(`[config] server.host が不正なため全インターフェースで待ち受けます: ${host}`);
    host = '';
  }

  return {
    host: host || undefined,
    displayHost: host || 'localhost',
    port: finalPort,
  };
}

module.exports = {
  DEFAULT_PORT,
  isValidHost,
  parseBindAddress,
  resolveListenTarget,
};
