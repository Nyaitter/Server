const path = require('path');

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const CONTENT_TYPE_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['application/pdf', '.pdf'],
  ['text/plain', '.txt'],
  ['text/csv', '.csv'],
  ['application/zip', '.zip'],
]);

const SAFE_FILENAME_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.mp4', '.webm', '.mp3', '.ogg', '.wav',
  '.pdf', '.txt', '.csv', '.zip',
]);

function normalizeContentType(contentType) {
  return String(contentType || 'application/octet-stream')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
}

function getSafeExtension(fileName, contentType) {
  const normalizedContentType = normalizeContentType(contentType);
  const mappedExtension = CONTENT_TYPE_EXTENSIONS.get(normalizedContentType);
  if (mappedExtension) return mappedExtension;

  const candidate = path.extname(String(fileName || '')).toLowerCase();
  if (SAFE_FILENAME_EXTENSIONS.has(candidate)) return candidate;
  return '';
}

function truncateUtf8(value, maxBytes) {
  let result = '';
  for (const character of String(value || 'file')) {
    if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break;
    result += character;
  }
  return result || 'file';
}

function createStorageFileName(id, originalFileName, contentType) {
  const encodedName = Buffer.from(truncateUtf8(originalFileName, 60), 'utf8').toString('base64url');
  const extension = getSafeExtension(originalFileName, contentType);
  return `${id}--n-${encodedName}${extension}`;
}

function getOriginalFileNameFromStorageKey(key) {
  const fileName = String(key || '').split('/').pop() || '';
  const match = /^[a-f0-9]{32}--n-([A-Za-z0-9_-]+)(?:\.[a-z0-9]{1,10})?$/i.exec(fileName);
  if (!match) return fileName;
  try {
    const decoded = Buffer.from(match[1], 'base64url').toString('utf8');
    return decoded || fileName;
  } catch (_) {
    return fileName;
  }
}

function normalizeFolder(folder) {
  const value = String(folder || '').replace(/\\/g, '/');
  const parts = value.split('/');

  if (
    !value ||
    value.startsWith('/') ||
    parts.some((part) => !SAFE_SEGMENT.test(part) || part === '.' || part === '..')
  ) {
    throw new Error('Invalid storage folder');
  }

  return parts.join('/');
}

function normalizeStorageKey(key) {
  const value = String(key || '').replace(/\\/g, '/');
  const parts = value.split('/');

  if (
    !value ||
    value.startsWith('/') ||
    parts.length < 2 ||
    parts.some((part) => !SAFE_SEGMENT.test(part) || part === '.' || part === '..')
  ) {
    throw new Error('Invalid storage key');
  }

  return parts.join('/');
}

function isOwnedAttachmentKey(key, userId) {
  const normalizedKey = normalizeStorageKey(key);
  const expectedPrefix = `attachments/${Number(userId)}/`;
  return normalizedKey.startsWith(expectedPrefix);
}

module.exports = {
  CONTENT_TYPE_EXTENSIONS,
  createStorageFileName,
  getOriginalFileNameFromStorageKey,
  getSafeExtension,
  isOwnedAttachmentKey,
  normalizeContentType,
  normalizeFolder,
  normalizeStorageKey,
};
