'use strict';

process.env.AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE = '1';
const originalEmitWarning = process.emitWarning ? process.emitWarning.bind(process) : null;
if (originalEmitWarning) {
    process.emitWarning = (warning, ...args) => {
        const name = typeof warning === 'object' ? warning?.name : (typeof args[0] === 'string' ? args[0] : '');
        const message = typeof warning === 'string' ? warning : (warning?.message || '');
        if (name === 'NodeVersionSupportWarning' || message.includes('AWS SDK') || message.includes('upgrade to node')) {
            return;
        }
        return originalEmitWarning(warning, ...args);
    };
}

require('dotenv').config({ path: __dirname + '/.env' });

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger-output.json');

const config = require('./config');
const { createDatabaseAdapter, createStorageAdapter } = require('./adapters');
const {
    csrfProtection,
    flexibleCors,
    securityHeaders,
    getAuthenticatedPrincipal,
} = require('./middleware/auth');
const {
    requestId,
    applyTrustProxy,
    requestLogger,
    httpCompression,
} = require('./middleware/system');
const { generalLimiter, authLimiter } = require('./middleware/rateLimit');
const ConnectionManager = require('./services/realtime/ConnectionManager');
const PushNotificationService = require('./services/PushNotificationService');
const { ModerationReportService } = require('./services/ModerationReportService');
const { startModerationAssignmentScheduler } = require('./services/ModerationAssignmentScheduler');
const { AutoModerationService } = require('./services/AutoModerationService');
const { startPollExpirationScheduler } = require('./services/PollExpirationScheduler');
const PostActionQueue = require('./services/PostActionQueue');
const PostKeywordBackfillService = require('./services/PostKeywordBackfillService');
const { serializeNotification } = require('./utils/serialize');
const { getPublicUrl } = require('./utils/nyaitterAddress');
const { startOperatorControlServer } = require('./utils/operatorControl');
const { getEmbeddedMailServer } = require('./services/mail/EmbeddedMailServer');
const { isCrawler, generatePostOgpTags, generatePostHtml } = require('./services/OgpService');
const LogHubManager = require('./services/managementTool/LogHubManager');
const ErrorManager = require('./services/managementTool/ErrorManager');

// NyaitterServer 本体の全標準出力を NMT Unified Logs にフック
LogHubManager.hookServerProcess('server');

let embeddedMailServer = null;

// ── Security Check ─────────────────────────────────────────────────────────────
if (process.env.DEV_BYPASS_AUTH === 'true') {
    const isProd = (process.env.NODE_ENV || 'development') === 'production';
    console.warn('\n⚠️  WARNING: DEV_BYPASS_AUTH is ENABLED');
    console.warn('     This completely disables authentication verification.');
    console.warn('     NEVER enable this in production or on publicly accessible servers.\n');
    if (isProd) {
        console.error('❌ FATAL: DEV_BYPASS_AUTH=true is not allowed in production. Refusing to start.');
        process.exit(1);
    }
}

// ── Server & App Setup ─────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');

const PORT = config.server.port;
const API_ENDPOINT = config.server.apiEndpoint;
const apiPath = (suffix = '') => {
    const normalizedSuffix = String(suffix || '').replace(/^\/+/, '');
    if (API_ENDPOINT === '/') return normalizedSuffix ? `/${normalizedSuffix}` : '/';
    return normalizedSuffix ? `${API_ENDPOINT}/${normalizedSuffix}` : API_ENDPOINT;
};

const httpServer = http.createServer(app);
// Reverse proxy / Keep-Alive optimization (prevents race conditions and socket thrashing)
httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 66000;

let userFilesServer = null;
const configuredUploadDir = config.storage?.local?.uploadDir || './uploads';
const uploadsDir = path.isAbsolute(configuredUploadDir)
    ? configuredUploadDir
    : path.resolve(process.cwd(), configuredUploadDir);
