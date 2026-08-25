'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const crypto = require('crypto');

const AiAnalysisService = require('./AiAnalysisService');
const ErrorManager = require('./ErrorManager');
const SecurityLogManager = require('./SecurityLogManager');
const AdminManager = require('./AdminManager');
const ServerControlManager = require('./ServerControlManager');
const ManagementNotificationManager = require('./ManagementNotificationManager');
const AccessApprovalManager = require('./AccessApprovalManager');
const LogHubManager = require('./LogHubManager');
const NyaitterAuthManager = require('../auth/NyaitterAuthManager');
const { getPublicUrl } = require('../../utils/nyaitterAddress');

class ManagementToolServer {
  constructor({ config, dbAdapter, shutdownFn, getStatusFn, mainPushService = null, realtimeService = null } = {}) {
    this.config = config.nmt || {};
    this.mainConfig = config;
    this.dbAdapter = dbAdapter;
    this.port = this.config.port || 4040;
    this.host = this.config.host || '0.0.0.0';

    this.sessions = new Map(); // token -> { userId, admin, expiresAt }

    // サービス群初期化
    this.logHub = new LogHubManager({ sessions: this.sessions });
    this.notificationManager = new ManagementNotificationManager({ mainPushService, realtimeService });
    this.approvalManager = new AccessApprovalManager({ notificationManager: this.notificationManager });
    this.aiService = new AiAnalysisService(this.config);
    this.aiService.setApprovalManager(this.approvalManager);
    this.errorManager = new ErrorManager({
      aiService: this.aiService,
      config: this.config,
      notificationManager: this.notificationManager,
      approvalManager: this.approvalManager,
    });
    this.errorManager.setLogHub(this.logHub);
    this.securityManager = new SecurityLogManager({
      aiService: this.aiService,
      config: this.config,
      notificationManager: this.notificationManager,
    });
    this.adminManager = new AdminManager({ dbAdapter });
    this.serverControl = new ServerControlManager({ shutdownFn, getStatusFn });
    this.authManager = new NyaitterAuthManager({ dbAdapter });

    this.app = null;
    this.httpServer = null;
  }

  setDbAdapter(dbAdapter) {
    this.dbAdapter = dbAdapter;
    this.adminManager.setDbAdapter(dbAdapter);
    this.authManager = new NyaitterAuthManager({ dbAdapter });
  }

  setServerControls({ shutdownFn, getStatusFn } = {}) {
    if (shutdownFn) this.serverControl.setShutdownHandler(shutdownFn);
    if (getStatusFn) this.serverControl.setStatusProvider(getStatusFn);
  }

  // ── メインサーバーからのフック ─────────────────────────────────────────
  recordError(err, context = {}) {
    const msg = typeof err === 'string' ? err : err.message || 'Unknown Error';
    this.logHub.addLog({
      type: 'error',
      level: 'error',
      message: `[Error] ${msg}${context.url ? ` at ${context.method || 'GET'} ${context.url}` : ''}`,
      source: 'error-handler',
      details: { stack: err.stack, context },
    });
    return this.errorManager.recordError(err, context);
  }

  recordRequest(req, res, durationMs) {
    return this.securityManager.recordRequest(req, res, durationMs);
  }

  // ── NMT サーバー起動 ───────────────────────────────────────────────────
  start() {
    if (this.httpServer) return;

    this.app = express();
    this.app.disable('x-powered-by');
    this.app.set('trust proxy', true);
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.urlencoded({ extended: false }));

    // 静的 SPA ファイル配信
    const webDir = path.join(__dirname, 'web');
    this.app.use(express.static(webDir));

