const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const StorageAdapter = require('../StorageAdapter');
const {
  createStorageFileName,
  getOriginalFileNameFromStorageKey,
  normalizeFolder,
  normalizeStorageKey,
} = require('../safeStoragePath');

const IMAGE_CONTENT_TYPES_BY_EXTENSION = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

class LocalStorageAdapter extends StorageAdapter {
  constructor(options = {}) {
    super();
    this.uploadDir = path.resolve(options.uploadDir || './uploads');
    this.publicEndpoint = typeof options.publicEndpoint === 'string'
      ? options.publicEndpoint.replace(/\/+$/, '') || null
      : null;
  }

  _getPublicUrl(normalizedKey) {
    return this.publicEndpoint ? `${this.publicEndpoint}/${normalizedKey}` : null;
  }

  async _ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
  }

  _resolveStorageKey(key) {
    const normalizedKey = normalizeStorageKey(key);
    const resolvedPath = path.resolve(this.uploadDir, ...normalizedKey.split('/'));
    const rootPrefix = `${this.uploadDir}${path.sep}`;

    if (!resolvedPath.startsWith(rootPrefix)) {
      throw new Error('Storage key resolves outside upload directory');
    }

    return { normalizedKey, resolvedPath };
  }

  async upload(params) {
    const { file, fileName, originalFileName, contentType, folder = 'attachments' } = params;
    const id = crypto.randomBytes(16).toString('hex');
    const target = this.createUploadTarget({ fileName, originalFileName, contentType, folder, id });
    return this.uploadToId({ ...params, id: target.id, key: target.key });
  }

  createUploadTarget({ fileName, originalFileName, contentType, folder = 'attachments', id = crypto.randomBytes(16).toString('hex') }) {
    const normalizedFolder = normalizeFolder(folder);
    const finalFileName = createStorageFileName(id, originalFileName || fileName, contentType);
    const { normalizedKey } = this._resolveStorageKey(`${normalizedFolder}/${finalFileName}`);
    return { id: normalizedKey, key: normalizedKey, url: this._getPublicUrl(normalizedKey) };
  }

  async uploadToId({ file, id, key }) {
    const targetKey = key || id;
    const { normalizedKey, resolvedPath } = this._resolveStorageKey(targetKey);

    await this._ensureDir(path.dirname(resolvedPath));

    if (Buffer.isBuffer(file)) {
      await fs.writeFile(resolvedPath, file);
    } else {
      const chunks = [];
      for await (const chunk of file) {
        chunks.push(chunk);
      }
      await fs.writeFile(resolvedPath, Buffer.concat(chunks));
    }

    return {
      id: normalizedKey,
      url: this._getPublicUrl(normalizedKey),
      key: normalizedKey,
    };
  }

  async delete(fileId) {
    const { resolvedPath } = this._resolveStorageKey(fileId);
    try {
      await fs.unlink(resolvedPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async getPublicUrl(fileId) {
    const { normalizedKey } = this._resolveStorageKey(fileId);
    return this._getPublicUrl(normalizedKey);
  }

  async read(fileId) {
    const { normalizedKey, resolvedPath } = this._resolveStorageKey(fileId);
    const buffer = await fs.readFile(resolvedPath);
    return {
      buffer,
      contentType: IMAGE_CONTENT_TYPES_BY_EXTENSION.get(path.extname(normalizedKey).toLowerCase()) || null,
    };
  }

  async copy(sourceFileId, destinationFileId) {
    const { resolvedPath: sourcePath } = this._resolveStorageKey(sourceFileId);
    const { normalizedKey: destinationKey, resolvedPath: destinationPath } = this._resolveStorageKey(destinationFileId);
    await this._ensureDir(path.dirname(destinationPath));
    await fs.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    return {
      id: destinationKey,
      key: destinationKey,
      url: this._getPublicUrl(destinationKey),
    };
  }

  async deleteMany(fileIds) {
    await Promise.all(fileIds.map((id) => this.delete(id)));
  }

  _resolveFolder(folder) {
    const normalizedFolder = normalizeFolder(folder);
    const resolvedPath = path.resolve(this.uploadDir, ...normalizedFolder.split('/'));
    const rootPrefix = `${this.uploadDir}${path.sep}`;
    if (!resolvedPath.startsWith(rootPrefix)) {
      throw new Error('Storage folder resolves outside upload directory');
    }
    return { normalizedFolder, resolvedPath };
  }

  async _walkFiles(directory, visit) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await this._walkFiles(filePath, visit);
      } else if (entry.isFile()) {
        await visit(filePath, entry.name);
      }
    }
  }

  async getUsage(folder) {
    const { resolvedPath } = this._resolveFolder(folder);
    let total = 0;
    await this._walkFiles(resolvedPath, async (filePath) => {
      const stat = await fs.stat(filePath);
      total += stat.size;
    });
    return total;
  }

  async listFiles(folder, { limit = 500 } = {}) {
    const { normalizedFolder, resolvedPath } = this._resolveFolder(folder);
    const maxItems = Math.min(1000, Math.max(1, Math.floor(Number(limit) || 500)));
    const files = [];
    await this._walkFiles(resolvedPath, async (filePath, fileName) => {
      const stat = await fs.stat(filePath);
      const relativePath = path.relative(resolvedPath, filePath).split(path.sep).join('/');
      files.push({
        id: `${normalizedFolder}/${relativePath}`,
        name: getOriginalFileNameFromStorageKey(`${normalizedFolder}/${relativePath}`),
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
      });
    });
    return files
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, maxItems);
  }
}

module.exports = LocalStorageAdapter;
