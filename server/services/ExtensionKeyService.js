const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PATH = path.resolve(__dirname, '../data/secrets/extension-keys.json');
const SUPPORTED_SCOPES = new Set(['nyaitter-auth']);

function registryPath() {
  return process.env.NYAITTER_EXTENSION_KEYS_FILE ? path.resolve(__dirname, '..', process.env.NYAITTER_EXTENSION_KEYS_FILE) : DEFAULT_PATH;
}

async function readRegistry() {
  try {
    const value = JSON.parse(await fs.promises.readFile(registryPath(), 'utf8'));
    if (value.version !== 1 || !Array.isArray(value.keys)) throw new Error('Invalid extension key registry');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, keys: [] };
    throw new Error('Extension key registry could not be read');
  }
}

async function mutateRegistry(callback) {
  const file = registryPath();
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockPath = `${file}.lock`;
  let lock;
  const deadline = Date.now() + 5000;
  while (!lock) {
    try { lock = await fs.promises.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('Extension key registry is locked');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const value = await readRegistry();
    const result = await callback(value.keys);
    await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.promises.rename(temporary, file);
    return result;
  } finally {
    await lock.close();
    await fs.promises.unlink(lockPath).catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

function publicKey(record) {
  const { secretHash, ...metadata } = record;
  return metadata;
}

function normalizeOrigins(values) {
  return [...new Set(values.map(value => {
    let url;
    try { url = new URL(value); } catch { throw new Error('Invalid redirect origin'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Redirect origins must be HTTP(S) origins without a path');
    }
    return url.origin;
  }))];
}

async function createKey({ name, scopes = ['nyaitter-auth'], redirectOrigins = [], outputPath } = {}) {
  name = String(name || '').trim();
  if (!name || name.length > 100 || /[\x00-\x1f]/.test(name)) throw new Error('Specify an extension name of up to 100 characters');
  scopes = [...new Set(scopes)];
  if (!scopes.length || scopes.some(scope => !SUPPORTED_SCOPES.has(scope))) throw new Error('Supported extension scope: nyaitter-auth');
  redirectOrigins = normalizeOrigins(redirectOrigins);
  if (scopes.includes('nyaitter-auth') && !redirectOrigins.length) throw new Error('NyaitterAuth requires --redirect-origin');
  const id = crypto.randomBytes(16).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  const key = `nyext_${id}_${secret}`;
  const record = { id, name, scopes, redirectOrigins, secretHash: crypto.createHash('sha256').update(secret).digest('hex'), createdAt: new Date().toISOString(), revokedAt: null };
  let written = false;
  try {
    if (outputPath) {
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(outputPath, key + '\n', { flag: 'wx', mode: 0o600 });
      written = true;
    }
    await mutateRegistry(keys => { keys.push(record); });
  } catch (error) {
    if (written) await fs.promises.unlink(outputPath).catch(() => {});
    throw error;
  }
  return { ...publicKey(record), key: outputPath ? undefined : key };
}

async function listKeys() {
  return (await readRegistry()).keys.map(publicKey);
}

async function revokeKey(id) {
  return mutateRegistry(keys => {
    const record = keys.find(key => key.id === id);
    if (!record) throw new Error('Extension key was not found');
    record.revokedAt ||= new Date().toISOString();
    return publicKey(record);
  });
}

async function authenticateKey(key, scope) {
  const match = /^nyext_([a-f0-9]{32})_([a-f0-9]{64})$/.exec(String(key || ''));
  if (!match) return null;
  const record = (await readRegistry()).keys.find(value => value.id === match[1]);
  if (!record || record.revokedAt || !record.scopes.includes(scope)) return null;
  const expected = Buffer.from(record.secretHash, 'hex');
  const actual = crypto.createHash('sha256').update(match[2]).digest();
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  return publicKey(record);
}

module.exports = { createKey, listKeys, revokeKey, authenticateKey };
