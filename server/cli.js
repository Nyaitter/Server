#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
    getOperatorSocketPath,
    parseUserId,
    requestOperatorCommand,
} = require('./utils/operatorControl');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(__dirname, '.env');
const STARTUP_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 100;

function printUsage() {
    console.log(`
Nyaitter ローカル管理CLI

使用方法:
  npm run cli -- admin grant <#ユーザーID>
  npm run cli -- admin revoke <#ユーザーID>
  npm run cli -- server start
  npm run cli -- server stop
  npm run cli -- server restart
  npm run cli -- server status
    npm run cli -- maintenance enable
    npm run cli -- maintenance disable
    npm run cli -- maintenance status
  npm run cli -- nmt start
  npm run cli -- nmt stop
  npm run cli -- nmt restart
  npm run cli -- nmt status

環境変数:
  NYAITTER_OPERATOR_SOCKET  ローカル制御ソケットのパス
`);
}

function formatStatus(status) {
    const adapter = status?.databaseAdapter || 'unknown';
    const port = status?.port || 'unknown';
    const pid = status?.pid || 'unknown';
    return `稼働中: PID ${pid}, port ${port}, DB ${adapter}`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function readMaintenanceMode() {
    if (process.env.NYAITTER_MAINTENANCE_MODE !== undefined) {
        return /^(true|1|yes|on)$/i.test(process.env.NYAITTER_MAINTENANCE_MODE);
    }
    try {
        const content = fs.readFileSync(ENV_FILE, 'utf8');
        const match = content.match(/^NYAITTER_MAINTENANCE_MODE\s*=\s*(.*?)\s*$/m);
        return match ? /^(true|1|yes|on)$/i.test(match[1]) : false;
    } catch (_) {
        return false;
    }
}

function writeMaintenanceMode(enabled) {
    let content = '';
    try {
        content = fs.readFileSync(ENV_FILE, 'utf8');
    } catch (_) {}
    const line = `NYAITTER_MAINTENANCE_MODE=${enabled ? 'true' : 'false'}`;
    if (/^NYAITTER_MAINTENANCE_MODE\s*=.*$/m.test(content)) {
        content = content.replace(/^NYAITTER_MAINTENANCE_MODE\s*=.*$/m, line);
    } else {
        content = `${content.replace(/\s*$/, '')}\n${line}\n`;
    }
    fs.writeFileSync(ENV_FILE, content, 'utf8');
}

async function enableMaintenanceMode() {
    writeMaintenanceMode(true);
    const status = await getRunningStatus();
    if (status) {
        await stopServer();
    }
    console.warn('メンテナンスモードを有効にしました。解除するまでサーバーの起動を拒否します。');
}

async function getRunningStatus() {
    try {
        const response = await requestOperatorCommand(
            { action: 'status' },
            { timeoutMs: 500 },
        );
        return response?.ok ? response.status : null;
    } catch (_) {
        return null;
    }
}

async function waitForServer(expectedRunning) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const status = await getRunningStatus();
        if (expectedRunning && status) return { matched: true, status };
        if (!expectedRunning && !status) return { matched: true, status: null };
        await sleep(POLL_INTERVAL_MS);
    }
    return { matched: false, status: null };
}

async function startServer() {
    const status = await getRunningStatus();
    if (status) {
        console.log(formatStatus(status));
        return;
    }

    const logPath = path.join(os.tmpdir(), 'nyaitter-server.log');
    const logFd = fs.openSync(logPath, 'a', 0o600);
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: process.env,
    });
    child.unref();
    fs.closeSync(logFd);

    if (readMaintenanceMode()) {
        console.warn('メンテナンスモードが有効なため、サーバーは起動しませんでした。');
        return;
    }

    const started = await waitForServer(true);
    if (!started.matched || !started.status) {
        throw new Error(`サーバーを起動できませんでした。ログ: ${logPath}`);
    }
    console.log(formatStatus(started.status));
}

async function stopServer() {
    const response = await requestOperatorCommand({ action: 'shutdown' });
    if (!response?.ok)
        throw new Error(response?.error || 'サーバー停止要求に失敗しました');

    const stopped = await waitForServer(false);
    if (!stopped.matched) throw new Error('サーバー停止がタイムアウトしました');
    console.log('サーバーを停止しました。');
}

async function restartServer() {
    const status = await getRunningStatus();
    if (status) await stopServer();
    await startServer();
}

async function setAdministrator(userIdArgument, admin) {
    const userId = parseUserId(userIdArgument);
    if (userId == null)
        throw new Error(
            'ユーザーIDは #3480 または 3480 形式の非負整数で指定してください',
        );

    const response = await requestOperatorCommand({
        action: 'set-admin',
        userId,
        admin,
    });
    if (!response?.ok)
        throw new Error(response?.error || '管理者権限の更新に失敗しました');
    console.log(
        `#${response.user.id} の管理者権限を${response.user.admin ? '付与' : '解除'}しました。`,
    );
}

