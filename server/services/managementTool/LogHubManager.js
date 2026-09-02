'use strict';

const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const DATA_DIR = path.resolve(__dirname, '../../data');
const UNIFIED_LOG_FILE = path.join(DATA_DIR, 'nmt-unified.log');
const MAX_LOG_LINES = 2000;
const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024; // 5MB

class LogHubManager {
  constructor({ sessions = new Map() } = {}) {
    this.sessions = sessions;
    this.logs = [];
    this.wss = null;
    this._lastFileSize = 0;
    this._load();
    this._hookConsole();
    this._startFileWatcher();
  }

  setSessionsMap(sessions) {
    this.sessions = sessions;
  }

  _load() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (fs.existsSync(UNIFIED_LOG_FILE)) {
        const stats = fs.statSync(UNIFIED_LOG_FILE);
        this._lastFileSize = stats.size;
        const raw = fs.readFileSync(UNIFIED_LOG_FILE, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        for (const line of lines.slice(-MAX_LOG_LINES)) {
          try {
            this.logs.push(JSON.parse(line));
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  _startFileWatcher() {
    const checkFile = () => {
      try {
        if (!fs.existsSync(UNIFIED_LOG_FILE)) return;
        const currentSize = fs.statSync(UNIFIED_LOG_FILE).size;
        if (currentSize <= this._lastFileSize) {
          if (currentSize < this._lastFileSize) this._lastFileSize = currentSize;
          return;
        }

        const stream = fs.createReadStream(UNIFIED_LOG_FILE, {
          start: this._lastFileSize,
          end: currentSize,
          encoding: 'utf8',
        });

        let chunk = '';
        stream.on('data', (c) => { chunk += c; });
        stream.on('end', () => {
          this._lastFileSize = currentSize;
          const lines = chunk.split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const item = JSON.parse(line);
              if (!this.logs.some((l) => l.id === item.id)) {
                this.logs.push(item);
                if (this.logs.length > MAX_LOG_LINES) this.logs.shift();
                this.broadcast(item);
              }
            } catch (_) {}
          }
        });
      } catch (_) {}
    };

    const timer = setInterval(checkFile, 1000);
    timer.unref?.();
  }

  static appendExternalLog(entry) {
    if (!entry) return null;
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
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
    const origStdout = process.stdout.write.bind(process.stdout);
    const origStderr = process.stderr.write.bind(process.stderr);

    const logWrite = (chunk, isErr = false) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const level = isErr || line.includes('[ERROR]') || line.includes('Error:') ? 'error' : (line.includes('[WARN]') || line.includes('Warning:') ? 'warn' : 'info');
        LogHubManager.appendExternalLog({
          level,
          type: 'system',
          message: line,
          source,
        });
      }
    };

    process.stdout.write = (chunk, enc, cb) => {
      logWrite(chunk, false);
      return origStdout(chunk, enc, cb);
    };

    process.stderr.write = (chunk, enc, cb) => {
      logWrite(chunk, true);
      return origStderr(chunk, enc, cb);
    };
  }

  _hookConsole() {
    LogHubManager.hookServerProcess('nmt');
  }

  addLog(entry) {
    if (!entry) return null;
    return LogHubManager.appendExternalLog(entry);
  }

  getLogs({ limit = 200, level = 'all', search = '' } = {}) {
    let result = this.logs;
    if (level && level !== 'all') {
      result = result.filter((l) => l.level === level);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((l) => (
        (l.message && l.message.toLowerCase().includes(q)) ||
        (l.source && l.source.toLowerCase().includes(q))
      ));
    }
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, MAX_LOG_LINES));
    return result.slice(-safeLimit);
  }

  clearLogs() {
    this.logs = [];
    this._lastFileSize = 0;
    try {
      if (fs.existsSync(UNIFIED_LOG_FILE)) fs.unlinkSync(UNIFIED_LOG_FILE);
    } catch (_) {}
    return true;
  }

  attachWebSocket(httpServer) {
    if (this.wss) return;
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    this.wss.on('connection', (ws) => {
      ws.send(JSON.stringify({
        type: 'init',
        logs: this.logs.slice(-100),
      }));

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString('utf8'));
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch (_) {}
      });
    });
  }

  broadcast(logItem) {
    if (!this.wss) return;
    const payload = JSON.stringify({ type: 'log', log: logItem });
    for (const client of this.wss.clients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  }

  close() {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }
}

module.exports = LogHubManager;
