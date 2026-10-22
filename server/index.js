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

if (config.server.maintenanceMode) {
    console.warn('[server] メンテナンスモードが有効です。サーバーの起動を拒否しています。解除するまでアクセスを受け付けません。');
    if (process.env.pm_id !== undefined) {
        setInterval(() => {}, 60 * 60 * 1000);
    }
    return;
}

const { createDatabaseAdapter, createStorageAdapter } = require('./adapters');
const DatabaseAdapter = require('./adapters/database/DatabaseAdapter');
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
const { createRateLimiter, generalLimiter, authLimiter } = require('./middleware/rateLimit');
const healthLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120 });
const { rejectExcessiveOffset } = require('./middleware/pagination');
const ConnectionManager = require('./services/realtime/ConnectionManager');
const PushNotificationService = require('./services/PushNotificationService');
const { ModerationReportService } = require('./services/ModerationReportService');
const { configureNotificationDelivery } = require('./services/NotificationDeliveryService');
const { startModerationAssignmentScheduler } = require('./services/ModerationAssignmentScheduler');
const { AutoModerationService } = require('./services/AutoModerationService');
const { startPollExpirationScheduler } = require('./services/PollExpirationScheduler');
const { startScheduledPostPublisher } = require('./services/ScheduledPostPublisher');
const { AccountRecoveryService } = require('./services/auth/AccountRecoveryService');
const { startAccountRecoveryScheduler } = require('./services/AccountRecoveryScheduler');
const PostActionQueue = require('./services/PostActionQueue');
const PostEventOutbox = require('./services/PostEventOutbox');
const PostKeywordBackfillService = require('./services/PostKeywordBackfillService');
const { getPublicUrl, getFrontendUrl, getPostShareUrl } = require('./utils/nyaitterAddress');
const { startOperatorControlServer } = require('./utils/operatorControl');
const { getEmbeddedMailServer } = require('./services/mail/EmbeddedMailServer');
const {
    isCrawler,
    generatePostOgpTags,
    generatePostHtml,
    generateGroupHtml,
    generateStageHtml,
} = require('./services/OgpService');
const { getPublicGroup, getPublicStage } = require('./services/EmbedService');
const { getGuestCallSession } = require('./services/GuestCallSessionService');

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

const PORT = config.server.port || 3000;
const LISTEN_HOST = config.server.listenHost;
const DISPLAY_HOST = LISTEN_HOST || 'localhost';
const USER_FILES_HOST = config.userFiles.listenHost;
const POST_SHARE_HOST = config.postShareListenHost;
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
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    },
};

// 通常ポートのユーザーファイル配信は、同名のAPIアップロード操作ルートより先に登録する。
// express.staticはGET/HEAD以外を通過させるため、POST /<api>/uploadsはAPIルートが処理する。
if (userFilesEndpoint && !userFilesPort) {
    app.use(userFilesEndpoint, express.static(uploadsDir, userFilesStaticOptions));
}

const realtimeConnections = new ConnectionManager();
realtimeConnections.startHeartbeat(30000);
const realtimeServer = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
});
app.locals.realtime = realtimeConnections;
const { CallService } = require('./services/CallService');
const calls = new CallService(realtimeConnections, () => app.locals.dbAdapter);
app.locals.calls = calls;

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
app.use(flexibleCors);
app.use(API_ENDPOINT, csrfProtection);
const healthPaths = new Set([apiPath('/health'), apiPath('/ready')]);
app.use(API_ENDPOINT, (req, res, next) => {
    const requestPath = String(req.originalUrl || req.url || '').split('?', 1)[0].replace(/\/+$/, '') || '/';
    if (healthPaths.has(requestPath)) return next();
    return generalLimiter(req, res, next);
});
// Bound deep OFFSET requests before they reach SQL-backed listing routes.
app.use(API_ENDPOINT, rejectExcessiveOffset);
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
    } catch (_) {
        // 不正な publicUrl は許可オリジンに追加しない。
    }
}

