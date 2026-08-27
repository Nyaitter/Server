const StorageAdapter = require('./StorageAdapter');
const { normalizeImageUpload } = require('../../services/ImageUploadProcessor');
const { normalizeFolder } = require('./safeStoragePath');

function getFileSize(file) {
  if (Buffer.isBuffer(file) || file instanceof Uint8Array) return file.byteLength;
  return null;
}

function getUserStorageFolder(folder) {
  const normalizedFolder = normalizeFolder(folder || 'attachments');
  return /^attachments\/\d+$/.test(normalizedFolder) ? normalizedFolder : null;
}

class StorageQuotaExceededError extends Error {
  constructor(limitBytes, usedBytes, requestedBytes) {
    super('Storage quota exceeded');
    this.name = 'StorageQuotaExceededError';
    this.code = 'STORAGE_QUOTA_EXCEEDED';
    this.limitBytes = limitBytes;
    this.usedBytes = usedBytes;
    this.requestedBytes = requestedBytes;
  }
}

class ImageNormalizingStorageAdapter extends StorageAdapter {
  constructor(storageAdapter, imageOptions = {}, { userQuotaMB = 1024 } = {}) {
    super();
    this.storageAdapter = storageAdapter;
    this.imageOptions = imageOptions;
    this.userQuotaBytes = Math.max(1, Math.floor(Number(userQuotaMB) || 1024)) * 1024 * 1024;
    this.uploadLocks = new Map();
  }

  async _withFolderUploadLock(folder, operation) {
    const previous = this.uploadLocks.get(folder) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.uploadLocks.set(folder, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.uploadLocks.get(folder) === current) this.uploadLocks.delete(folder);
    }
  }

  async upload(params) {
    // 画像はここで再エンコード済みなので、以降の判定は圧縮後の実サイズに基づく。
    const normalizedParams = await normalizeImageUpload(params, this.imageOptions);
    const userFolder = getUserStorageFolder(normalizedParams.folder);
    const fileSize = getFileSize(normalizedParams.file);
    if (!userFolder || fileSize == null || typeof this.storageAdapter.getUsage !== 'function') {
      return this.storageAdapter.upload(normalizedParams);
    }

    return this._withFolderUploadLock(userFolder, async () => {
      const usedBytes = await this.storageAdapter.getUsage(userFolder);
      if (usedBytes + fileSize > this.userQuotaBytes) {
        throw new StorageQuotaExceededError(this.userQuotaBytes, usedBytes, fileSize);
      }
      return this.storageAdapter.upload(normalizedParams);
    });
  }

  createUploadTarget(params) {
    return this.storageAdapter.createUploadTarget(params);
  }

  async uploadToId(params) {
    const normalizedParams = await normalizeImageUpload(params, this.imageOptions);
    const userFolder = getUserStorageFolder(normalizedParams.folder);
    const fileSize = getFileSize(normalizedParams.file);
    if (!userFolder || fileSize == null || typeof this.storageAdapter.getUsage !== 'function') {
      return this.storageAdapter.uploadToId(normalizedParams);
    }

    return this._withFolderUploadLock(userFolder, async () => {
      const usedBytes = await this.storageAdapter.getUsage(userFolder);
      let replacedBytes = 0;
      try {
        replacedBytes = Number((await this.storageAdapter.read(normalizedParams.id || normalizedParams.key)).buffer?.length) || 0;
      } catch (_) {}
      if (usedBytes - replacedBytes + fileSize > this.userQuotaBytes) {
        throw new StorageQuotaExceededError(this.userQuotaBytes, usedBytes - replacedBytes, fileSize);
      }
      return this.storageAdapter.uploadToId(normalizedParams);
    });
  }

  async delete(fileId) {
    return this.storageAdapter.delete(fileId);
  }

  async deleteMany(fileIds) {
    if (typeof this.storageAdapter.deleteMany === 'function') {
      return this.storageAdapter.deleteMany(fileIds);
    }
    return Promise.all(fileIds.map((fileId) => this.storageAdapter.delete(fileId)));
  }

  async getPublicUrl(fileId) {
    return this.storageAdapter.getPublicUrl(fileId);
  }

  async read(fileId) {
    return this.storageAdapter.read(fileId);
  }

  async copy(sourceFileId, destinationFileId) {
    return this.storageAdapter.copy(sourceFileId, destinationFileId);
  }

  async getUsage(folder) {
    return this.storageAdapter.getUsage(folder);
  }

  async listFiles(folder, options = {}) {
    return this.storageAdapter.listFiles(folder, options);
  }
}

module.exports = ImageNormalizingStorageAdapter;
module.exports.StorageQuotaExceededError = StorageQuotaExceededError;
