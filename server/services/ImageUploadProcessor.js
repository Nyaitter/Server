const sharp = require('sharp');
const { normalizeContentType } = require('../adapters/storage/safeStoragePath');

// Bound libvips memory usage and enable SIMD acceleration
sharp.cache({ memory: 50, files: 20, items: 100 });
sharp.simd(true);

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

class ImageUploadError extends Error {
  constructor(message, statusCode = 415) {
    super(message);
    this.name = 'ImageUploadError';
    this.statusCode = statusCode;
  }
}

function getInteger(value, fallback, { min, max }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function getImageOptions(options = {}) {
  const maxOutputSizeMB = getInteger(options.maxOutputSizeMB, 5, { min: 1, max: 20 });
  const webpQuality = getInteger(options.webpQuality, 82, { min: 40, max: 95 });
  const minWebpQuality = Math.min(
    webpQuality,
    getInteger(options.minWebpQuality, 60, { min: 30, max: 90 }),
  );

  const maxFrames = getInteger(options.maxFrames, 100, { min: 1, max: 300 });

  return {
    maxWidth: getInteger(options.maxWidth, 2560, { min: 1, max: 8192 }),
    maxHeight: getInteger(options.maxHeight, 2560, { min: 1, max: 8192 }),
    maxPixels: getInteger(options.maxPixels, 40_000_000, { min: 1_000_000, max: 100_000_000 }),
    maxFrames,
    webpQuality,
    minWebpQuality,
    maxOutputBytes: maxOutputSizeMB * 1024 * 1024,
  };
}

function isSupportedImage(contentType) {
  return SUPPORTED_IMAGE_TYPES.has(normalizeContentType(contentType));
}

async function readFileToBuffer(file, maxBytes) {
  if (Buffer.isBuffer(file)) {
    if (file.length > maxBytes) {
      throw new ImageUploadError('File too large', 413);
    }
    return file;
  }

  if (file instanceof Uint8Array) {
    const buffer = Buffer.from(file);
    if (buffer.length > maxBytes) {
      throw new ImageUploadError('File too large', 413);
    }
    return buffer;
  }

  if (!file || typeof file[Symbol.asyncIterator] !== 'function') {
    throw new ImageUploadError('Unsupported image upload body', 400);
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of file) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new ImageUploadError('File too large', 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

function createPipeline(input, options) {
  return sharp(input, {
    animated: true,
    pages: options.maxFrames || 100,
    limitInputPixels: options.maxPixels,
    failOn: 'error',
  })
    // EXIFの向きを画素に反映し、出力時にメタデータを引き継がない。
    .rotate()
    // 縦横比を変えず、上限を超える画像だけを縮小する。
    .resize({
      width: options.maxWidth,
      height: options.maxHeight,
      fit: 'inside',
      withoutEnlargement: true,
    });
}

async function encodeCompressedWebp(input, options) {
  // 回転・縮小までの共通パイプラインは一度だけ作成する。clone()した出力側だけを
  // 品質ごとに切り替えることで、上限を超えたときの再試行に伴う準備処理を減らす。
  const pipeline = createPipeline(input, options);

  for (let quality = options.webpQuality; quality >= options.minWebpQuality; quality -= 5) {
    // withMetadata() を呼ばないため、EXIF・位置情報・IPTC・XMPは出力されない。
    const output = await pipeline.clone()
      .webp({ quality, effort: 4, smartSubsample: true })
      .toBuffer();

    if (output.length <= options.maxOutputBytes) return output;
  }

  throw new ImageUploadError('Processed image exceeds the 5 MB limit', 413);
}

/**
 * 画像ファイルだけを正規化する。非画像ファイルは変更せず保存アダプターへ渡す。
 */
async function normalizeImageUpload(params, configuredOptions = {}) {
  const normalizedContentType = normalizeContentType(params?.contentType);
  if (!isSupportedImage(normalizedContentType)) return params;

  const options = getImageOptions(configuredOptions);
  const input = await readFileToBuffer(params.file, options.maxOutputBytes);
  if (input.length === 0) {
    throw new ImageUploadError('Image must not be empty', 400);
  }

  try {
    const output = await encodeCompressedWebp(input, options);
    return {
      ...params,
      file: output,
      // 表示用にはアップロード時の名前を残し、保存形式だけWebPへ統一する。
      originalFileName: params.originalFileName || params.fileName || 'image',
      // 形式と拡張子を一致させ、保存先と配信時のContent-Typeを正しくする。
      fileName: `${String(params.fileName || 'image').replace(/\.[A-Za-z0-9]{1,10}$/, '') || 'image'}.webp`,
      contentType: 'image/webp',
    };
  } catch (error) {
    if (error instanceof ImageUploadError) throw error;
    if (/Input image exceeds pixel limit/i.test(error?.message || '')) {
      throw new ImageUploadError('Image dimensions are too large', 413);
    }
    throw new ImageUploadError('Invalid or unsupported image data', 415);
  }
}

module.exports = {
  ImageUploadError,
  getImageOptions,
  isSupportedImage,
  normalizeImageUpload,
};