    // 認証ミドルウェア
    const authMiddleware = async (req, res, next) => {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (!token) return res.status(401).json({ error: '認証が必要です。' });

      // NMT 内部セッション確認 (TTL有効期限チェック)
      const session = this.sessions.get(token);
      let userId = null;

      if (session) {
        if (session.expiresAt && Date.now() > session.expiresAt) {
          this.sessions.delete(token);
          return res.status(401).json({ error: 'セッションの有効期限が切れています。再度ログインしてください。' });
        }
        userId = session.userId;
      }

      // Nyaitter メインセッション直接検証
      if (!userId && typeof this.dbAdapter.getSession === 'function') {
        try {
          const dbSession = await this.dbAdapter.getSession(token);
          if (dbSession?.userId) userId = dbSession.userId;
        } catch (_) {}
      }

      let user = session?.user || null;
      if (!user && this.dbAdapter && typeof this.dbAdapter.getUserById === 'function') {
        try {
          user = await this.dbAdapter.getUserById(userId);
        } catch (_) {}
      }

      if (!user || user.admin !== true) {
        if (session) this.sessions.delete(token);
        return res.status(403).json({ error: '管理者（Admin）権限が必要です。' });
      }

      req.adminUser = user;
      next();
    };

    // ── NyaitterAuth 連携・リダイレクト ──────────────────────────────────

    // 1. NyaitterAuth 認可画面へのリダイレクト
    this.app.get('/auth/login', async (req, res) => {
      try {
        const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : (req.protocol === 'https' ? 'https' : 'http');
        const rawHost = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${this.port}`;
        // ホストヘッダーのサニタイズ（安全な文字種のみ許可）
        const currentHost = /^[a-zA-Z0-9.\-:]+$/.test(rawHost) ? rawHost : `localhost:${this.port}`;
        
        // NMT コールバックURL
        const nmtPublicUrl = this.config.publicUrl ? this.config.publicUrl.replace(/\/+$/, '') : `${protocol}://${currentHost}`;
        const redirectUri = `${nmtPublicUrl}/auth/callback`;

        // Nyaitter 本体の公開URL
        let nyaitterBaseUrl = getPublicUrl(null);
        if (!this.mainConfig?.client?.publicUrl && !process.env.NYAITTER_CLIENT_PUBLIC_URL && !process.env.PUBLIC_URL) {
          const mainPort = this.mainConfig?.server?.port || 3000;
          let nyaitterHost = currentHost;
          if (currentHost.includes(`-${this.port}.`)) {
            nyaitterHost = currentHost.replace(`-${this.port}.`, `-${mainPort}.`);
          } else if (currentHost.includes(`:${this.port}`)) {
            nyaitterHost = currentHost.replace(`:${this.port}`, `:${mainPort}`);
          } else if (currentHost.includes('github.dev') && process.env.CODESPACE_NAME) {
            const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';
            nyaitterHost = `${process.env.CODESPACE_NAME}-${mainPort}.${domain}`;
          } else if (currentHost.startsWith('manage.')) {
            // manage.admin.nyaitter.jp -> admin.nyaitter.jp
            nyaitterHost = currentHost.replace(/^manage\./, '');
          }
          nyaitterBaseUrl = `${protocol}://${nyaitterHost}`.replace(/\/+$/, '');
        }

        const authReq = await this.authManager.createAuthorizationRequest({
          app_id: 'nmt-internal',
          api_token: 'nmt-token-secret',
          name: 'Nyaitter Management Tool',
          redirect_uri: redirectUri,
          scopes: ['profile:read'],
        });

        // 認可URLをNyaitter本体のホストに向けて生成
        const authUrl = `${nyaitterBaseUrl}/#nyaitter-auth?request_id=${encodeURIComponent(authReq.request_id)}`;

        return res.redirect(authUrl);
      } catch (err) {
        console.error('[NMT] Failed to initiate NyaitterAuth:', err);
        return res.status(500).send(`NyaitterAuth の開始に失敗しました: ${err.message}`);
      }
    });