const userFilesEndpoint = config.userFiles?.endpoint;
const userFilesPort = config.userFiles?.port;
const userFilesStaticOptions = {
    maxAge: '7d',
    etag: true,
    lastModified: true,
    setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
    },
};

// 通常ポートのユーザーファイル配信は、同名のAPIアップロード操作ルートより先に登録する。
// express.staticはGET/HEAD以外を通過させるため、POST /<api>/uploadsは従来どおりAPIが処理する。
if (userFilesEndpoint && !userFilesPort) {
    app.use(userFilesEndpoint, express.static(uploadsDir, userFilesStaticOptions));
}

const realtimeConnections = new ConnectionManager();
const realtimeServer = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024,
    perMessageDeflate: false,
});
app.locals.realtime = realtimeConnections;

applyTrustProxy(app);

// ── Middleware Pipeline ────────────────────────────────────────────────────────
// API routes parse body and attach tracking headers; static files bypass body parser for low CPU/memory
app.use(httpCompression);
app.use(API_ENDPOINT, express.json({ limit: config.server.jsonBodyLimit }));
app.use(
    API_ENDPOINT,
    express.urlencoded({
        extended: true,
        limit: config.server.jsonBodyLimit,
        parameterLimit: 100,
    }),
);
app.use(API_ENDPOINT, requestId);
app.use(securityHeaders);
app.use(API_ENDPOINT, flexibleCors);
app.use(API_ENDPOINT, csrfProtection);
app.use(API_ENDPOINT, generalLimiter);
app.use(apiPath('/auth'), authLimiter);
app.use(API_ENDPOINT, requestLogger);

// API Documentation
app.use(apiPath('/apidocs'), swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// ── WebSocket Realtime Handling ────────────────────────────────────────────────
const allowedOriginsSet = new Set(config.cors.allowedOrigins || []);
allowedOriginsSet.add(`http://localhost:${PORT}`);
allowedOriginsSet.add(`http://127.0.0.1:${PORT}`);
if (config.federation?.publicUrl) {
    try {
        allowedOriginsSet.add(new URL(config.federation.publicUrl).origin);
    } catch (_) {}
}

function isAllowedRealtimeOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return true;

    const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = config.server.trustProxy && forwardedProto
        ? (forwardedProto === 'https' ? 'https' : 'http')
        : (request.socket.encrypted ? 'https' : 'http');
    const sameOrigin = request.headers.host && origin === `${protocol}://${request.headers.host}`;
    return sameOrigin || allowedOriginsSet.has(origin);
}

function rejectRealtimeUpgrade(socket, status, message) {
    try {
        socket.write(
            `HTTP/1.1 ${status} ${message}\r\n` +
            'Connection: close\r\n' +
            'Content-Length: 0\r\n\r\n',
        );
    } finally {
        socket.destroy();
    }
}

async function handleRealtimeUpgrade(request, socket, head) {
    let parsedUrl;
    try {
        parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    } catch (_) {
        return rejectRealtimeUpgrade(socket, 400, 'Bad Request');
    }
    if (parsedUrl.pathname !== apiPath('/realtime')) {
        return socket.destroy();
    }
    if (!isAllowedRealtimeOrigin(request)) {
        return rejectRealtimeUpgrade(socket, 403, 'Forbidden');
    }

    const authRequest = { headers: { ...request.headers }, app };
    let principal;
    try {
        principal = await getAuthenticatedPrincipal(authRequest);
    } catch (error) {
        console.warn('[realtime] WebSocket auth failed:', error.message);
        return rejectRealtimeUpgrade(socket, 500, 'Internal Server Error');
    }
    if (!principal) {
        return rejectRealtimeUpgrade(socket, 401, 'Unauthorized');
    }
    if (principal.accountOperation) {
        return rejectRealtimeUpgrade(socket, 423, 'Account maintenance in progress');
    }

    realtimeServer.handleUpgrade(request, socket, head, (webSocket) => {
        realtimeServer.emit('connection', webSocket, request, principal);
    });
}

httpServer.on('upgrade', (request, socket, head) => {
    void handleRealtimeUpgrade(request, socket, head);
});

