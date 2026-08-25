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
    this._cpuPercent = 0;
    this._lastCpuUsage = process.cpuUsage();
    this._lastCpuTime = Date.now();
    this._startCpuTracking();
    this._loadLogs();
    this._hookConsole();
  }

  setShutdownHandler(shutdownFn) {
    this.shutdownFn = shutdownFn;
  }

  setStatusProvider(getStatusFn) {
    this.getStatusFn = getStatusFn;
  }

  _startCpuTracking() {
    const sample = () => {
      const now = Date.now();
      const elapsed = now - this._lastCpuTime;
      if (elapsed <= 0) return;

      const usage = process.cpuUsage(this._lastCpuUsage);
      // user + system マイクロ秒 → ミリ秒換算し、経過時間に対する割合(%)
      const cpuMs = (usage.user + usage.system) / 1000;
      this._cpuPercent = Math.min(100, Math.round((cpuMs / elapsed) * 100 * 10) / 10);

      this._lastCpuUsage = process.cpuUsage();
      this._lastCpuTime = now;
    };

    const timer = setInterval(sample, 2000);
    timer.unref?.();
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

  async getStatus() {
    const { requestOperatorCommand } = require('../../utils/operatorControl');
    let nyaitterServerStatus = null;

    // 1. ローカル専用 IPC (operatorControl) 経由で NyaitterServer 本体のステータスを取得
    try {
      const res = await requestOperatorCommand({ action: 'status' }, { timeoutMs: 1000 });
      if (res?.ok && res.status) {
        nyaitterServerStatus = res.status;
      }
    } catch (_) {}

    const memory = process.memoryUsage();
    const pm2Id = process.env.pm_id !== undefined ? process.env.pm_id : null;
    const baseStatus = typeof this.getStatusFn === 'function' ? this.getStatusFn() : {};

    return {
      pid: nyaitterServerStatus?.pid || process.pid,
      serverPid: nyaitterServerStatus?.pid || null,
      nmtPid: process.pid,
      serverOnline: nyaitterServerStatus !== null,
      uptime: nyaitterServerStatus?.uptime || process.uptime(),
      startedAt: nyaitterServerStatus?.startedAt || this.startedAt,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      databaseAdapter: nyaitterServerStatus?.databaseAdapter || 'memory',
      storageAdapter: nyaitterServerStatus?.storageAdapter || 'local',
      isPm2: pm2Id !== null,
      pm2Id,
      memory: {
        rss: Math.round(memory.rss / (1024 * 1024)),
        heapTotal: Math.round(memory.heapTotal / (1024 * 1024)),
        heapUsed: Math.round(memory.heapUsed / (1024 * 1024)),
        external: Math.round(memory.external / (1024 * 1024)),
      },
      cpu: this._cpuPercent,
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

    // ── 安全なプロセス分離再起動（新プロセスの起動確認後に旧プロセスを交代） ──
    const { spawn } = require('child_process');
    const net = require('net');
    const mainScript = path.resolve(PROJECT_ROOT, 'server/index.js');
    const serverPort = Number(process.env.PORT) || 3000;

    return new Promise((resolve) => {
      let isResolved = false;
      const child = spawn(process.execPath, [mainScript], {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: 'inherit',
        env: {
          ...process.env,
          NMT_ENABLED: 'true',
        },
      });

      child.unref();

      let checkInterval = null;
      let timeoutTimer = null;

      const cleanup = () => {
        if (checkInterval) clearInterval(checkInterval);
        if (timeoutTimer) clearTimeout(timeoutTimer);
      };

      // 1. 新プロセスのヘルスチェック（ポート接続確認）
      checkInterval = setInterval(() => {
        const socket = net.createConnection({ port: serverPort, host: '127.0.0.1' }, () => {
          socket.end();
          cleanup();
          if (isResolved) return;
          isResolved = true;

          // 新プロセスの正常起動が確認できたため、旧プロセスを安全にシャットダウン
          if (typeof this.shutdownFn === 'function') {
            setTimeout(() => this.shutdownFn('NMT_ZERO_DOWNTIME_HANDOVER'), 500);
          }

          resolve({
            success: true,
            mode: 'safe_handover',
            newPid: child.pid,
            message: `NyaitterServer 新プロセス (PID: ${child.pid}) の正常起動を確認しました。旧プロセスを安全に交代しました。`,
          });
        });

        socket.on('error', () => {
          // まだ起動中
        });
      }, 1000);

      // 2. タイムアウト（30秒以内に起動しない場合は旧プロセス維持）
      timeoutTimer = setTimeout(() => {
        cleanup();
        if (isResolved) return;
        isResolved = true;

        try {
          process.kill(child.pid, 'SIGKILL');
        } catch (_) {}

        resolve({
          success: false,
          mode: 'failed_maintained',
          message: '新プロセスの起動がタイムアウトしました。安全のため旧プロセスをそのまま維持しています。',
        });
      }, 30000);

      // 3. 新プロセスの異常終了検知
      child.on('exit', (code) => {
        cleanup();
        if (isResolved) return;
        isResolved = true;

        resolve({
          success: false,
          mode: 'crash_prevented',
          message: `新プロセスがエラー終了しました (Exit code: ${code})。安全のため旧プロセスをそのまま維持しています。`,
        });
      });
    });
  }

  // ── NMT 自身の安全なホットリスタート ───────────────────────────────────
  async restartNMT(nmtServerInstance = null) {
    console.log('[NMT] Self-restart requested via Management Tool.');
    const { fork } = require('child_process');
    const standaloneScript = path.resolve(__dirname, 'standalone.js');

    return new Promise((resolve) => {
      // 1. 事前構文チェック
      execFile('node', ['--check', standaloneScript], (checkErr) => {
        if (checkErr) {
          return resolve({
            success: false,
            mode: 'syntax_error_prevented',
            message: `NMT スクリプトの構文エラーを検知しました: ${checkErr.message}。安全のため旧プロセスを維持します。`,
          });
        }

        // 2. 旧 NMT の HTTP サーバーを先に停止してポートを解放
        if (nmtServerInstance && typeof nmtServerInstance.stop === 'function') {
          nmtServerInstance.stop();
        }

        let isResolved = false;
        const child = fork(standaloneScript, [], {
          cwd: PROJECT_ROOT,
          detached: true,
          stdio: 'inherit',
          env: { ...process.env },
        });

        let timeoutTimer = null;

        const cleanup = () => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
        };

        // 3. 新 NMT プロセスからの起動完了 IPC メッセージを待機
        child.on('message', (msg) => {
          if (msg && msg.type === 'nmt_ready') {
            cleanup();
            if (isResolved) return;
            isResolved = true;

            // 新 NMT プロセスが正常起動したため、旧 NMT を安全に終了
            setTimeout(() => {
              child.unref();
              process.exit(0);
            }, 500);

            resolve({
              success: true,
              mode: 'nmt_handover_success',
              newPid: msg.pid || child.pid,
              message: `新 NMT プロセス (PID: ${msg.pid || child.pid}) の正常起動を確認しました。旧 NMT プロセスを安全に終了します。`,
            });
          }
        });

        // 4. タイムアウト（15秒）
        timeoutTimer = setTimeout(() => {
          cleanup();
          if (isResolved) return;
          isResolved = true;

          try {
            child.kill('SIGKILL');
          } catch (_) {}

          resolve({
            success: false,
            mode: 'nmt_timeout_prevented',
            message: '新 NMT プロセスの起動がタイムアウトしました。安全のため旧 NMT プロセスをそのまま維持しています。',
          });
        }, 15000);

        // 5. 新プロセスの異常終了
        child.on('exit', (code) => {
          cleanup();
          if (isResolved) return;
          isResolved = true;

          resolve({
            success: false,
            mode: 'nmt_crash_prevented',
            message: `新 NMT プロセスが起動途中で異常終了しました (Exit code: ${code})。安全のため旧 NMT プロセスを維持しています。`,
          });
        });
      });
    });
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

  updateEnvVariables(keyValueMap) {
    if (!keyValueMap || typeof keyValueMap !== 'object') return { success: false, error: 'Invalid map' };
    const targetPath = this._resolveEnvPath();

    let content = '';
    if (fs.existsSync(targetPath)) {
      content = fs.readFileSync(targetPath, 'utf8');
      const backupPath = `${targetPath}.backup.${Date.now()}`;
      try {
        fs.copyFileSync(targetPath, backupPath);
      } catch (_) {}
    }

    const lines = content.split('\n');
    const updatedKeys = new Set();
    const newLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) return line;
      const key = line.slice(0, eqIdx).trim();
      if (Object.prototype.hasOwnProperty.call(keyValueMap, key)) {
        updatedKeys.add(key);
        const rawVal = keyValueMap[key];
        const valStr = String(rawVal ?? '');
        process.env[key] = valStr;
        const needsQuote = /[\s#"'\\]/.test(valStr);
        const formattedVal = needsQuote ? JSON.stringify(valStr) : valStr;
        return `${key}=${formattedVal}`;
      }
      return line;
    });

    for (const [key, val] of Object.entries(keyValueMap)) {
      if (!updatedKeys.has(key) && val !== undefined) {
        const valStr = String(val ?? '');
        process.env[key] = valStr;
        const needsQuote = /[\s#"'\\]/.test(valStr);
        const formattedVal = needsQuote ? JSON.stringify(valStr) : valStr;
        newLines.push(`${key}=${formattedVal}`);
      }
    }

    const newContent = newLines.join('\n');
    fs.writeFileSync(targetPath, newContent, 'utf8');
    return { success: true, path: targetPath };
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
