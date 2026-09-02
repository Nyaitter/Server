'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const crypto = require('crypto');

const ErrorManager = require('./ErrorManager');
const LogHubManager = require('./LogHubManager');
const ServerControlManager = require('./ServerControlManager');

const DATA_DIR = path.resolve(__dirname, '../../data');
const SESSION_FILE = path.join(DATA_DIR, 'nmt-sessions.json');

class ManagementToolServer {
  constructor({ config = {}, dbAdapter = null } = {}) {
    this.config = config.nmt || {};
    this.mainConfig = config;
    this.dbAdapter = dbAdapter;
    this.port = Number(process.env.NMT_PORT) || this.config.port || 4040;
    this.host = this.config.host || '0.0.0.0';

    this.sessions = new Map();
    this._loadSessions();

    this.logHub = new LogHubManager({ sessions: this.sessions });
    this.errorManager = new ErrorManager();
    this.errorManager.setLogHub(this.logHub);
    this.serverControl = new ServerControlManager({ dbAdapter });

    this.app = null;
    this.httpServer = null;
  }

  setDbAdapter(dbAdapter) {
    this.dbAdapter = dbAdapter;
    this.serverControl.setDbAdapter(dbAdapter);
  }

  _loadSessions() {
    try {
      if (fs.existsSync(SESSION_FILE)) {
        const raw = fs.readFileSync(SESSION_FILE, 'utf8');
        const data = JSON.parse(raw);
        const now = Date.now();
        for (const [token, session] of Object.entries(data)) {
          if (session && (!session.expiresAt || session.expiresAt > now)) {
            this.sessions.set(token, session);
          }
        }
      }
    } catch (_) {}
  }

