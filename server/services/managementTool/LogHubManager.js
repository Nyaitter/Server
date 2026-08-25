'use strict';

const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const DATA_DIR = path.resolve(__dirname, '../../data');
const UNIFIED_LOG_FILE = path.join(DATA_DIR, 'nmt-unified.log');
const MAX_LOG_LINES = 3000;
const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024; // 10MB

class LogHubManager {
  constructor({ sessions = new Map() } = {}) {
    this.sessions = sessions;
    this.logs = [];
    this.wss = null;
    this.lastReadOffset = 0;
    this._load();
    this._hookConsole();
    this._startFileWatcher();
  }

  setSessionsMap(sessions) {
    this.sessions = sessions;
  }

  static appendExternalLog(entry) {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (fs.existsSync(UNIFIED_LOG_FILE)) {
        const stats = fs.statSync(UNIFIED_LOG_FILE);
        if (stats.size > MAX_LOG_FILE_SIZE) {
          const rotated = `${UNIFIED_LOG_FILE}.1`;
          if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
          fs.renameSync(UNIFIED_LOG_FILE, rotated);
        }
      }
      const logItem = {
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        timestamp: entry.timestamp || new Date().toISOString(),
        type: entry.type || 'system',
        level: entry.level || 'info',
        message: entry.message || '',
        source: entry.source || 'server',
        details: entry.details || null,
      };
      fs.appendFileSync(UNIFIED_LOG_FILE, JSON.stringify(logItem) + '\n', 'utf8');
      return logItem;
    } catch (_) {
      return null;
    }
  }

  static hookServerProcess(source = 'server') {
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);

    try {
      process.stdout.on?.('error', (err) => {
        if (err.code === 'EPIPE' || err.code === 'EIO' || err.code === 'EBADF') return;
      });
      process.stderr.on?.('error', (err) => {
        if (err.code === 'EPIPE' || err.code === 'EIO' || err.code === 'EBADF') return;
      });
    } catch (_) {}

    const handleWrite = (chunk, isError = false) => {
      try {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const lines = text.split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;
          let type = isError ? 'error' : 'system';
          let level = isError ? 'error' : 'info';
          if (line.includes('[ERROR]') || line.includes('[server] Error') || line.includes('Error:')) {
            type = 'error';
            level = 'error';
          } else if (line.includes('[SECURITY]') || line.includes('[RateLimit]')) {
            type = 'security';
            level = 'warn';
          } else if (line.includes('[AI]')) {
            type = 'ai';
          }

          LogHubManager.appendExternalLog({
            type,
            level,
            message: line,
            source,
          });
        }
      } catch (_) {}
    };

    process.stdout.write = (chunk, encoding, cb) => {
      handleWrite(chunk, false);
      try {
        return originalStdoutWrite(chunk, encoding, cb);
      } catch (err) {
        if (err.code === 'EIO' || err.code === 'EPIPE' || err.code === 'EBADF') return true;
        throw err;
      }
    };

    process.stderr.write = (chunk, encoding, cb) => {
      handleWrite(chunk, true);
      try {
        return originalStderrWrite(chunk, encoding, cb);
      } catch (err) {
        if (err.code === 'EIO' || err.code === 'EPIPE' || err.code === 'EBADF') return true;
        throw err;
      }
    };
  }

  _startFileWatcher() {
    // 外部プロセス（NyaitterServer 本体）からのログ追記をリアルタイム監視
    let lastSize = 0;
    try {
      if (fs.existsSync(UNIFIED_LOG_FILE)) {
        lastSize = fs.statSync(UNIFIED_LOG_FILE).size;
      }
    } catch (_) {}

    const checkFile = () => {
      try {
        if (!fs.existsSync(UNIFIED_LOG_FILE)) return;
        const currentSize = fs.statSync(UNIFIED_LOG_FILE).size;
        if (currentSize <= lastSize) {
          if (currentSize < lastSize) lastSize = currentSize; // ローテーション時
          return;
        }

        const stream = fs.createReadStream(UNIFIED_LOG_FILE, {
          start: lastSize,
          end: currentSize,
          encoding: 'utf8',
        });

        let chunkData = '';
        stream.on('data', (c) => { chunkData += c; });
        stream.on('end', () => {
          lastSize = currentSize;
          const lines = chunkData.split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const item = JSON.parse(line);
              if (!this.logs.some((l) => l.id === item.id)) {
                this.logs.push(item);
                if (this.logs.length > MAX_LOG_LINES) this.logs.shift();
                if (this.wss) this._broadcast(item);
              }
            } catch (_) {}
          }
        });
      } catch (_) {}
    };

    setInterval(checkFile, 300);
  }

  _load() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (fs.existsSync(UNIFIED_LOG_FILE)) {
        const raw = fs.readFileSync(UNIFIED_LOG_FILE, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        const recent = lines.slice(-MAX_LOG_LINES);
        for (const line of recent) {
          try {
            const parsed = JSON.parse(line);
            this.logs.push(parsed);
          } catch (_) {}
        }
      }
    } catch (e) {
      console.warn('[LogHub] Failed to load unified logs:', e.message);
    }
  }

  _persistLog(logEntry) {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

      if (fs.existsSync(UNIFIED_LOG_FILE)) {
        const stats = fs.statSync(UNIFIED_LOG_FILE);
        if (stats.size > MAX_LOG_FILE_SIZE) {
          const rotated = `${UNIFIED_LOG_FILE}.1`;
          if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
          fs.renameSync(UNIFIED_LOG_FILE, rotated);
        }
      }

      fs.appendFileSync(UNIFIED_LOG_FILE, JSON.stringify(logEntry) + '\n', 'utf8');
    } catch (_) {}
  }

  _hookConsole() {
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);

    try {
      process.stdout.on?.('error', (err) => {
        if (err.code === 'EPIPE' || err.code === 'EIO' || err.code === 'EBADF') return;
      });
      process.stderr.on?.('error', (err) => {
        if (err.code === 'EPIPE' || err.code === 'EIO' || err.code === 'EBADF') return;
      });
    } catch (_) {}

    const handleWrite = (chunk, isError = false) => {
      try {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const lines = text.split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;
          this.addLog({
            type: isError ? 'error' : 'system',
            level: isError ? 'error' : 'info',
            message: line,
            source: 'console',
          }, false);
        }
      } catch (_) {}
    };

    process.stdout.write = (chunk, encoding, cb) => {
      handleWrite(chunk, false);
      try {
        return originalStdoutWrite(chunk, encoding, cb);
      } catch (err) {
        if (err.code === 'EIO' || err.code === 'EPIPE' || err.code === 'EBADF') return true;
        throw err;
      }
    };

    process.stderr.write = (chunk, encoding, cb) => {
      handleWrite(chunk, true);
      try {
        return originalStderrWrite(chunk, encoding, cb);
      } catch (err) {
        if (err.code === 'EIO' || err.code === 'EPIPE' || err.code === 'EBADF') return true;
        throw err;
      }
    };
  }

  setServerControl(serverControl) {
    this.serverControl = serverControl;
  }

  setErrorManager(errorManager) {
    this.errorManager = errorManager;
  }

  broadcastError(errorRecord, eventType = 'error_created') {
    if (!this.wss || !this.wss.clients) return;
    const msg = JSON.stringify({
      event: eventType,
      error: errorRecord,
    });
    for (const client of this.wss.clients) {
      if (client.readyState === 1) { // OPEN
        try {
          client.send(msg);
        } catch (_) {}
      }
    }
  }

  attachHttpServer(httpServer) {
    if (this.wss) return;

    this.wss = new WebSocketServer({ noServer: true });

    // 定期的な Server Status の WebSocket ブロードキャスト（3秒間隔）
    setInterval(async () => {
      if (!this.wss || !this.serverControl || typeof this.serverControl.getStatus !== 'function') return;
      if (this.wss.clients.size === 0) return;

      try {
        const status = await this.serverControl.getStatus();
        const msg = JSON.stringify({ event: 'server_status', status });
        for (const client of this.wss.clients) {
          if (client.readyState === 1) client.send(msg);
        }
      } catch (_) {}
    }, 3000);

    httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      if (url.pathname !== '/ws/logs') return;

      const token = url.searchParams.get('token');
      const session = this.sessions.get(token);

      if (!session || !session.admin || (session.expiresAt && Date.now() > session.expiresAt)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      });
    });

    this.wss.on('connection', async (ws) => {
      // 接続時に直近のフィルタリングログ（通常ログ除外）を送信
      const initialLogs = this.getLogs({
        types: ['error', 'security', 'ai', 'admin', 'moderation'],
        limit: 100,
      });

      ws.send(JSON.stringify({
        event: 'init',
        logs: initialLogs,
      }));

      // 接続時に即座に Server Status を送信
      if (this.serverControl && typeof this.serverControl.getStatus === 'function') {
        try {
          const status = await this.serverControl.getStatus();
          ws.send(JSON.stringify({ event: 'server_status', status }));
        } catch (_) {}
      }

      // 接続時に最新のエラー一覧を送信
      if (this.errorManager && typeof this.errorManager.getErrors === 'function') {
        try {
          const errorData = this.errorManager.getErrors({ limit: 50 });
          ws.send(JSON.stringify({ event: 'init_errors', errors: errorData.errors || [] }));
        } catch (_) {}
      }

      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message);
          if (data.action === 'filter') {
            const filtered = this.getLogs({
              types: data.types || ['error', 'security', 'ai', 'admin', 'moderation'],
              search: data.search || '',
              level: data.level || 'all',
              limit: data.limit || 150,
            });
            ws.send(JSON.stringify({ event: 'filtered', logs: filtered }));
          } else if (data.action === 'get_status') {
            if (this.serverControl && typeof this.serverControl.getStatus === 'function') {
              const status = await this.serverControl.getStatus();
              ws.send(JSON.stringify({ event: 'server_status', status }));
            }
          } else if (data.action === 'get_errors') {
            if (this.errorManager && typeof this.errorManager.getErrors === 'function') {
              const errorData = this.errorManager.getErrors({
                status: data.status,
                search: data.search,
                limit: data.limit || 50,
              });
              ws.send(JSON.stringify({ event: 'errors_data', errors: errorData.errors || [] }));
            }
          }
        } catch (_) {}
      });
    });
  }

  addLog(entry, shouldBroadcast = true) {
    const logItem = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: entry.timestamp || new Date().toISOString(),
      type: entry.type || 'system', // 'system' | 'error' | 'security' | 'ai' | 'admin' | 'moderation'
      level: entry.level || 'info', // 'info' | 'warn' | 'error'
      message: entry.message || '',
      source: entry.source || 'server',
      details: entry.details || null,
    };

    this.logs.push(logItem);
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs = this.logs.slice(-MAX_LOG_LINES);
    }
    this._persistLog(logItem);

    if (shouldBroadcast && this.wss) {
      this._broadcast(logItem);
    }

    return logItem;
  }

  _broadcast(logItem) {
    if (!this.wss || !this.wss.clients) return;
    const msg = JSON.stringify({
      event: 'log',
      log: logItem,
    });

    for (const client of this.wss.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        try {
          client.send(msg);
        } catch (_) {}
      }
    }
  }

  getLogs({ types = ['error', 'security', 'ai', 'admin', 'moderation'], search = '', level = 'all', limit = 200 } = {}) {
    let result = this.logs;

    if (Array.isArray(types) && types.length > 0) {
      const typeSet = new Set(types);
      result = result.filter((l) => typeSet.has(l.type));
    }

    if (level && level !== 'all') {
      result = result.filter((l) => l.level === level);
    }

    if (search) {
      const q = search.toLowerCase();
      result = result.filter((l) => {
        return (l.message || '').toLowerCase().includes(q) ||
               (l.source || '').toLowerCase().includes(q) ||
               (l.type || '').toLowerCase().includes(q);
      });
    }

    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, MAX_LOG_LINES));
    return result.slice(-safeLimit);
  }

  clearLogs() {
    this.logs = [];
    try {
      if (fs.existsSync(UNIFIED_LOG_FILE)) fs.unlinkSync(UNIFIED_LOG_FILE);
    } catch (_) {}
  }
}

module.exports = LogHubManager;