realtimeServer.on('connection', (webSocket, _request, principal) => {
    const userId = principal.id;
    webSocket.isAlive = true;
    realtimeConnections.register(userId, webSocket, principal.sessionTokenHash);

    webSocket.on('pong', () => {
        webSocket.isAlive = true;
    });
    webSocket.on('message', (rawMessage, isBinary) => {
        if (isBinary) {
            webSocket.close(1003, 'Binary messages are not supported');
            return;
        }
        try {
            const message = JSON.parse(rawMessage.toString());
            if (message?.type === 'ping') {
                webSocket.send(JSON.stringify({ type: 'pong' }));
            }
        } catch (_) {}
    });
    webSocket.on('close', () => realtimeConnections.unregister(userId, webSocket));
    webSocket.on('error', () => realtimeConnections.unregister(userId, webSocket));

    Promise.all([
        realtimeConnections.publishNotificationUnreadCount(userId, app.locals.dbAdapter),
        realtimeConnections.publishDmUnreadCount(userId, app.locals.dbAdapter),
    ]).catch((error) => {
        console.warn('[realtime] Failed to publish initial unread counts:', error.message);
    });
});

const realtimeHeartbeat = setInterval(() => {
    for (const [userId, sockets] of realtimeConnections.connectionsByUser.entries()) {
        for (const webSocket of sockets) {
            if (webSocket.isAlive === false || webSocket.readyState !== 1) {
                realtimeConnections.unregister(userId, webSocket);
                try {
                    webSocket.terminate();
                } catch (_) {}
                continue;
            }
            webSocket.isAlive = false;
            try {
                webSocket.ping();
            } catch (_) {
                realtimeConnections.unregister(userId, webSocket);
                try {
                    webSocket.terminate();
                } catch (_) {}
            }
        }
    }
}, 30000);
realtimeHeartbeat.unref();

// ── Health & Readiness ─────────────────────────────────────────────────────────
app.get(apiPath('/health'), (req, res) => {
    const base = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '0.1.0',
        uptime: process.uptime(),
        env: process.env.NODE_ENV || 'development',
    };

    if (config.health?.detailed) {
        const db = app.locals.dbAdapter;
        const dbStatus = db && typeof db.connect === 'function' ? 'connected' : 'unknown';
        base.details = {
            database: dbStatus,
            adapter: config.database.adapter,
            storage: config.storage.adapter,
        };
    }

    res.json(base);
});

app.get(apiPath('/ready'), async (req, res) => {
    try {
        const db = app.locals.dbAdapter;
        if (db && typeof db.getUserById === 'function') {
            await db.getUserById(-1);
        }
        res.json({ status: 'ready', timestamp: new Date().toISOString() });
    } catch (err) {
        res.status(503).json({ status: 'not ready', error: err.message });
    }
});

// ── REST Routes ────────────────────────────────────────────────────────────────
const restRoutes = [
    ['', require('./routes/status')],
    ['posts', require('./routes/posts')],
    ['polls', require('./routes/polls')],
    ['uploads', require('./routes/uploads')],
    ['url-cards', require('./routes/urlCards')],
    ['ranking', require('./routes/ranking')],
    ['ui', require('./routes/ui')],
    ['dm', require('./routes/dm')],
    ['users', require('./routes/users')],
    ['imposters', require('./routes/imposters')],
    ['groups', require('./routes/groups')],
    ['notifications', require('./routes/notifications')],
    ['reports', require('./routes/reports')],
    ['appeals', require('./routes/appeals')],
    ['verification-applications', require('./routes/verificationApplications')],
    ['push', require('./routes/push')],
    ['rules', require('./routes/rules')],
    ['rule', require('./routes/rules')],
    ['auth/nyaitter-auth', require('./routes/nyaitterAuth')],
    ['nyaitter-auth', require('./routes/nyaitterAuth')],
    ['oembed', require('./routes/oembed')],
    ['spec', require('./routes/spec')],
    ['docs', require('./routes/docs')],
];