    // 2. NyaitterAuth コールバック
    this.app.get('/auth/callback', async (req, res) => {
      const { code, error, error_description } = req.query;

      if (error) {
        return res.redirect(`/#error=${encodeURIComponent(error_description || error)}`);
      }

      if (!code) {
        return res.redirect('/#error=no_code');
      }

      try {
        // One-time code から認可データを取得
        NyaitterAuthManager._loadPendingStore();
        const approved = NyaitterAuthManager.pendingCodes.get(String(code));
        let userId = approved?.userId;

        if (!userId) {
          return res.redirect('/#error=invalid_or_expired_code');
        }

        NyaitterAuthManager.pendingCodes.delete(String(code));
        NyaitterAuthManager._savePendingStore();

        // ユーザー情報の解決（approved スナップショットまたは dbAdapter）
        let user = approved.user || null;
        if (!user && this.dbAdapter && typeof this.dbAdapter.getUserById === 'function') {
          user = await this.dbAdapter.getUserById(userId);
        }

        if (!user) {
          return res.redirect('/#error=user_not_found');
        }

        // 管理者権限のチェック
        if (user.admin !== true) {
          return res.redirect('/#error=not_an_admin');
        }

        // NMT セッショントークン発行
        const token = `nmt_${crypto.randomBytes(32).toString('hex')}`;
        this.sessions.set(token, {
          userId: user.id,
          user: {
            id: user.id,
            username: user.username,
            name: user.name,
            admin: user.admin,
            icon_url: user.icon_url,
          },
          admin: true,
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });

        return res.redirect(`/#token=${encodeURIComponent(token)}`);
      } catch (err) {
        console.error('[NMT] Auth callback error:', err);
        return res.redirect(`/#error=${encodeURIComponent(err.message)}`);
      }
    });

    // 認証確認: GET /api/me
    this.app.get('/api/me', authMiddleware, (req, res) => {
      res.json({
        user: {
          id: req.adminUser.id,
          name: req.adminUser.name,
          scid: req.adminUser.scid,
          admin: req.adminUser.admin,
        },
      });
    });

    // ── 1. エラー管理 API ────────────────────────────────────────────────
    this.app.get('/api/errors', authMiddleware, (req, res) => {
      const { status, search, limit, offset } = req.query;
      const result = this.errorManager.getErrors({
        status,
        search,
        limit: Number(limit) || 50,
        offset: Number(offset) || 0,
      });
      res.json(result);
    });

    this.app.get('/api/errors/:id', authMiddleware, (req, res) => {
      const err = this.errorManager.getErrorById(req.params.id);
      if (!err) return res.status(404).json({ error: 'エラーが見つかりません。' });
      res.json(err);
    });

