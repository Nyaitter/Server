'use strict';

const crypto = require('crypto');
const config = require('../config');

const REQUEST_ID_REGEX = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Request ID middleware
 * Adds a unique request ID to every request (for tracing)
 */
function requestId(req, res, next) {
  const header = config.logging?.requestIdHeader || 'x-request-id';
  let id = req.headers[header] || req.headers[header.toLowerCase()];

  // 外部から渡されるトレースIDはログ・レスポンスヘッダーに反映されるため、
  // 可視ASCIIの短い値だけを許可してヘッダー／ログ注入を防ぐ。
  if (typeof id !== 'string' || !REQUEST_ID_REGEX.test(id)) {
    id = crypto.randomBytes(8).toString('hex');
  }

  req.id = id;
  res.setHeader(header, id);
  next();
}

/**
 * Apply trust proxy setting to the app
 * Must be called before any middleware that uses req.ip
 */
function applyTrustProxy(app) {
  if (config.server?.trustProxy) {
    app.set('trust proxy', true);
    console.log('[system] trust proxy enabled');
  }
}

/**
 * Enhanced request logger
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  const { method } = req;
  const path = (req.originalUrl || req.url || '').split('?')[0];

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';
    const reqPrefix = req.id ? `[${req.id}] ` : '';

    console.log(
      `${level} ${reqPrefix}${method} ${path} ${res.statusCode} ${duration}ms`
    );
  });

  next();
}

const zlib = require('zlib');

/**
 * High-performance built-in response compression middleware (gzip / deflate)
 * Reduces large JSON timeline/post payloads by up to 90%
 */
function httpCompression(req, res, next) {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (!acceptEncoding || req.method === 'HEAD') {
    return next();
  }

  const useGzip = acceptEncoding.includes('gzip');
  const useDeflate = !useGzip && acceptEncoding.includes('deflate');
  if (!useGzip && !useDeflate) {
    return next();
  }

  const originalSend = res.send;
  res.send = function (body) {
    if (res.headersSent) {
      return originalSend.call(this, body);
    }

    // Only compress text and JSON payloads larger than 1KB
    const contentType = res.getHeader('Content-Type') || '';
    const isCompressible = typeof contentType === 'string' && (
      contentType.includes('application/json') ||
      contentType.includes('text/') ||
      contentType.includes('application/javascript')
    );

    let buffer;
    if (typeof body === 'string') {
      buffer = Buffer.from(body);
    } else if (Buffer.isBuffer(body)) {
      buffer = body;
    } else if (body && typeof body === 'object') {
      buffer = Buffer.from(JSON.stringify(body));
      if (!contentType) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }

    if (!buffer || buffer.length < 1024 || (contentType && !isCompressible)) {
      return originalSend.call(this, body);
    }

    const encoding = useGzip ? 'gzip' : 'deflate';
    const compressAsync = useGzip ? zlib.gzip : zlib.deflate;

    compressAsync(buffer, { level: 4 }, (err, compressed) => {
      if (err || !compressed || res.destroyed) {
        return originalSend.call(res, body);
      }
      res.setHeader('Content-Encoding', encoding);
      res.removeHeader('Content-Length');
      res.setHeader('Vary', 'Accept-Encoding');
      return originalSend.call(res, compressed);
    });
  };

  next();
}

module.exports = {
  requestId,
  applyTrustProxy,
  requestLogger,
  httpCompression,
};