for (const [resourcePath, router] of restRoutes) {
    const resourceSuffix = resourcePath ? `/${resourcePath}` : '';
    app.use(apiPath(resourceSuffix), router);
    app.use(apiPath(`/api${resourceSuffix}`), router);
}

app.use(apiPath('/auth'), require('./routes/auth'));

// ── Root oEmbed Endpoint ───────────────────────────────────────────────────────
app.use('/api/oembed', require('./routes/oembed'));
app.use('/oembed', require('./routes/oembed'));

app.get('/favicon.ico', (req, res) => {
    const faviconPath = path.join(__dirname, '../page/favicon.png');
    if (fs.existsSync(faviconPath)) {
        return res.sendFile(faviconPath);
    }
    return res.status(204).end();
});

// ── Static Frontend Serving ────────────────────────────────────────────────────
const pageDir = path.join(__dirname, '../page');
const hasStaticPage = fs.existsSync(pageDir) && fs.statSync(pageDir).isDirectory();

if (hasStaticPage) {
    const indexRedirects = new Set(['/index', '/index.html', '/page/index', '/page/index.html', '/page', '/page/']);

    app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return next();
        }

        const urlPath = req.path;

        if (indexRedirects.has(urlPath)) {
            const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
            return res.redirect(301, '/' + query);
        }

        let cleanPath = urlPath.startsWith('/page/') ? '/' + urlPath.slice(6) : urlPath;

        if (cleanPath === '/login') {
            const rawQuery = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
            const query = new URLSearchParams(rawQuery);
            if (query.get('external_login') !== '1') query.set('login', '1');
            return res.redirect(302, `/?${query.toString()}`);
        }

        if (cleanPath === '/auth/external') {
            const rawQuery = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
            const query = new URLSearchParams(rawQuery);
            query.set('external_confirm', '1');
            return res.redirect(302, `/?${query.toString()}`);
        }

        // ── Dynamic OGP Rendering for Post URLs & Bot Crawlers ──
        let targetPostId = null;
        const postPathMatch = cleanPath.match(/^(?:\/@[^/]+)?\/posts?\/(\d+)$/i);
        if (postPathMatch) {
            targetPostId = Number(postPathMatch[1]);
        } else if (req.query.post) {
            targetPostId = Number(req.query.post);
        }

        if (targetPostId && Number.isInteger(targetPostId) && targetPostId > 0) {
            return (async () => {
                try {
                    const db = app.locals.dbAdapter;
                    const post = await db?.getPostById?.(targetPostId);
                    if (post) {
                        const author = await db?.getUserById?.(post.userId ?? post.user_id);
                        const publicUrl = getPublicUrl(req);
                        const userAgent = req.headers['user-agent'] || '';
                        if (isCrawler(userAgent)) {
                            const html = generatePostHtml({
                                post,
                                author,
                                publicUrl,
                                frontendUrl: config.frontendUrl || null,
                            });
                            res.setHeader('Content-Type', 'text/html; charset=utf-8');
                            return res.send(html);
                        }
                        const indexPath = path.join(pageDir, 'index.html');
                        if (fs.existsSync(indexPath)) {
                            const ogpTags = generatePostOgpTags({ post, author, publicUrl });
                            let html = fs.readFileSync(indexPath, 'utf8');
                            html = html.replace(/<title>.*?<\/title>/i, ogpTags);
                            res.setHeader('Content-Type', 'text/html; charset=utf-8');
                            return res.send(html);
                        }
                    }
                } catch (err) {
                    console.warn('[ogp] Failed to render post embed:', err.message);
                }
                const indexPath = path.join(pageDir, 'index.html');
                if (fs.existsSync(indexPath)) {
                    return res.sendFile(indexPath);
                }
                return res.status(404).send('Post not found');
            })();
        }

        if (cleanPath.endsWith('.html')) {
            const targetPath = cleanPath.slice(0, -5);
            const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
            return res.redirect(301, (targetPath || '/') + query);
        }

        if (!path.extname(cleanPath) && cleanPath !== '/') {
            const htmlFilePath = path.join(pageDir, cleanPath + '.html');
            if (fs.existsSync(htmlFilePath) && fs.statSync(htmlFilePath).isFile()) {
                return res.sendFile(htmlFilePath);
            }
        }

        next();
    });

    app.use(
        express.static(pageDir, {
            index: 'index.html',
            extensions: ['html'],
            etag: true,
            lastModified: true,
            setHeaders: (res, filePath) => {
                if (filePath.endsWith('/sw.js') || filePath.endsWith('\\sw.js')) {
                    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                    return;
                }
                if (filePath.endsWith('.webmanifest')) {
                    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
                }
                res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
            },
        }),
    );
} else {
    console.info('[server] page/ directory not found; static file serving is disabled.');
}