  _saveSessions() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const obj = {};
      const now = Date.now();
      for (const [token, session] of this.sessions.entries()) {
        if (session && (!session.expiresAt || session.expiresAt > now)) {
          obj[token] = session;
        }
      }
      fs.writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (_) {}
  }

  start() {
    if (this.httpServer) return this.httpServer;

    this.app = express();
    this.app.disable('x-powered-by');
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.urlencoded({ extended: false }));

    const webDir = path.join(__dirname, 'web');
    this.app.use(express.static(webDir));

    // 認証ミドルウェア
    const requireAuth = async (req, res, next) => {
      const nmtPassword = process.env.NMT_PASSWORD || this.config.password;
      if (!nmtPassword) {
        req.adminUser = { id: 1, name: 'Admin', admin: true };
        return next();
      }

      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim() || req.query.token;
      if (!token) return res.status(401).json({ error: '認証が必要です。' });

      const session = this.sessions.get(token);
      if (session && (!session.expiresAt || session.expiresAt > Date.now())) {
        req.adminUser = session.user || { admin: true };
        return next();
      }

      // DBセッション検証
      if (this.dbAdapter && typeof this.dbAdapter.getSession === 'function') {
        try {
          const dbSession = await this.dbAdapter.getSession(token);
          if (dbSession?.userId && typeof this.dbAdapter.getUserById === 'function') {
            const user = await this.dbAdapter.getUserById(dbSession.userId);
            if (user && user.admin) {
              const sessionData = { user: { id: user.id, name: user.name, admin: true }, expiresAt: Date.now() + 86400000 * 7 };
              this.sessions.set(token, sessionData);
              this._saveSessions();
              req.adminUser = sessionData.user;
              return next();
            }
          }
        } catch (_) {}
      }

      return res.status(401).json({ error: '無効な認証セッションです。' });
    };

    // ── Auth APIs ──
    this.app.get('/api/auth/me', (req, res) => {
      const nmtPassword = process.env.NMT_PASSWORD || this.config.password;
      if (!nmtPassword) {
        return res.json({ authenticated: true, user: { id: 1, name: 'Admin' }, requiresPassword: false });
      }

      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      const session = token ? this.sessions.get(token) : null;

      if (session && (!session.expiresAt || session.expiresAt > Date.now())) {
        return res.json({ authenticated: true, user: session.user, requiresPassword: true });
      }
      return res.json({ authenticated: false, requiresPassword: true });
    });

    this.app.post('/api/auth/login', (req, res) => {
      const { password, token: incomingToken } = req.body || {};
      const expectedPassword = process.env.NMT_PASSWORD || this.config.password;

      if (expectedPassword) {
        if (!password || password !== expectedPassword) {
          return res.status(401).json({ success: false, error: 'パスワードが正しくありません。' });
        }
      }

      const token = incomingToken || `nmt_${crypto.randomBytes(24).toString('hex')}`;
      const sessionData = {
        user: { name: 'Admin', admin: true },
        expiresAt: Date.now() + 86400000 * 7,
      };
      this.sessions.set(token, sessionData);
      this._saveSessions();
      res.json({ success: true, token, user: sessionData.user });
    });

    this.app.post('/api/auth/logout', (req, res) => {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (token) {
        this.sessions.delete(token);
        this._saveSessions();
      }
      res.json({ success: true });
    });

    // ── Status & Control APIs ──
    this.app.get('/api/status', requireAuth, async (req, res) => {
      try {
        const status = await this.serverControl.getStatus();
        res.json(status);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/server/start', requireAuth, async (req, res) => {
      const result = await this.serverControl.startServer();
      res.json(result);
    });

    this.app.post('/api/server/stop', requireAuth, async (req, res) => {
      const result = await this.serverControl.stopServer();
      res.json(result);
    });

    this.app.post('/api/server/restart', requireAuth, async (req, res) => {
      const result = await this.serverControl.restartServer();
      res.json(result);
    });

    this.app.post('/api/nmt/restart', requireAuth, async (req, res) => {
      const result = await this.serverControl.restartNMT();
      res.json(result);
    });

    // ── Logs APIs ──
    this.app.get('/api/logs', requireAuth, (req, res) => {
      const logs = this.logHub.getLogs(req.query);
      res.json({ logs });
    });

    this.app.delete('/api/logs', requireAuth, (req, res) => {
      this.logHub.clearLogs();
      res.json({ success: true });
    });

    // ── Errors APIs ──
    this.app.get('/api/errors', requireAuth, (req, res) => {
      const result = this.errorManager.getErrors(req.query);
      res.json(result);
    });

    this.app.get('/api/errors/:id', requireAuth, (req, res) => {
      const error = this.errorManager.getErrorById(req.params.id);
      if (!error) return res.status(404).json({ error: 'エラーが見つかりません' });
      res.json({ error });
    });

    this.app.patch('/api/errors/:id', requireAuth, (req, res) => {
      const updated = this.errorManager.updateErrorStatus(req.params.id, req.body.status);
      if (!updated) return res.status(404).json({ error: 'エラーが見つかりません' });
      res.json({ success: true, error: updated });
    });

    this.app.delete('/api/errors', requireAuth, (req, res) => {
      this.errorManager.clearErrors();
      res.json({ success: true });
    });

    // ── Settings APIs ──
    this.app.get('/api/settings/env', requireAuth, (req, res) => {
      res.json(this.serverControl.getEnv());
    });

    this.app.post('/api/settings/env', requireAuth, (req, res) => {
      try {
        const result = this.serverControl.updateEnv(req.body.content);
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    this.app.get('/api/settings/config', requireAuth, (req, res) => {
      res.json(this.serverControl.getConfig());
    });

    this.app.post('/api/settings/config', requireAuth, (req, res) => {
      try {
        const result = this.serverControl.updateConfig(req.body.config);
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    // SPA フォールバック
    this.app.get('*', (req, res) => {
      res.sendFile(path.join(webDir, 'index.html'));
    });

    this.httpServer = http.createServer(this.app);
    this.logHub.attachWebSocket(this.httpServer);

    this.httpServer.listen(this.port, this.host, () => {
      console.log(`\n🐾 [NMT] Nyaitter Management Tool running at http://${this.host === '0.0.0.0' ? 'localhost' : this.host}:${this.port}`);
    });

    return this.httpServer;
  }

  stop() {
    if (this.httpServer) {
      this.logHub.close();
      this.httpServer.close();
      this.httpServer = null;
    }
  }
}

module.exports = ManagementToolServer;