    this.app.post('/api/errors/:id/analyze', authMiddleware, async (req, res) => {
      try {
        const analysis = await this.errorManager.triggerAnalysis(req.params.id);
        res.json({ success: true, analysis });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/errors/:id/fix', authMiddleware, async (req, res) => {
      try {
        const result = await this.errorManager.triggerAutoFix(req.params.id);
        res.json({ success: true, ...result });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/errors/:id/pr', authMiddleware, async (req, res) => {
      try {
        const prUrl = await this.errorManager.createGitHubPullRequest(req.params.id);
        res.json({ success: true, prUrl });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/errors/:id/issue', authMiddleware, async (req, res) => {
      try {
        const issueUrl = await this.errorManager.createGitHubIssue(req.params.id);
        res.json({ success: true, issueUrl });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.patch('/api/errors/:id/status', authMiddleware, (req, res) => {
      const updated = this.errorManager.updateStatus(req.params.id, req.body.status);
      if (!updated) return res.status(404).json({ error: 'エラーが見つかりません。' });
      res.json({ success: true, error: updated });
    });

    // ── 2. Admin 管理 API ────────────────────────────────────────────────
    this.app.get('/api/admins', authMiddleware, async (req, res) => {
      const admins = await this.adminManager.getAdmins();
      res.json({ admins });
    });

    this.app.get('/api/users/search', authMiddleware, async (req, res) => {
      const users = await this.adminManager.searchUsers(req.query.q);
      res.json({ users });
    });

    this.app.post('/api/admins/:userId', authMiddleware, async (req, res) => {
      try {
        const makeAdmin = req.body.admin === true;
        const result = await this.adminManager.setAdminStatus(req.params.userId, makeAdmin, req.adminUser);
        res.json(result);
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.get('/api/admins/audit-logs', authMiddleware, (req, res) => {
      res.json({ logs: this.adminManager.getAuditLogs() });
    });

    // ── 3. セキュリティ & 不審アクセス監視 API ──────────────────────────
    this.app.get('/api/security/events', authMiddleware, (req, res) => {
      const result = this.securityManager.getSecurityEvents(req.query);
      res.json(result);
    });

    this.app.post('/api/security/events/:id/analyze', authMiddleware, async (req, res) => {
      try {
        const analysis = await this.securityManager.triggerAnalysis(req.params.id);
        res.json({ success: true, analysis });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/security/access-logs', authMiddleware, (req, res) => {
      const logs = this.securityManager.getRecentAccessLogs(req.query);
      res.json(logs);
    });

    // ── 4. 設定 API ──────────────────────────────────────────────────────
    this.app.get('/api/settings/models', authMiddleware, async (req, res) => {
      try {
        const models = await this.aiService.getAvailableModels();
        res.json({ models });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/settings', authMiddleware, (req, res) => {
      res.json({
        autoAnalysis: this.errorManager.autoAnalysis,
        autoFix: this.errorManager.autoFix,
        autoIssue: this.errorManager.autoIssue,
        autoPr: this.errorManager.autoPr,
        allowBash: this.aiService.allowBash,
        requireApprovalForEdit: this.aiService.requireApprovalForEdit,
        requireApprovalForBash: this.aiService.requireApprovalForBash,
        guardrails: this.mainConfig?.nmt?.guardrails || {
          restrictToGitTracked: true,
          syntaxValidation: true,
          blockEnvModification: true,
          blockSuspiciousCommands: true,
        },
        aiModel: this.aiService.preferredModel || 'auto',
        githubToken: this.errorManager.githubToken ? '********' : '',
        githubRepo: this.errorManager.githubRepo,
        geminiApiKey: this.aiService.geminiApiKey ? '********' : '',
        openaiApiKey: this.aiService.openaiApiKey ? '********' : '',
      });
    });

    this.app.post('/api/settings', authMiddleware, (req, res) => {
      const {
        autoAnalysis,
        autoFix,
        autoIssue,
        autoPr,
        allowBash,
        requireApprovalForEdit,
        requireApprovalForBash,
        guardrails,
        aiModel,
        githubToken,
        githubRepo,
        geminiApiKey,
        openaiApiKey,
      } = req.body;
      
      const newSettings = {};
      if (autoAnalysis !== undefined) newSettings.autoAnalysis = autoAnalysis;
      if (autoFix !== undefined) newSettings.autoFix = autoFix;
      if (autoIssue !== undefined) newSettings.autoIssue = autoIssue;
      if (autoPr !== undefined) newSettings.autoPr = autoPr;
      if (allowBash !== undefined) newSettings.allowBash = allowBash;
      if (requireApprovalForEdit !== undefined) newSettings.requireApprovalForEdit = requireApprovalForEdit;
      if (requireApprovalForBash !== undefined) newSettings.requireApprovalForBash = requireApprovalForBash;
      if (guardrails !== undefined) {
        if (!this.mainConfig.nmt) this.mainConfig.nmt = {};
        this.mainConfig.nmt.guardrails = { ...(this.mainConfig.nmt.guardrails || {}), ...guardrails };
        newSettings.guardrails = this.mainConfig.nmt.guardrails;
      }
      if (aiModel !== undefined) newSettings.aiModel = aiModel;
      if (githubToken && githubToken !== '********') newSettings.githubToken = githubToken;
      if (githubRepo !== undefined) newSettings.githubRepo = githubRepo;
      if (geminiApiKey && geminiApiKey !== '********') newSettings.geminiApiKey = geminiApiKey;
      if (openaiApiKey && openaiApiKey !== '********') newSettings.openaiApiKey = openaiApiKey;

      this.aiService.updateConfig(newSettings);
      this.errorManager.updateConfig(newSettings);
      this.securityManager.updateConfig(newSettings);

      res.json({ success: true, message: '設定を更新しました。' });
    });

    // ── 4.2. 統合ログ API ────────────────────────────────────────────────
    const handleGetLogs = (req, res) => {
      const { types, search, level, limit } = req.query;
      const typeList = types ? types.split(',').map((s) => s.trim()).filter(Boolean) : ['system', 'error', 'security', 'ai'];
      const logs = this.logHub.getLogs({
        types: typeList,
        search,
        level,
        limit: Number(limit) || 300,
      });
      res.json({ logs });
    };

    this.app.get('/api/logs', authMiddleware, handleGetLogs);
    this.app.get('/api/logs/all', authMiddleware, handleGetLogs);

    this.app.post('/api/logs/clear', authMiddleware, (req, res) => {
      this.logHub.clearLogs();
      res.json({ success: true, message: 'ログをクリアしました。' });
    });

    // ── 4.5. 通知 & アクセス承認 API ──────────────────────────────────────
    this.app.get('/api/notifications', authMiddleware, (req, res) => {
      res.json({
        notifications: this.notificationManager.getNotifications(50),
        isSubscribed: this.notificationManager.isUserSubscribed(req.adminUser.id),
      });
    });

    this.app.get('/api/notifications/stream', (req, res) => {
      const token = req.query.token;
      const session = this.sessions.get(token);
      if (!session || !session.admin) {
        return res.status(401).send('Unauthorized');
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(': connected\n\n');

      this.notificationManager.addClient(res, session.userId);
    });

    this.app.post('/api/notifications/subscribe', authMiddleware, (req, res) => {
      const { enabled } = req.body;
      if (enabled) {
        this.notificationManager.subscribeUser(req.adminUser.id);
      } else {
        this.notificationManager.unsubscribeUser(req.adminUser.id);
      }
      res.json({ success: true, isSubscribed: this.notificationManager.isUserSubscribed(req.adminUser.id) });
    });

    this.app.post('/api/notifications/read-all', authMiddleware, (req, res) => {
      this.notificationManager.markAllAsRead();
      res.json({ success: true });
    });

    this.app.get('/api/approvals/pending', authMiddleware, (req, res) => {
      res.json({ requests: this.approvalManager.getPendingRequests() });
    });

    this.app.post('/api/approvals/:id/approve', authMiddleware, (req, res) => {
      try {
        const { scope = 'session' } = req.body;
        const result = this.approvalManager.approveRequest(req.params.id, req.adminUser, { scope });
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    this.app.post('/api/approvals/:id/deny', authMiddleware, (req, res) => {
      try {
        const result = this.approvalManager.denyRequest(req.params.id, req.adminUser);
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    // ── 5. サーバー制御・管理 API ─────────────────────────────────────────
    this.app.get('/api/server/status', authMiddleware, (req, res) => {
      res.json(this.serverControl.getStatus());
    });

    this.app.get('/api/server/logs', authMiddleware, (req, res) => {
      const { limit, level, search } = req.query;
      const logs = this.serverControl.getLogs({ limit, level, search });
      res.json({ logs });
    });

    this.app.post('/api/server/restart', authMiddleware, async (req, res) => {
      try {
        const result = await this.serverControl.restartServer();
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/server/restart-nmt', authMiddleware, async (req, res) => {
      try {
        const result = await this.serverControl.restartNMT(this);
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/server/stop', authMiddleware, async (req, res) => {
      try {
        const result = await this.serverControl.stopServer();
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/server/env', authMiddleware, (req, res) => {
      res.json(this.serverControl.getEnv());
    });

    this.app.put('/api/server/env', authMiddleware, (req, res) => {
      try {
        const result = this.serverControl.updateEnv(req.body.content || '');
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    this.app.get('/api/server/config-file', authMiddleware, (req, res) => {
      res.json(this.serverControl.getConfigFile());
    });

    this.app.put('/api/server/config-file', authMiddleware, (req, res) => {
      try {
        const result = this.serverControl.updateConfigFile(req.body.content || '');
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    // SPA フォールバック
    this.app.get('*', (req, res) => {
      res.sendFile(path.join(webDir, 'index.html'));
    });

    // サーバーリッスン開始 (IPv4 & IPv6 デュアルスタック対応)
    this.httpServer = http.createServer(this.app);
    this.httpServer.keepAliveTimeout = 65000;
    this.httpServer.headersTimeout = 66000;

    this.httpServer.on('clientError', (err, socket) => {
      if (err.code === 'ECONNRESET' || !socket.writable) return;
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });

    this.httpServer.listen(this.port, () => {
      this.logHub.attachHttpServer(this.httpServer);
      console.log(`\n🐾 [NyaitterManagementTool] Started on port ${this.port} (IPv4/IPv6 dual-stack)`);
      console.log(`   - Error Logging & AI Assistance: Active`);
      console.log(`   - Admin Management: Active`);
      console.log(`   - Security & Anomaly Detection: Active\n`);
    });
  }

  stop() {
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }
}

module.exports = ManagementToolServer;