// ── User Files Serving ─────────────────────────────────────────────────────────
// 専用ポートでは別Expressアプリにのみ公開し、通常ポートでは上でAPIルートより先に登録済み。
if (userFilesEndpoint && userFilesPort) {
    const userFilesApp = express();
    userFilesApp.disable('x-powered-by');
    userFilesApp.use(userFilesEndpoint, express.static(uploadsDir, userFilesStaticOptions));
    userFilesServer = http.createServer(userFilesApp);
}

let postShareServer = null;

let managementToolServer = null;

// ── Request Monitoring Hook (NMT) ──────────────────────────────────────────────
app.use((req, res, next) => {
    if (!config.nmt?.enabled) return next();
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        if (managementToolServer) {
            managementToolServer.recordRequest(req, res, duration);
        }
    });
    next();
});

// ── Error & 404 Handlers ───────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[server] Unhandled error:', err);
    if (managementToolServer) {
        managementToolServer.recordError(err, {
            method: req.method,
            url: req.originalUrl || req.url,
            userId: req.user?.id || null,
            ip: req.headers['cf-connecting-ip'] || req.ip,
            userAgent: req.headers['user-agent'],
            requestId: req.id || undefined,
        });
    } else {
        const errorContext = {
            method: req.method,
            url: req.originalUrl || req.url,
            userId: req.user?.id || null,
            ip: req.headers['cf-connecting-ip'] || req.ip,
            userAgent: req.headers['user-agent'],
            requestId: req.id || undefined,
        };
        ErrorManager.recordExternalError(err, errorContext);
        LogHubManager.appendExternalLog({
            type: 'error',
            level: 'error',
            source: 'nyaitter-server',
            message: `${req.method} ${req.originalUrl || req.url} - ${err.message}`,
            details: { stack: err.stack, userId: req.user?.id || null },
        });
    }

    const status = err.status || 500;
    const isDev = process.env.NODE_ENV === 'development';

    res.status(status).json({
        error: err.name || 'Internal Server Error',
        message: isDev ? err.message : 'An unexpected error occurred',
        ...(isDev && { stack: err.stack }),
        requestId: req.id || undefined,
    });
});

if (API_ENDPOINT !== '/') {
    app.use(API_ENDPOINT, (req, res) => {
        res.status(404).json({
            error: 'Not Found',
            path: req.originalUrl,
        });
    });
}

// ── Services & Server Bootstrap ────────────────────────────────────────────────
const dbAdapter = createDatabaseAdapter();
const storageAdapter = createStorageAdapter();
let operatorControl = null;
let moderationScheduler = null;
let pollExpirationScheduler = null;

const pushNotificationService = new PushNotificationService({
    dbAdapter,
    pushConfig: config.push,
    realtime: realtimeConnections,
});

async function publishModerationNotification(userId, notification) {
    const structured = await serializeNotification(dbAdapter, notification, getPublicUrl());
    if (!structured) return;
    try {
        await realtimeConnections.publishNewNotification(userId, structured, dbAdapter);
    } catch (error) {
        console.warn('[moderation] realtime delivery failed:', error.message);
    }
    if (pushNotificationService.enabled) {
        void pushNotificationService
            .sendNotificationToUser(userId, structured)
            .catch((error) => {
                console.warn('[moderation] push delivery failed:', error.message);
            });
    }
}