const wsUpgradeAttempts = new Map();
function checkWsUpgradeRateLimit(ip) {
    const now = Date.now();
    const entry = wsUpgradeAttempts.get(ip) || { count: 0, resetTime: now + 60000 };
    if (now >= entry.resetTime) {
        entry.count = 0;
        entry.resetTime = now + 60000;
    }
    entry.count += 1;
    wsUpgradeAttempts.set(ip, entry);
    if (wsUpgradeAttempts.size > 10000) {
        const oldest = wsUpgradeAttempts.keys().next().value;
        if (oldest) wsUpgradeAttempts.delete(oldest);
    }
    return entry.count <= 60; // Max 60 upgrade attempts per minute per IP
}

function isAllowedRealtimeOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return true;

    const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = config.server.trustProxy && forwardedProto
        ? (forwardedProto === 'https' ? 'https' : 'http')
        : (request.socket.encrypted ? 'https' : 'http');
    const sameOrigin = request.headers.host && origin === `${protocol}://${request.headers.host}`;
    return sameOrigin || config.cors?.allowUnknownClient === true || allowedOriginsSet.has(origin);
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
    const clientIp = request.socket?.remoteAddress || 'unknown';
    if (!checkWsUpgradeRateLimit(clientIp)) {
        return rejectRealtimeUpgrade(socket, 429, 'Too Many Requests');
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
        const guestToken = String(request.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('nyaitter_stage_guest='))?.slice('nyaitter_stage_guest='.length);
        const guest = getGuestCallSession(guestToken);
        if (!guest) return rejectRealtimeUpgrade(socket, 401, 'Unauthorized');
        principal = { id: guest.guestId, guestStageId: guest.stageId, guest: true };
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

// スペースのテキスト購読とボイス通話のシグナリングを WebSocket 上で処理する。
// メンバー権限は DB から毎回確認する（メモリ上の在室状態だけを信用しない）。
async function handleRealtimeSpaceMessage(webSocket, userId, message) {
    if (!message || typeof message.type !== 'string' || !message.type.startsWith('space:')) return;
    const db = app.locals.dbAdapter;
    if (!db) return;
    const spaceId = String(message.spaceId || '').trim();
    if (!spaceId) return;

    const membership = await db.getSpaceMember(spaceId, userId).catch(() => null);
    const space = await db.getSpaceById(spaceId).catch(() => null);
    if (!space) return;
    if (!membership && Number(space.ownerId ?? space.owner_id) !== Number(userId)) return;

    if (message.type === 'space:subscribe') {
        realtimeConnections.subscribeToSpace(userId, spaceId);
        return;
    }

    if (message.type === 'space:unsubscribe') {
        realtimeConnections.unsubscribeFromSpace(userId, spaceId);
        return;
    }

    if (message.type === 'space:join_voice') {
        const channelId = String(message.channelId || '').trim();
        if (!channelId) return;
        const channel = await db.getSpaceChannel(channelId).catch(() => null);
        if (!channel || String(channel.spaceId ?? channel.space_id) !== spaceId || (channel.kind || 'text') !== 'voice') return;
        const roster = realtimeConnections.joinSpaceVoice(userId, spaceId, channelId, webSocket, {
            muted: Boolean(message.muted),
            deafened: Boolean(message.deafened),
        });
        webSocket.send(JSON.stringify({ type: 'space_voice_roster', space_id: spaceId, channel_id: channelId, roster }));
        return;
    }

    if (message.type === 'space:leave_voice') {
        const channelId = String(message.channelId || '').trim();
        if (!channelId) return;
        const roster = realtimeConnections.leaveSpaceVoice(userId, spaceId, channelId);
        webSocket.send(JSON.stringify({ type: 'space_voice_roster', space_id: spaceId, channel_id: channelId, roster }));
        return;
    }

    if (message.type === 'space:voice_state') {
        const channelId = String(message.channelId || '').trim();
        if (!channelId) return;
        realtimeConnections.updateSpaceVoiceState(userId, spaceId, channelId, {
            muted: message.muted === undefined ? undefined : Boolean(message.muted),
            deafened: message.deafened === undefined ? undefined : Boolean(message.deafened),
        });
        return;
    }

    if (message.type === 'space:signal') {
        const channelId = String(message.channelId || '').trim();
        const toUserId = Number(message.toUserId);
        if (!channelId || !Number.isInteger(toUserId) || !message.data) return;
        realtimeConnections.relaySpaceSignal(userId, spaceId, channelId, toUserId, message.data);
        return;
    }
}

realtimeServer.on('connection', (webSocket, _request, principal) => {
    const userId = principal.id;
    if (!principal.guest) realtimeConnections.register(userId, webSocket, principal.sessionTokenHash);

    // DB-backed realtime handlers must be serialized and bounded per socket.
    const MAX_REALTIME_MESSAGES_PER_WINDOW = 1000;
    const REALTIME_MESSAGE_WINDOW_MS = 10_000;
    const MAX_PENDING_REALTIME_MESSAGES = 32;
    let messageWindowStartedAt = Date.now();
    let realtimeMessageCount = 0;
    let pendingRealtimeMessages = 0;
    let realtimeQueue = Promise.resolve();

    webSocket.on('message', (rawMessage, isBinary) => {
        const now = Date.now();
        if (now - messageWindowStartedAt >= REALTIME_MESSAGE_WINDOW_MS) {
            messageWindowStartedAt = now;
            realtimeMessageCount = 0;
        }
        realtimeMessageCount += 1;
        if (realtimeMessageCount > MAX_REALTIME_MESSAGES_PER_WINDOW) {
            webSocket.close(1008, 'Too many realtime messages');
            return;
        }
        if (isBinary) {
            webSocket.close(1003, 'Binary messages are not supported');
            return;
        }

        let message;
        try {
            message = JSON.parse(rawMessage.toString());
        } catch (_) {
            return;
        }

        // Keep heartbeats responsive, but include them in the per-socket rate limit.
        if (message?.type === 'ping') {
            if (webSocket.readyState === 1 && webSocket.bufferedAmount < 1024 * 1024) {
                webSocket.send(JSON.stringify({ type: 'pong' }));
            }
            return;
        }

        if (pendingRealtimeMessages >= MAX_PENDING_REALTIME_MESSAGES) {
            webSocket.close(1008, 'Too many pending realtime messages');
            return;
        }
        pendingRealtimeMessages += 1;
        realtimeQueue = realtimeQueue.then(async () => {
            try {
                if (webSocket.readyState !== 1) return;
                await calls.handle(webSocket, principal.guest ? userId : Number(userId), message, principal.guestStageId || null);
                if (!principal.guest && webSocket.readyState === 1) {
                    await handleRealtimeSpaceMessage(webSocket, userId, message);
                }
            } catch (_) {
                // 1通の処理例外で接続を切らず、後続メッセージの処理を続ける。
            } finally {
                pendingRealtimeMessages -= 1;
            }
        });
    });
    webSocket.on('close', () => { calls.disconnect(webSocket); if (!principal.guest) realtimeConnections.unregister(userId, webSocket); });
    webSocket.on('error', () => { calls.disconnect(webSocket); if (!principal.guest) realtimeConnections.unregister(userId, webSocket); });

    if (!principal.guest) Promise.all([
        realtimeConnections.publishNotificationUnreadCount(userId, app.locals.dbAdapter),
        realtimeConnections.publishDmUnreadCount(userId, app.locals.dbAdapter),
    ]).catch((error) => {
        console.warn('[realtime] Failed to publish initial unread counts:', error.message);
    });
});


// ── Health & Readiness ─────────────────────────────────────────────────────────
app.get(apiPath('/health'), healthLimiter, (req, res) => {
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

app.get(apiPath('/ready'), healthLimiter, async (req, res) => {
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
    ['spaces', require('./routes/spaces')],
    ['calls', require('./routes/calls')],
    ['notifications', require('./routes/notifications')],
    ['reports', require('./routes/reports')],
    ['appeals', require('./routes/appeals')],
    ['verification-applications', require('./routes/verificationApplications')],
    ['push', require('./routes/push')],
    ['rules', require('./routes/rules')],
    ['rule', require('./routes/rules')],
    ['auth/nyaitter-auth', require('./routes/nyaitterAuth')],
    ['nyaitter-auth', require('./routes/nyaitterAuth')],
    ['internal/extensions', require('./routes/extensions')],
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
const realPageDir = hasStaticPage ? fs.realpathSync(pageDir) : path.resolve(pageDir);
const indexPath = path.join(pageDir, 'index.html');

function isPathWithinDirectory(directoryPath, targetPath) {
    const relativePath = path.relative(directoryPath, targetPath);
    return relativePath !== ''
        && relativePath !== '..'
        && !relativePath.startsWith('..' + path.sep)
        && !path.isAbsolute(relativePath);
}
let indexHtmlTemplate = null;
if (hasStaticPage) {
    try {
        indexHtmlTemplate = fs.readFileSync(indexPath, 'utf8');
    } catch (_) {
        // index.html を読めない場合はテンプレート無しで起動する。
    }
}
const postPageHtmlTemplate = indexHtmlTemplate?.replace(
    /<head(?:\s[^>]*)?>/i,
    (match) => `${match}<base href="/">`,
);

// ── NyaitterUI (separate npm package) ──────────────────────────────────────────
// 本番は nyaitter.js と同様、CDN から読む。開発時は隣接する nyaitter-ui パッケージの
// dist を配信する (存在しなければ何もしない)。クライアントは /nyaitter-ui/ を先に試す。
const nyaitterUiDirCandidates = [
    path.join(__dirname, '../../nyaitter-ui/dist'),
    path.join(__dirname, '../node_modules/nyaitter-ui/dist'),
];
const nyaitterUiDir = nyaitterUiDirCandidates.find((dir) => {
    try {
        return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    } catch (_) {
        return false;
    }
});
if (nyaitterUiDir) {
    app.use(
        '/nyaitter-ui',
        express.static(nyaitterUiDir, {
            etag: true,
            lastModified: true,
            setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate'),
        }),
    );
    console.info('[server] nyaitter-ui served from', nyaitterUiDir);
}

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
                                frontendUrl: getFrontendUrl(req),
                            });
                            res.setHeader('Content-Type', 'text/html; charset=utf-8');
                            return res.send(html);
                        }
                        return res.redirect(302, `${getFrontendUrl(req)}/#post/${post.id}`);
                    }
                } catch (err) {
                    console.warn('[ogp] Failed to render post embed:', err.message);
                }
                if (postPageHtmlTemplate) {
                    res.setHeader('Content-Type', 'text/html; charset=utf-8');
                    return res.send(postPageHtmlTemplate);
                }
                return res.status(404).send('Post not found');
            })();
        }

        // ── Dynamic OGP Rendering for Group & Stage URLs ──
        const embedMatch = cleanPath.match(/^\/(groups?|stages?|spaces?)\/([^/]+)\/?$/i);
        if (embedMatch) {
            const kind = /^group/i.test(embedMatch[1]) ? 'group' : 'stage';
            const embedId = embedMatch[2];
            return (async () => {
                try {
                    const db = app.locals.dbAdapter;
                    const publicUrl = getPublicUrl(req);
                    const shareBase = getPostShareUrl(req).replace(/\/+$/, '');
                    const frontendUrl = getFrontendUrl(req).replace(/\/+$/, '');
                    const userAgent = req.headers['user-agent'] || '';

                    if (kind === 'group') {
                        const group = await getPublicGroup(db, embedId);
                        if (isCrawler(userAgent)) {
                            if (!group) return res.status(404).type('text/plain').send('Not Found');
                            const html = generateGroupHtml({
                                group,
                                publicUrl,
                                frontendUrl,
                                shareUrl: `${shareBase}/groups/${encodeURIComponent(group.id)}`,
                            });
                            res.setHeader('Content-Type', 'text/html; charset=utf-8');
                            return res.send(html);
                        }
                        // クローラー以外は限定公開・非公開でもログイン済みなら
                        // クライアント側で閲覧できるよう SPA へ返す。
                        const visibleGroup = group || await db.getGroupById(String(embedId).toLowerCase()).catch(() => null);
                        if (!visibleGroup) return res.status(404).type('text/plain').send('Not Found');
                        return res.redirect(302, `${frontendUrl}/#group/${encodeURIComponent(embedId.toLowerCase())}`);
                    }

                    const result = await getPublicStage(db, embedId);
                    if (isCrawler(userAgent)) {
                        if (!result) return res.status(404).type('text/plain').send('Not Found');
                        const html = generateStageHtml({
                            stage: result.stage,
                            host: result.host,
                            publicUrl,
                            frontendUrl,
                            shareUrl: `${shareBase}/stages/${encodeURIComponent(result.stage.id)}`,
                        });
                        res.setHeader('Content-Type', 'text/html; charset=utf-8');
                        return res.send(html);
                    }
                    const visibleStage = result?.stage || await db.getSpaceById(String(embedId).toLowerCase()).catch(() => null);
                    if (!visibleStage) return res.status(404).type('text/plain').send('Not Found');
                    return res.redirect(302, `${frontendUrl}/#stage/${encodeURIComponent(embedId.toLowerCase())}`);
                } catch (err) {
                    console.warn('[ogp] Failed to render group/stage embed:', err.message);
                    return res.status(404).type('text/plain').send('Not Found');
                }
            })();
        }

        if (cleanPath.endsWith('.html')) {
            const targetPath = cleanPath.slice(0, -5);
            const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
            return res.redirect(301, (targetPath || '/') + query);
        }

        if (!path.extname(cleanPath) && cleanPath !== '/') {
            // Prefix with '.' so leading slashes stay relative; verify the normalized
            // path and its realpath to reject traversal and symlink escapes.
            const htmlFilePath = path.resolve(realPageDir, '.' + cleanPath + '.html');
            if (isPathWithinDirectory(realPageDir, htmlFilePath) && fs.existsSync(htmlFilePath)) {
                try {
                    const realHtmlFilePath = fs.realpathSync(htmlFilePath);
                    if (isPathWithinDirectory(realPageDir, realHtmlFilePath) && fs.statSync(realHtmlFilePath).isFile()) {
                        return res.sendFile(realHtmlFilePath);
                    }
                } catch (_) {
                    // Missing files and invalid paths fall through to the static handler.
                }
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

// ── Error & 404 Handlers ───────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[server] Unhandled error:', err);

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
let scheduledPostPublisher = null;
let accountRecoveryScheduler = null;
let postEventOutbox = null;

const pushNotificationService = new PushNotificationService({
    dbAdapter,
    pushConfig: config.push,
    realtime: realtimeConnections,
});

const accountRecoveryService = new AccountRecoveryService({
    db: dbAdapter,
    config: config.auth,
});

configureNotificationDelivery({
    realtime: realtimeConnections,
    pushService: pushNotificationService,
});

const moderationReportService = new ModerationReportService({
    dbAdapter,
    storageAdapter,
});
const autoModerationService = new AutoModerationService({
    dbAdapter,
    storageAdapter,
    moderationConfig: config.autoMod,
});
const postActionQueue = new PostActionQueue();
const postKeywordBackfillQueue = new PostActionQueue({ maxPendingJobs: 2000 });
const postKeywordBackfillService = new PostKeywordBackfillService({ postActionQueue: postKeywordBackfillQueue });
dbAdapter.postKeywordBackfillService = postKeywordBackfillService;
postEventOutbox = new PostEventOutbox({
    db: dbAdapter,
    handlers: {
        'post.created': (event) => dbAdapter.processPostCreatedEvent?.(event),
    },
});

app.locals.pushNotificationService = pushNotificationService;
app.locals.moderationReportService = moderationReportService;
app.locals.autoModerationService = autoModerationService;
app.locals.postActionQueue = postActionQueue;
app.locals.postKeywordBackfillQueue = postKeywordBackfillQueue;
app.locals.postKeywordBackfillService = postKeywordBackfillService;

async function startServer() {
    await dbAdapter.connect();
    if (dbAdapter.constructor.prototype.claimPostEvents !== DatabaseAdapter.prototype.claimPostEvents) {
        postEventOutbox.start();
    }
    app.locals.dbAdapter = dbAdapter;
    app.locals.storageAdapter = storageAdapter;
    const userFileEndpoint = config.userFiles?.endpoint || null;
    const postShareUrl = getPostShareUrl();
    const turnstileSiteKey = config.turnstile?.siteKey || '';

    moderationScheduler = startModerationAssignmentScheduler(moderationReportService);
    pollExpirationScheduler = startPollExpirationScheduler(dbAdapter);
    scheduledPostPublisher = startScheduledPostPublisher(dbAdapter, realtimeConnections);
    accountRecoveryScheduler = startAccountRecoveryScheduler(dbAdapter, accountRecoveryService);
    operatorControl = await startOperatorControlServer({
        dbAdapter,
        shutdown,
        getStatus: () => ({
            pid: process.pid,
            port: PORT,
            databaseAdapter: config.database.adapter,
            storageAdapter: config.storage?.adapter || 'local',
            startedAt: new Date().toISOString(),
            client_config: {
                user_file_endpoint: userFileEndpoint,
                post_share_url: postShareUrl,
                turnstile_site_key: turnstileSiteKey,
                resource_links: config.client?.resourceLinks || [],
                widget_links: config.client?.widgetLinks || [],
                ui: config.client?.ui || {},
            },
        }),
    });
    console.log(`[operator-control] Listening on ${operatorControl.socketPath}`);

    httpServer.listen(PORT, LISTEN_HOST, async () => {
        console.log(`
╔══════════════════════════════════════════════════════════════
║  Nyaitter Server                                           
╠══════════════════════════════════════════════════════════════
║  Server running at:   http://${DISPLAY_HOST}:${PORT}
║
║  Health check:        http://${DISPLAY_HOST}:${PORT}${apiPath('/health')}
║  Frontend (SPA):      http://${DISPLAY_HOST}:${PORT}/
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
            userFilesServer.listen(userFilesPort, USER_FILES_HOST, () => {
                console.log(`[user-files] Serving ${userFilesEndpoint} on http://${USER_FILES_HOST || 'localhost'}:${userFilesPort}${userFilesEndpoint}`);
            });
        }

        const sharePort = config.postSharePort ? Number(config.postSharePort) : null;
        if (sharePort && sharePort !== PORT && Number.isInteger(sharePort) && sharePort > 0) {
            postShareServer = http.createServer(app);
            postShareServer.once('error', (error) => {
                console.error(`[share-server] Failed to listen on port ${sharePort}:`, error.message);
            });
            postShareServer.listen(sharePort, POST_SHARE_HOST, () => {
                console.log(`[share-server] Listening for post share traffic on http://${POST_SHARE_HOST || 'localhost'}:${sharePort}`);
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
        try {
            const dataDir = path.resolve(__dirname, '../data');
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(path.join(dataDir, 'server.pid'), String(process.pid), 'utf8');
        } catch (_) {
            // PID ファイルを書き込めない環境でも起動は継続する。
        }
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
        moderationScheduler?.stop();
        moderationScheduler = null;
        pollExpirationScheduler?.stop();
        pollExpirationScheduler = null;
        scheduledPostPublisher?.stop();
        scheduledPostPublisher = null;
        accountRecoveryScheduler?.stop();
        accountRecoveryScheduler = null;
        autoModerationService.stop();
        postKeywordBackfillService.stop();
        postKeywordBackfillQueue.stop();
        postActionQueue.stop();
        postEventOutbox?.stop();
        realtimeConnections.closeAll();
        console.log('[server] Graceful shutdown complete. Exiting.');
        try {
            const pidFile = path.resolve(__dirname, '../data/server.pid');
            if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
        } catch (_) {
            // PID ファイル削除の失敗は終了処理を妨げない。
        }
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
    shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
    console.error('[server] Unhandled Rejection:', reason);
});