// ── NMT (Nyaitter Management Tool) CLI Controls ─────────────────────────────
const NMT_PID_FILE = path.join(PROJECT_ROOT, 'data', 'nmt.pid');
const NMT_PORT = 4040;

function getPidListeningOnPort(port) {
    const { execSync } = require('child_process');
    try {
        const out = execSync(`lsof -t -i :${port} 2>/dev/null || fuser ${port}/tcp 2>/dev/null`, { encoding: 'utf8' }).trim();
        if (out) {
            const pids = out.split(/\s+/).map((p) => parseInt(p, 10)).filter((p) => !isNaN(p) && p !== process.pid);
            if (pids.length > 0) return pids[0];
        }
    } catch (_) {}
    return null;
}

function getNmtPid() {
    try {
        if (fs.existsSync(NMT_PID_FILE)) {
            const pid = parseInt(fs.readFileSync(NMT_PID_FILE, 'utf8').trim(), 10);
            if (!isNaN(pid)) {
                try {
                    process.kill(pid, 0);
                    return pid;
                } catch (_) {}
            }
        }
    } catch (_) {}
    return getPidListeningOnPort(NMT_PORT);
}

async function isPortAvailable(port) {
    const net = require('net');
    return new Promise((resolve) => {
        const tester = net.createConnection({ port, host: '127.0.0.1' }, () => {
            tester.end();
            resolve(false); // ポート使用中
        });
        tester.on('error', () => resolve(true)); // ポート空き
        tester.setTimeout(500, () => {
            tester.destroy();
            resolve(true);
        });
    });
}

async function startNmt() {
    const existingPid = getNmtPid();
    if (existingPid) {
        console.log(`NMT は既に稼働中です (PID: ${existingPid})`);
        return;
    }

    const standaloneScript = path.resolve(__dirname, 'services/managementTool/standalone.js');
    const child = spawn(process.execPath, [standaloneScript], {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: 'inherit',
        env: { ...process.env },
    });
    child.unref();

    console.log(`NMT を起動しました (PID: ${child.pid})`);
}

async function stopNmt() {
    const pid = getNmtPid();
    if (!pid) {
        console.log('NMT は停止しています。');
        return;
    }

    try {
        process.kill(pid, 'SIGTERM');
        console.log(`NMT (PID: ${pid}) へ停止シグナルを送信しました。解放を待機中...`);

        // ポート解放を最大 5 秒待機
        for (let i = 0; i < 25; i++) {
            await sleep(200);
            if (await isPortAvailable(NMT_PORT)) {
                console.log('NMT ポートが解放されました。');
                return;
            }
        }

        // 強制終了
        try {
            process.kill(pid, 'SIGKILL');
            console.log(`NMT (PID: ${pid}) を強制終了しました。`);
        } catch (_) {}
    } catch (err) {
        console.warn(`NMT 停止処理注意: ${err.message}`);
    }
}

async function restartNmt() {
    const pid = getNmtPid();
    if (pid) {
        await stopNmt();
        await sleep(500);
    }
    await startNmt();
}

function printNmtStatus() {
    const pid = getNmtPid();
    if (pid) {
        console.log(`NMT: 稼働中 (PID: ${pid}, Port: ${NMT_PORT})`);
    } else {
        console.log('NMT: 停止中');
    }
}

async function main(argv) {
    const [group, command, argument] = argv;
    if (!group || group === '--help' || group === '-h' || group === 'help') {
        printUsage();
        return;
    }

    if (group === 'admin') {
        if (command === 'grant' || command === 'add') {
            await setAdministrator(argument, true);
            return;
        }
        if (command === 'revoke' || command === 'remove') {
            await setAdministrator(argument, false);
            return;
        }
    }

    if (group === 'maintenance') {
        if (command === 'enable' || command === 'on') {
            await enableMaintenanceMode();
            return;
        }
        if (command === 'disable' || command === 'off') {
            writeMaintenanceMode(false);
            console.log('メンテナンスモードを解除しました。');
            return;
        }
        if (command === 'status') {
            console.log(`メンテナンスモード: ${readMaintenanceMode() ? '有効' : '無効'}`);
            return;
        }
    }

    if (group === 'server') {
        if (command === 'start') {
            await startServer();
            return;
        }
        if (command === 'stop') {
            await stopServer();
            return;
        }
        if (command === 'restart') {
            await restartServer();
            return;
        }
        if (command === 'status') {
            const status = await getRunningStatus();
            if (!status) {
                console.log(
                    `停止中`,
                );
                process.exitCode = 1;
                return;
            }
            console.log(formatStatus(status));
            return;
        }
    }

    if (group === 'nmt') {
        if (command === 'start') {
            await startNmt();
            return;
        }
        if (command === 'stop') {
            await stopNmt();
            return;
        }
        if (command === 'restart') {
            await restartNmt();
            return;
        }
        if (command === 'status') {
            printNmtStatus();
            return;
        }
    }

    printUsage();
    process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error) => {
    console.error(`エラー: ${error.message}`);
    process.exitCode = 1;
});
