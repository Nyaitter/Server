process.env.AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE = '1';

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const StorageAdapter = require('../StorageAdapter');
const crypto = require('crypto');
const {
  createStorageFileName,
  getOriginalFileNameFromStorageKey,
  normalizeFolder,
  normalizeStorageKey,
} = require('../safeStoragePath');

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class R2StorageAdapter extends StorageAdapter {
  constructor(options = {}) {
    super();

    const r2Config = options.r2 || options || {};

    this.bucket = r2Config.bucket || options.bucket || process.env.R2_BUCKET;
    this.publicDomain = r2Config.publicDomain || options.publicDomain || options.publicUrl || process.env.R2_PUBLIC_DOMAIN;
    this.publicBaseUrl = this.publicDomain
      ? String(this.publicDomain).trim().replace(/\/+$/, '')
      : null;

    if (!this.bucket) {
      throw new Error('R2 bucket name is required');
    }

    const accountId = r2Config.accountId || process.env.R2_ACCOUNT_ID;
    this.cacheControl = typeof r2Config.cacheControl === 'string' && r2Config.cacheControl.trim()
      ? r2Config.cacheControl.trim()
      : 'public, max-age=31536000, immutable';
    this.signedUrlCacheSeconds = Math.max(0, Number(r2Config.signedUrlCacheSeconds) || 0);
    this.retryAttempts = Math.max(0, Number(r2Config.retryAttempts) || 0);
    this.retryBaseDelayMs = Math.max(0, Number(r2Config.retryBaseDelayMs) || 0);
    // R2のS3 APIはDeleteObjectsを実装していないため、単体削除の並行数を抑える。
    this.deleteConcurrency = Math.min(32, Math.max(1, Math.floor(Number(r2Config.deleteConcurrency) || 8)));
    this.signedUrlCache = new Map();
    // テスト時のみ差し替え可能。通常はAWS SDKの署名関数を使用する。
    this.signUrl = options.getSignedUrl || getSignedUrl;

    this.client = new S3Client({
      region: 'auto',
      endpoint: accountId
        ? `https://${accountId}.r2.cloudflarestorage.com`
        : undefined,
      credentials: {
        accessKeyId: r2Config.accessKeyId || process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: r2Config.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }

  _getPublicUrlForKey(key) {
    return this.publicBaseUrl ? `${this.publicBaseUrl}/${key}` : null;
  }

  _isRetryable(error) {
    const statusCode = Number(
      error?.$metadata?.httpStatusCode
      || error?.statusCode
      || error?.status,
    );
    return !Number.isInteger(statusCode)
      || statusCode === 408
      || statusCode === 425
      || statusCode === 429
      || statusCode >= 500;
  }

  async _send(command, { retry = true } = {}) {
    let attempt = 0;
    while (true) {
      try {
        return await this.client.send(command);
      } catch (error) {
        if (!retry || attempt >= this.retryAttempts || !this._isRetryable(error)) throw error;
        const delay = this.retryBaseDelayMs * (2 ** attempt);
        attempt += 1;
        if (delay > 0) await sleep(delay);
      }
    }
  }

  _readCachedSignedUrl(cacheKey) {
    const cached = this.signedUrlCache.get(cacheKey);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.signedUrlCache.delete(cacheKey);
      return null;
    }
    return cached.url;
  }

  async _getSignedUrlCached(cacheKey, command, expiresIn) {
    const cached = this._readCachedSignedUrl(cacheKey);
    if (cached) return cached;

    const url = await this.signUrl(this.client, command, { expiresIn });
    const cacheSeconds = Math.min(
      this.signedUrlCacheSeconds,
      Math.max(0, Number(expiresIn) - 30),
    );
    if (cacheSeconds > 0) {
      this.signedUrlCache.set(cacheKey, {
        url,
        expiresAt: Date.now() + cacheSeconds * 1000,
      });
    }
    return url;
  }

  _clearSignedUrlCacheForKey(key) {
    for (const cacheKey of this.signedUrlCache.keys()) {
      if (cacheKey.includes(`:${key}:`) || cacheKey.endsWith(`:${key}`)) {
        this.signedUrlCache.delete(cacheKey);
      }
    }
  }

  async upload(params) {
    const { file, fileName, originalFileName, contentType, folder = 'attachments' } = params;
    const id = crypto.randomBytes(16).toString('hex');
    const target = this.createUploadTarget({ fileName, originalFileName, contentType, folder, id });
    return this.uploadToId({ ...params, id: target.id, key: target.key });
  }

  createUploadTarget({ fileName, originalFileName, contentType, folder = 'attachments', id = crypto.randomBytes(16).toString('hex') }) {
    const normalizedFolder = normalizeFolder(folder);
    const key = normalizeStorageKey(`${normalizedFolder}/${createStorageFileName(id, originalFileName || fileName, contentType)}`);
    return { id: key, key, url: this._getPublicUrlForKey(key) };
  }

  async uploadToId({ file, id, key, contentType }) {
    const targetKey = normalizeStorageKey(key || id);

    // AWS SDK v3 accepts Buffer and Node.js Readable bodies directly. Do not
    // concatenate async iterable chunks here: R2 can receive the stream while
    // it is read, which avoids a second full-size buffer in memory.
    await this._send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: targetKey,
        Body: file,
        ContentType: contentType || 'application/octet-stream',
        CacheControl: this.cacheControl || undefined,
      }),
      // 読み込みストリームは失敗後に先頭から再利用できないため、再試行は
      { retry: Buffer.isBuffer(file) || file instanceof Uint8Array },
    );

    const url = this._getPublicUrlForKey(targetKey);
    return { id: targetKey, url, key: targetKey };
  }

  async delete(fileId) {
    const key = normalizeStorageKey(fileId);
    await this._send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
    this._clearSignedUrlCacheForKey(key);
  }

  async getPublicUrl(fileId) {
    const key = normalizeStorageKey(fileId);
    const publicUrl = this._getPublicUrlForKey(key);
    if (publicUrl) return publicUrl;

    const expiresIn = 3600;
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return this._getSignedUrlCached(`download:${key}:${expiresIn}`, command, expiresIn);
  }

  async read(fileId) {
    const key = normalizeStorageKey(fileId);
    const result = await this._send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
    const body = result?.Body;
    if (!body) throw new Error('R2 object body is unavailable');

    let buffer;
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      buffer = Buffer.from(body);
    } else if (typeof body.transformToByteArray === 'function') {
      buffer = Buffer.from(await body.transformToByteArray());
    } else {
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      buffer = Buffer.concat(chunks);
    }
    return {
      buffer,
      contentType: result.ContentType || null,
    };
  }

  async copy(sourceFileId, destinationFileId) {
    const sourceKey = normalizeStorageKey(sourceFileId);
    const destinationKey = normalizeStorageKey(destinationFileId);
    const source = await this.read(sourceKey);
    await this._send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: destinationKey,
      Body: source.buffer,
      ContentType: source.contentType || 'application/octet-stream',
      CacheControl: this.cacheControl || undefined,
    }));
    return {
      id: destinationKey,
      key: destinationKey,
      url: this._getPublicUrlForKey(destinationKey),
    };
  }

  async deleteMany(fileIds) {
    const keys = [...new Set((fileIds || []).map((fileId) => normalizeStorageKey(fileId)))];
    if (keys.length === 0) return;

    // Cloudflare R2ではDeleteObjectsが未実装のため、単体DeleteObjectを使う。
    // ただし直列化せず、負荷を限定したワーカープールで往復待ち時間を短縮する。
    let nextIndex = 0;
    const workerCount = Math.min(this.deleteConcurrency, keys.length);
    const worker = async () => {
      while (nextIndex < keys.length) {
        const key = keys[nextIndex];
        nextIndex += 1;
        await this.delete(key);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  _getFolderPrefix(folder) {
    return `${normalizeFolder(folder)}/`;
  }

  async _listObjects(folder) {
    const prefix = this._getFolderPrefix(folder);
    const objects = [];
    let continuationToken = undefined;
    do {
      const page = await this._send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }));
      objects.push(...(Array.isArray(page.Contents) ? page.Contents : []));
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  }

  async getUsage(folder) {
    const objects = await this._listObjects(folder);
    return objects.reduce((total, object) => total + Math.max(0, Number(object.Size) || 0), 0);
  }

  async listFiles(folder, { limit = 500 } = {}) {
    const maxItems = Math.min(1000, Math.max(1, Math.floor(Number(limit) || 500)));
    const prefix = this._getFolderPrefix(folder);
    const objects = await this._listObjects(folder);
    return objects
      .filter((object) => object.Key && !String(object.Key).endsWith('/'))
      .map((object) => ({
        id: normalizeStorageKey(object.Key),
        name: getOriginalFileNameFromStorageKey(object.Key),
        size: Math.max(0, Number(object.Size) || 0),
        updatedAt: object.LastModified ? new Date(object.LastModified).toISOString() : null,
      }))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, maxItems);
  }

  async getSignedUploadUrl(key, contentType, expiresInSeconds = 3600) {
    const normalizedKey = normalizeStorageKey(key);
    const expiresIn = Math.max(60, Math.min(Number(expiresInSeconds) || 3600, 86400));
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: normalizedKey,
      ContentType: contentType,
      CacheControl: this.cacheControl || undefined,
    });

    const uploadUrl = await this._getSignedUrlCached(
      `upload:${normalizedKey}:${contentType || ''}:${expiresIn}`,
      command,
      expiresIn,
    );
    return {
      uploadUrl,
      publicUrl: this._getPublicUrlForKey(normalizedKey),
      key: normalizedKey,
    };
  }
}

module.exports = R2StorageAdapter;
