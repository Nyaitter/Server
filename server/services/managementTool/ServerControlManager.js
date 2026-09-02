'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const net = require('net');
const { requestOperatorCommand } = require('../../utils/operatorControl');

const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const SERVER_DIR = path.resolve(__dirname, '../../');
const ENV_FILE = path.join(SERVER_DIR, '.env');
const CONFIG_FILE = path.join(SERVER_DIR, 'config.json');
const DATA_DIR = path.resolve(__dirname, '../../data');
const SERVER_PID_FILES = [
  path.join(DATA_DIR, 'server.pid'),
  path.join(PROJECT_ROOT, 'data', 'server.pid'),
];

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
    for (const pidFile of SERVER_PID_FILES) {
      try {
        if (fs.existsSync(pidFile)) {
          const raw = fs.readFileSync(pidFile, 'utf8').trim();
          const pid = parseInt(raw, 10);
          if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
            try {
              process.kill(pid, 0);
              return pid;
            } catch (_) {}
          }
        }
      } catch (_) {}
    }

    // fallback: lsof / fuser
    try {
      const port = Number(process.env.PORT) || 3000;
      const out = execSync(`lsof -t -i :${port} 2>/dev/null || fuser ${port}/tcp 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (out) {
        const pids = out.split(/\s+/).map((p) => parseInt(p, 10)).filter((p) => !isNaN(p) && p !== process.pid);
        if (pids.length > 0) return pids[0];
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
      socket.setTimeout(600, () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  async getStatus() {
    let serverOnline = false;
    let serverPid = null;
    let serverPort = Number(process.env.PORT) || 3000;
    let serverStartedAt = null;

    // 1. Operator Control Socket から直接 NyaitterServer の稼働状態を取得
    try {
      const opRes = await requestOperatorCommand({ action: 'status' }, { timeoutMs: 1000 });
      if (opRes?.ok && opRes.status) {
        serverOnline = true;
        serverPid = opRes.status.pid || null;
        serverPort = opRes.status.port || serverPort;
        serverStartedAt = opRes.status.startedAt || null;
      }
    } catch (_) {}

    // 2. Socket がまだない場合は PID ファイル & ポート確認
    if (!serverOnline) {
      serverPid = this.getServerPid();
      const isPortActive = await this.isPortOpen(serverPort);
      serverOnline = Boolean(serverPid || isPortActive);
    }

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
        startedAt: serverStartedAt,
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

    for (const pidFile of SERVER_PID_FILES) {
      try {
        const dir = path.dirname(pidFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(pidFile, String(child.pid), 'utf8');
      } catch (_) {}
    }

    return { success: true, pid: child.pid, message: `NyaitterServer を起動しました (PID: ${child.pid})` };
  }

  async stopServer() {
    // 1. Operator Control 経由で安全に停止
    try {
      const res = await requestOperatorCommand({ action: 'shutdown' }, { timeoutMs: 1500 });
      if (res?.ok) {
        this._cleanupPidFiles();
        return { success: true, message: 'NyaitterServer を安全に停止しました。' };
      }
    } catch (_) {}

    // 2. PID から直接 SIGTERM
    const pid = this.getServerPid();
    if (!pid) {
      return { success: false, message: 'NyaitterServer は既に停止しています。' };
    }

    try {
      process.kill(pid, 'SIGTERM');
      this._cleanupPidFiles();
      return { success: true, message: `NyaitterServer (PID: ${pid}) へ停止シグナルを送信しました。` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  _cleanupPidFiles() {
    for (const pidFile of SERVER_PID_FILES) {
      try {
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      } catch (_) {}
    }
  }

  async restartServer() {
    await this.stopServer();
    await new Promise((r) => setTimeout(r, 1200));
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