const moderationReportService = new ModerationReportService({
    dbAdapter,
    storageAdapter,
    publishNotification: publishModerationNotification,
});
const autoModerationService = new AutoModerationService({
    dbAdapter,
    storageAdapter,
    publishNotification: publishModerationNotification,
    moderationConfig: config.autoMod,
});
const postActionQueue = new PostActionQueue();
const postKeywordBackfillQueue = new PostActionQueue({ maxPendingJobs: 2000 });
const postKeywordBackfillService = new PostKeywordBackfillService({ postActionQueue: postKeywordBackfillQueue });
dbAdapter.postKeywordBackfillService = postKeywordBackfillService;

app.locals.pushNotificationService = pushNotificationService;
app.locals.moderationReportService = moderationReportService;
app.locals.autoModerationService = autoModerationService;
app.locals.postActionQueue = postActionQueue;
app.locals.postKeywordBackfillQueue = postKeywordBackfillQueue;
app.locals.postKeywordBackfillService = postKeywordBackfillService;

async function startServer() {
    await dbAdapter.connect();
    app.locals.dbAdapter = dbAdapter;
    app.locals.storageAdapter = storageAdapter;
    managementToolServer?.setDbAdapter(dbAdapter);
    managementToolServer?.setServerControls({
        shutdownFn: shutdown,
        getStatusFn: () => ({
            pid: process.pid,
            port: PORT,
            databaseAdapter: config.database.adapter,
            storageAdapter: config.storage?.adapter || 'local',
            startedAt: new Date().toISOString(),
        }),
    });
    moderationScheduler = startModerationAssignmentScheduler(moderationReportService);
    pollExpirationScheduler = startPollExpirationScheduler(dbAdapter, realtimeConnections, pushNotificationService);
    operatorControl = await startOperatorControlServer({
        dbAdapter,
        shutdown,
        getStatus: () => ({
            pid: process.pid,
            port: PORT,
            databaseAdapter: config.database.adapter,
            storageAdapter: config.storage?.adapter || 'local',
            startedAt: new Date().toISOString(),
        }),
        managers: {
            errorManager:        managementToolServer?.errorManager        || null,
            securityManager:     managementToolServer?.securityManager     || null,
            notificationManager: managementToolServer?.notificationManager || null,
            approvalManager:     managementToolServer?.approvalManager     || null,
            adminAuditFn:        () => managementToolServer?.adminManager?.getAuditLogs?.() || [],
            logHub:              managementToolServer?.logHub              || null,
        },
    });
    console.log(`[operator-control] Listening on ${operatorControl.socketPath}`);

    httpServer.listen(PORT, async () => {
        console.log(`
╔══════════════════════════════════════════════════════════════
║  Nyaitter Server                                           
╠══════════════════════════════════════════════════════════════
║  Server running at:   http://localhost:${PORT}
║
║  Health check:        http://localhost:${PORT}${apiPath('/health')}
║  Frontend (SPA):      http://localhost:${PORT}/
║
║  DB Adapter:      ${process.env.DB_ADAPTER || 'memory'}
║  Storage Adapter: ${process.env.STORAGE_ADAPTER || 'local'}
║  AutoMod:         ${autoModerationService.enabled ? 'enabled' : 'disabled'}
╚══════════════════════════════════════════════════════════════
`);
        if (userFilesServer) {
            userFilesServer.once('error', (error) => {
                console.error(`[user-files] Failed to listen on port ${userFilesPort}:`, error.message);
            });
            userFilesServer.listen(userFilesPort, () => {
                console.log(`[user-files] Serving ${userFilesEndpoint} on http://localhost:${userFilesPort}${userFilesEndpoint}`);
            });
        }

        const sharePort = config.postSharePort ? Number(config.postSharePort) : null;
        if (sharePort && sharePort !== PORT && Number.isInteger(sharePort) && sharePort > 0) {
            postShareServer = http.createServer(app);
            postShareServer.once('error', (error) => {
                console.error(`[share-server] Failed to listen on port ${sharePort}:`, error.message);
            });
            postShareServer.listen(sharePort, () => {
                console.log(`[share-server] Listening for post share traffic on http://localhost:${sharePort}`);
            });
        }

        const embeddedMailConfig = config.auth?.methods?.email?.embeddedServer;
        if (embeddedMailConfig?.enabled) {
            embeddedMailServer = getEmbeddedMailServer(embeddedMailConfig);
            await embeddedMailServer.start().catch((err) => {
                console.error('[mail-server] Failed to start embedded mail server:', err.message);
            });
        }

        console.log('[server] Ready. DB Adapter initialized.');
    });
}

startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

// ── Graceful Shutdown ──────────────────────────────────────────────────────────
let isShuttingDown = false;

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n[server] ${signal} received. Starting graceful shutdown...`);

    const forceExitTimeout = setTimeout(() => {
        console.error('[server] Graceful shutdown timed out. Forcing exit.');
        process.exit(1);
    }, 10000);
    forceExitTimeout.unref();

    try {
        clearInterval(realtimeHeartbeat);
        moderationScheduler?.stop();
        moderationScheduler = null;
        pollExpirationScheduler?.stop();
        pollExpirationScheduler = null;
        autoModerationService.stop();
        postKeywordBackfillService.stop();
        postKeywordBackfillQueue.stop();
        postActionQueue.stop();
        realtimeConnections.closeAll();
        // NMT は独立プロセスとして稼働し続けるためここでは stop しない
        if (managementToolServer) {
            managementToolServer = null;
        }
        if (operatorControl) {
            await operatorControl.close();
            operatorControl = null;
        }
        if (embeddedMailServer) {
            await embeddedMailServer.close();
            embeddedMailServer = null;
        }
        await new Promise((resolve) => {
            if (!httpServer.listening) return resolve();
            httpServer.close(() => resolve());
        });
        await new Promise((resolve) => {
            if (!userFilesServer?.listening) return resolve();
            userFilesServer.close(() => resolve());
        });
        userFilesServer = null;
        await new Promise((resolve) => {
            if (!postShareServer?.listening) return resolve();
            postShareServer.close(() => resolve());
        });
        postShareServer = null;

        if (dbAdapter && typeof dbAdapter.disconnect === 'function') {
            await dbAdapter.disconnect();
            console.log('[server] Database adapter disconnected.');
        }

        if (storageAdapter && typeof storageAdapter.disconnect === 'function') {
            await storageAdapter.disconnect?.();
        }

        console.log('[server] Graceful shutdown complete. Exiting.');
        process.exit(0);
    } catch (err) {
        console.error('[server] Error during shutdown:', err);
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
    if (err && (err.code === 'EPIPE' || err.code === 'EIO' || err.code === 'EBADF')) {
        return;
    }
    console.error('[server] Uncaught Exception:', err);
    if (managementToolServer) {
        managementToolServer.recordError(err, { source: 'uncaughtException' });
    } else {
        ErrorManager.recordExternalError(err, { source: 'uncaughtException' });
        LogHubManager.appendExternalLog({
            type: 'error',
            level: 'error',
            source: 'uncaughtException',
            message: `Uncaught Exception: ${err.message}`,
            details: { stack: err.stack },
        });
    }
    shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
    console.error('[server] Unhandled Rejection:', reason);
    const err = reason instanceof Error ? reason : new Error(String(reason));
    if (managementToolServer) {
        managementToolServer.recordError(err, { source: 'unhandledRejection' });
    } else {
        ErrorManager.recordExternalError(err, { source: 'unhandledRejection' });
        LogHubManager.appendExternalLog({
            type: 'error',
            level: 'error',
            source: 'unhandledRejection',
            message: `Unhandled Rejection: ${err.message}`,
            details: { stack: err.stack },
        });
    }
});
