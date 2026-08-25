'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const SERVER_DIR = path.resolve(__dirname, '../../');
const ENV_FILE = path.join(SERVER_DIR, '.env');
const ROOT_ENV_FILE = path.join(PROJECT_ROOT, '.env');
const CONFIG_FILE = path.join(SERVER_DIR, 'config.json');
const ROOT_CONFIG_FILE = path.join(PROJECT_ROOT, 'config.json');

const DATA_DIR = path.resolve(__dirname, '../../data');
const SERVER_LOG_FILE = path.join(DATA_DIR, 'nmt-server.log');

const MAX_LOG_LINES = 2000;
const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024; // 5MB

class ServerControlManager {
  constructor({ shutdownFn = null, getStatusFn = null } = {}) {
    this.shutdownFn = shutdownFn;
    this.getStatusFn = getStatusFn;
    this.logs = [];
    this.startedAt = new Date().toISOString();
    this._loadLogs();
    this._hookConsole();
  }

  setShutdownHandler(shutdownFn) {
    this.shutdownFn = shutdownFn;
  }

  setStatusProvider(getStatusFn) {
    this.getStatusFn = getStatusFn;
  }

  _loadLogs() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (fs.existsSync(SERVER_LOG_FILE)) {
        const raw = fs.readFileSync(SERVER_LOG_FILE, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        for (const line of lines.slice(-MAX_LOG_LINES)) {
          try {
            const parsed = JSON.parse(line);
            this.logs.push(parsed);
          } catch (_) {}
        }
      }
    } catch (e) {
      console.warn('[NMT-Logs] Failed to load server log file:', e.message);
    }
  }

  _persistLogLine(logObj) {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

      // ローテーション確認
      if (fs.existsSync(SERVER_LOG_FILE)) {
        const stats = fs.statSync(SERVER_LOG_FILE);
        if (stats.size > MAX_LOG_FILE_SIZE) {
          const rotated = `${SERVER_LOG_FILE}.1`;
          if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
          fs.renameSync(SERVER_LOG_FILE, rotated);
        }
      }

      fs.appendFileSync(SERVER_LOG_FILE, JSON.stringify(logObj) + '\n', 'utf8');
    } catch (_) {}
  }

  _hookConsole() {
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);

    const appendLog = (chunk, isError = false) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const lines = text.split('\n');
      const now = new Date().toISOString();

      for (const line of lines) {
        if (!line.trim()) continue;
        const logObj = {
          timestamp: now,
          level: isError ? 'error' : 'info',
          message: line,
        };
        this.logs.push(logObj);
        this._persistLogLine(logObj);
      }

      if (this.logs.length > MAX_LOG_LINES) {
        this.logs = this.logs.slice(-MAX_LOG_LINES);
      }
    };

    process.stdout.write = (chunk, encoding, cb) => {
      appendLog(chunk, false);
      return originalStdoutWrite(chunk, encoding, cb);
    };

    process.stderr.write = (chunk, encoding, cb) => {
      appendLog(chunk, true);
      return originalStderrWrite(chunk, encoding, cb);
    };
  }

  getStatus() {
    const memory = process.memoryUsage();
    const pm2Id = process.env.pm_id !== undefined ? process.env.pm_id : null;
    const baseStatus = typeof this.getStatusFn === 'function' ? this.getStatusFn() : {};

    return {
      pid: process.pid,
      uptime: process.uptime(),
      startedAt: this.startedAt,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      isPm2: pm2Id !== null,
      pm2Id,
      memory: {
        rss: Math.round(memory.rss / (1024 * 1024)),
        heapTotal: Math.round(memory.heapTotal / (1024 * 1024)),
        heapUsed: Math.round(memory.heapUsed / (1024 * 1024)),
        external: Math.round(memory.external / (1024 * 1024)),
      },
      ...baseStatus,
    };
  }

  getLogs({ limit = 200, level = 'all', search = '' } = {}) {
    let result = this.logs;
    if (level && level !== 'all') {
      result = result.filter((l) => l.level === level);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((l) => l.message.toLowerCase().includes(q));
    }
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, MAX_LOG_LINES));
    return result.slice(-safeLimit);
  }

  async restartServer() {
    console.log('[NMT] Server restart requested via Management Tool.');
    const isPm2 = process.env.pm_id !== undefined;

    if (isPm2) {
      setTimeout(() => {
        execFile('pm2', ['restart', process.env.pm_id || 'nyaitter-server'], (err) => {
          if (err) console.error('[NMT] PM2 restart error:', err.message);
        });
      }, 500);
      return { success: true, mode: 'pm2', message: 'PM2 再起動シグナルを送信しました。' };
    }

    if (typeof this.shutdownFn === 'function') {
      setTimeout(() => {
        this.shutdownFn('NMT_RESTART');
      }, 500);
      return { success: true, mode: 'shutdown', message: 'サーバー再起動/シャットダウンを開始しました。' };
    }

    setTimeout(() => process.exit(0), 500);
    return { success: true, mode: 'exit', message: 'プロセスを終了します（スーパーバイザーで再起動されます）。' };
  }

  async stopServer() {
    console.log('[NMT] Server stop requested via Management Tool.');
    if (typeof this.shutdownFn === 'function') {
      setTimeout(() => this.shutdownFn('NMT_STOP'), 500);
      return { success: true, message: 'サーバー停止（シャットダウン）を開始しました。' };
    }

    setTimeout(() => process.exit(0), 500);
    return { success: true, message: 'プロセスを終了します。' };
  }

  // ── .env ファイル操作 ──────────────────────────────────────────────────
  _resolveEnvPath() {
    if (fs.existsSync(ENV_FILE)) return ENV_FILE;
    if (fs.existsSync(ROOT_ENV_FILE)) return ROOT_ENV_FILE;
    return ENV_FILE;
  }

  getEnv() {
    const targetPath = this._resolveEnvPath();
    if (fs.existsSync(targetPath)) {
      return {
        path: targetPath,
        content: fs.readFileSync(targetPath, 'utf8'),
        exists: true,
      };
    }
    return {
      path: targetPath,
      content: '',
      exists: false,
    };
  }

  updateEnv(content) {
    if (typeof content !== 'string') throw new Error('Content must be a string');
    const targetPath = this._resolveEnvPath();

    // バックアップ作成
    if (fs.existsSync(targetPath)) {
      const backupPath = `${targetPath}.backup.${Date.now()}`;
      try {
        fs.copyFileSync(targetPath, backupPath);
      } catch (e) {
        console.warn('[NMT] Failed to create .env backup:', e.message);
      }
    }

    fs.writeFileSync(targetPath, content, 'utf8');
    return { success: true, message: '.env ファイルを更新しました。反映には再起動が必要です。', path: targetPath };
  }

  // ── config.json ファイル操作 ──────────────────────────────────────────
  _resolveConfigPath() {
    if (fs.existsSync(CONFIG_FILE)) return CONFIG_FILE;
    if (fs.existsSync(ROOT_CONFIG_FILE)) return ROOT_CONFIG_FILE;
    return CONFIG_FILE;
  }

  getConfigFile() {
    const targetPath = this._resolveConfigPath();
    if (fs.existsSync(targetPath)) {
      return {
        path: targetPath,
        content: fs.readFileSync(targetPath, 'utf8'),
        exists: true,
      };
    }
    return {
      path: targetPath,
      content: '{}',
      exists: false,
    };
  }

  updateConfigFile(content) {
    if (typeof content !== 'string') throw new Error('Content must be a string');
    
    // JSON バリデーション
    try {
      JSON.parse(content);
    } catch (err) {
      throw new Error(`無効な JSON フォーマットです: ${err.message}`);
    }

    const targetPath = this._resolveConfigPath();

    // バックアップ作成
    if (fs.existsSync(targetPath)) {
      const backupPath = `${targetPath}.backup.${Date.now()}`;
      try {
        fs.copyFileSync(targetPath, backupPath);
      } catch (e) {
        console.warn('[NMT] Failed to create config.json backup:', e.message);
      }
    }

    fs.writeFileSync(targetPath, content, 'utf8');
    return { success: true, message: 'config.json を更新しました。反映には再起動が必要です。', path: targetPath };
  }
}

module.exports = ServerControlManager;
