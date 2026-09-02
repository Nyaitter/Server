'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const net = require('net');

const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const SERVER_DIR = path.resolve(__dirname, '../../');
const ENV_FILE = path.join(SERVER_DIR, '.env');
const CONFIG_FILE = path.join(SERVER_DIR, 'config.json');
const DATA_DIR = path.resolve(__dirname, '../../data');
const SERVER_PID_FILE = path.join(DATA_DIR, 'server.pid');

class ServerControlManager {
  constructor({ dbAdapter = null } = {}) {
    this.dbAdapter = dbAdapter;
    this.startedAt = new Date().toISOString();
    this._cpuPercent = 0;
    this._lastCpuUsage = process.cpuUsage();
    this._lastCpuTime = Date.now();
    this._startCpuTracking();
  }

  setDbAdapter(dbAdapter) {
    this.dbAdapter = dbAdapter;
  }

  _startCpuTracking() {
    const sample = () => {
      const now = Date.now();
      const elapsed = now - this._lastCpuTime;
      if (elapsed <= 0) return;
      const usage = process.cpuUsage(this._lastCpuUsage);
      const cpuMs = (usage.user + usage.system) / 1000;
      this._cpuPercent = Math.min(100, Math.round((cpuMs / elapsed) * 100 * 10) / 10);
      this._lastCpuUsage = process.cpuUsage();
      this._lastCpuTime = now;
    };
    const timer = setInterval(sample, 3000);
    timer.unref?.();
  }

  getServerPid() {
    try {
      if (fs.existsSync(SERVER_PID_FILE)) {
        const raw = fs.readFileSync(SERVER_PID_FILE, 'utf8').trim();
        const pid = parseInt(raw, 10);
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0); // 存在確認
            return pid;
          } catch (_) {
            return null;
          }
        }
      }
    } catch (_) {}
    return null;
  }

  async isPortOpen(port = 3000) {
    return new Promise((resolve) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  async getStatus() {
    const serverPid = this.getServerPid();
    const serverPort = Number(process.env.PORT) || 3000;
    const isServerPortActive = await this.isPortOpen(serverPort);
    const serverOnline = Boolean(serverPid || isServerPortActive);

    const memory = process.memoryUsage();

    let dbStatus = 'unknown';
    let dbError = null;
    if (this.dbAdapter) {
      try {
        if (typeof this.dbAdapter.healthCheck === 'function') {
          const ok = await this.dbAdapter.healthCheck();
          dbStatus = ok ? 'connected' : 'degraded';
        } else if (this.dbAdapter.pool) {
          await this.dbAdapter.pool.query('SELECT 1');
          dbStatus = 'connected';
        } else {
          dbStatus = 'connected';
        }
      } catch (e) {
        dbStatus = 'disconnected';
        dbError = e.message;
      }
    }

    return {
      nmt: {
        pid: process.pid,
        port: Number(process.env.NMT_PORT) || 4040,
        uptime: Math.round(process.uptime()),
        startedAt: this.startedAt,
        memoryMb: Math.round(memory.rss / (1024 * 1024)),
        cpuPercent: this._cpuPercent,
      },
      server: {
        online: serverOnline,
        pid: serverPid,
        port: serverPort,
      },
      database: {
        status: dbStatus,
        error: dbError,
      },
      system: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    };
  }

  async startServer() {
    const existingPid = this.getServerPid();
    if (existingPid) {
      return { success: false, message: `NyaitterServer は既に稼働中です (PID: ${existingPid})` };
    }

    const mainScript = path.resolve(SERVER_DIR, 'index.js');
    const child = spawn(process.execPath, [mainScript], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'inherit',
      env: { ...process.env },
    });
    child.unref();

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SERVER_PID_FILE, String(child.pid), 'utf8');

    return { success: true, pid: child.pid, message: `NyaitterServer を起動しました (PID: ${child.pid})` };
  }

  async stopServer() {
    const pid = this.getServerPid();
    if (!pid) {
      return { success: false, message: 'NyaitterServer は既に停止しています。' };
    }

    try {
      process.kill(pid, 'SIGTERM');
      try {
        if (fs.existsSync(SERVER_PID_FILE)) fs.unlinkSync(SERVER_PID_FILE);
      } catch (_) {}
      return { success: true, message: `NyaitterServer (PID: ${pid}) へ停止シグナルを送信しました。` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async restartServer() {
    await this.stopServer();
    await new Promise((r) => setTimeout(r, 1000));
    return this.startServer();
  }

  async restartNMT() {
    const standaloneScript = path.resolve(__dirname, 'standalone.js');
    const child = spawn(process.execPath, [standaloneScript], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'inherit',
      env: { ...process.env },
    });
    child.unref();

    setTimeout(() => {
      process.exit(0);
    }, 500);

    return { success: true, message: 'NMT 再起動を開始しました。' };
  }

  getEnv() {
    if (fs.existsSync(ENV_FILE)) {
      return { content: fs.readFileSync(ENV_FILE, 'utf8'), exists: true, path: ENV_FILE };
    }
    return { content: '', exists: false, path: ENV_FILE };
  }

  updateEnv(content) {
    if (typeof content !== 'string') throw new Error('Content must be a string');
    if (fs.existsSync(ENV_FILE)) {
      try {
        fs.copyFileSync(ENV_FILE, `${ENV_FILE}.backup.${Date.now()}`);
      } catch (_) {}
    }
    fs.writeFileSync(ENV_FILE, content, 'utf8');
    return { success: true, message: '.env を更新しました。反映には再起動が必要です。' };
  }

  getConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return { config: parsed, exists: true };
      } catch (_) {}
    }
    return { config: {}, exists: false };
  }

  updateConfig(newConfig) {
    if (!newConfig || typeof newConfig !== 'object') throw new Error('Invalid config object');
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf8');
    return { success: true, message: '設定ファイルを保存しました。' };
  }
}

module.exports = ServerControlManager;
