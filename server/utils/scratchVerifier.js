const crypto = require('crypto');
const config = require('../config');

const TARGET_PROJECT_ID = process.env.SCRATCH_PROJECT_ID || '1239738451';
const PROJECT_OWNER_USERNAME = process.env.SCRATCH_PROJECT_OWNER || 'NyaitterTeam';

// メモリ上に保存する一時的なコード
// (username -> { code, expiresAt, issuedIpHash })
const pendingCodes = new Map();
const MAX_PENDING_CODES = Math.max(
  1,
  Number(config.auth?.maxPendingVerificationCodes) || 1000,
);

function discardExpiredCodes(now = Date.now()) {
  for (const [username, value] of pendingCodes) {
    if (!value || value.expiresAt <= now) pendingCodes.delete(username);
  }
}

function makeRoomForPendingCode() {
  discardExpiredCodes();
  while (pendingCodes.size >= MAX_PENDING_CODES) {
    const oldestUsername = pendingCodes.keys().next().value;
    if (oldestUsername === undefined) break;
    pendingCodes.delete(oldestUsername);
  }
}

// Clear expired entries even when no later verification request arrives.
const pendingCodeCleanupTimer = setInterval(discardExpiredCodes, 60 * 1000);
pendingCodeCleanupTimer.unref();

function matchesSecret(expectedValue, actualValue) {
  const expected = Buffer.from(String(expectedValue || ''), 'utf8');
  const actual = Buffer.from(String(actualValue || ''), 'utf8');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/**
 * 検証コードを生成する
 * @param {string} username - Scratchユーザー名
 * @param {string} issuedIpHash - 発行要求のIPハッシュ
 * @returns {{ code: string, expiresAt: number }}
 */
function generateVerificationCode(username, issuedIpHash) {
  const code = crypto.randomBytes(config.auth?.verificationCodeBytes || 4).toString('hex').toUpperCase();
  const msPerMinute = 1000 * 60;
  const expiryMins = config.auth?.verificationCodeExpiryMinutes || 10;
  const expiresAt = Date.now() + msPerMinute * expiryMins;

  const normalizedUsername = username.toLowerCase();
  if (pendingCodes.has(normalizedUsername)) discardExpiredCodes();
  else makeRoomForPendingCode();
  pendingCodes.set(normalizedUsername, {
    code,
    expiresAt,
    issuedIpHash: String(issuedIpHash || ''),
  });

  return { code, expiresAt };
}

/**
 * HTMLエンティティデコード & タグ除去ヘルパー
 */
function decodeHtmlEntities(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * タイムアウト付き fetch ヘルパー
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Scratchのコメントから検証コードを探す
 * @param {string} username Scratchユーザー名
 * @param {string} code 検証コード
 * @returns {Promise<boolean>}
 */
async function verifyScratchComment(username, code) {
  if (!username || !code) return false;

  const targetUser = username.trim().toLowerCase();
  const targetCode = code.trim().toUpperCase();

  try {
    const projectCommentsUrl = `https://api.scratch.mit.edu/users/${PROJECT_OWNER_USERNAME}/projects/${TARGET_PROJECT_ID}/comments?limit=40&offset=0`;
    const res = await fetchWithTimeout(projectCommentsUrl);

    if (res.ok) {
      const comments = await res.json();
      if (Array.isArray(comments)) {
        const found = comments.some(c => {
          const author = (c.author?.username || '').trim().toLowerCase();
          const content = (c.content || '').trim().toUpperCase();
          return author === targetUser && content.includes(targetCode);
        });

        if (found) {
          console.log(`[scratchVerifier] コード検証成功 (Project REST API): user=${username}`);
          return true;
        }
      }
    }
  } catch (err) {
    console.warn('[scratchVerifier] Project REST API fetch warning:', err.message);
  }

  try {
    const profileCommentsUrl = `https://scratch.mit.edu/site-api/comments/user/${encodeURIComponent(username)}/?cache=${Date.now()}`;
    const res = await fetchWithTimeout(profileCommentsUrl);

    if (res.ok) {
      const html = await res.text();
      const commentRegex = /<a[^>]*data-comment-user="([^\"]+)"[^>]*>[\s\S]*?<div class="content">([\s\S]*?)<\/div>/gmi;
      let match;

      while ((match = commentRegex.exec(html)) !== null) {
        const commentUser = (match[1] || '').trim().toLowerCase();
        const rawContent = match[2] || '';
        const decodedContent = decodeHtmlEntities(rawContent).toUpperCase();

        if (commentUser === targetUser && decodedContent.includes(targetCode)) {
          console.log(`[scratchVerifier] コード検証成功 (Profile Site API): user=${username}`);
          return true;
        }
      }
    }
  } catch (err) {
    console.warn('[scratchVerifier] Profile Site API fetch warning:', err.message);
  }

  try {
    const siteProjectCommentsUrl = `https://scratch.mit.edu/site-api/comments/project/${TARGET_PROJECT_ID}/?cache=${Date.now()}`;
    const res = await fetchWithTimeout(siteProjectCommentsUrl);

    if (res.ok) {
      const html = await res.text();
      const commentRegex = /<a[^>]*data-comment-user="([^\"]+)"[^>]*>[\s\S]*?<div class="content">([\s\S]*?)<\/div>/gmi;
      let match;

      while ((match = commentRegex.exec(html)) !== null) {
        const commentUser = (match[1] || '').trim().toLowerCase();
        const rawContent = match[2] || '';
        const decodedContent = decodeHtmlEntities(rawContent).toUpperCase();

        if (commentUser === targetUser && decodedContent.includes(targetCode)) {
          console.log(`[scratchVerifier] コード検証成功 (Project Site API): user=${username}`);
          return true;
        }
      }
    }
  } catch (err) {
    console.warn('[scratchVerifier] Project Site API fetch warning:', err.message);
  }

  console.warn(`[scratchVerifier] コードが見つかりませんでした: user=${username}, code=${code}`);
  return false;
}

/**
 * 発行済みコードの有効期限と一致を確認する。ここではコードを消費しない。
 */
function checkVerificationCode(username, code, requestIpHash) {
  const normalizedUsername = String(username || '').trim().toLowerCase();
  const record = pendingCodes.get(normalizedUsername);
  if (!record) {
    return { success: false, reason: 'コードが見つかりません。再度「コードを取得」してください。' };
  }
  if (record.expiresAt < Date.now()) {
    pendingCodes.delete(normalizedUsername);
    return { success: false, reason: 'コードの有効期限が切れています。再度コードを取得してください。' };
  }
  if (!record.issuedIpHash || !matchesSecret(record.issuedIpHash, requestIpHash)) {
    return { success: false, reason: 'コードを発行したIPアドレスと同じ接続から認証してください。' };
  }

  const cleanInputCode = String(code || '').trim().toUpperCase();
  if (!matchesSecret(record.code.toUpperCase(), cleanInputCode)) {
    return { success: false, reason: '入力されたコードが一致しません。' };
  }

  return { success: true, code: cleanInputCode };
}

/**
 * Scratch上のコメントを確認する。確認失敗時も、コードは有効期限まで保持する。
 */
async function verifyPendingCode(username, code, requestIpHash) {
  const codeResult = checkVerificationCode(username, code, requestIpHash);
  if (!codeResult.success) return codeResult;

  const isVerified = await verifyScratchComment(username, codeResult.code);
  if (!isVerified) {
    return {
      success: false,
      reason: 'Scratchの指定プロジェクトまたはプロフィールコメントにコードが見つかりませんでした。コメントした直後の場合は数秒置いて再度お試しください。'
    };
  }

  return { success: true };
}

/**
 * 認証完了後にだけコードを消費する。別のリクエストで先に消費・更新された場合も防ぐ。
 */
function consumeVerificationCode(username, code, requestIpHash) {
  const codeResult = checkVerificationCode(username, code, requestIpHash);
  if (!codeResult.success) return codeResult;

  pendingCodes.delete(String(username || '').trim().toLowerCase());
  return { success: true };
}

/**
 * 既存利用者向けの一括検証・消費関数。認証ルートでは後続のアカウント確認後に
 * consumeVerificationCode() を呼ぶため、失敗時のコード消費を防げる。
 */
async function checkAndConsumeCode(username, code, requestIpHash) {
  const verification = await verifyPendingCode(username, code, requestIpHash);
  if (!verification.success) return verification;
  return consumeVerificationCode(username, code, requestIpHash);
}

module.exports = {
  generateVerificationCode,
  checkVerificationCode,
  verifyPendingCode,
  consumeVerificationCode,
  checkAndConsumeCode,
  verifyScratchComment,
};
