'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { createDatabaseAdapter } = require('../../adapters');
const ManagementToolServer = require('./ManagementToolServer');

const DATA_DIR = path.resolve(__dirname, '../../data');
const PID_FILE = path.join(DATA_DIR, 'nmt.pid');

function killExistingNmtProcess() {
  if (!fs.existsSync(PID_FILE)) return;
  try {
    const rawPid = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(rawPid, 10);
    if (Number.isInteger(pid) && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        console.log(`[NMT-Standalone] Stopping previous NMT process (PID: ${pid})...`);
        process.kill(pid, 'SIGTERM');
        const start = Date.now();
        while (Date.now() - start < 1000) {
          try {
            process.kill(pid, 0);
          } catch (_) {
            break;
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
}

async function main() {
  killExistingNmtProcess();

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');

  process.on('exit', () => {
    try {
      if (fs.existsSync(PID_FILE)) {
        const storedPid = fs.readFileSync(PID_FILE, 'utf8').trim();
        if (storedPid === String(process.pid)) fs.unlinkSync(PID_FILE);
      }
    } catch (_) {}
  });

  const dbAdapter = createDatabaseAdapter();
  try {
    await dbAdapter.connect();
    console.log('[NMT-Standalone] Database adapter connected.');
  } catch (err) {
    console.warn('[NMT-Standalone] Database connection warning:', err.message);
  }

  const server = new ManagementToolServer({
    config,
    dbAdapter,
  });

  server.start();

  // IPC 親プロセスへの起動完了シグナル通知
  if (typeof process.send === 'function') {
    process.send({ type: 'nmt_ready', pid: process.pid });
  }

  process.on('SIGTERM', () => {
    console.log('[NMT-Standalone] SIGTERM received. Shutting down NMT gracefully.');
    server.stop();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('[NMT-Standalone] SIGINT received. Shutting down NMT gracefully.');
    server.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[NMT-Standalone] Fatal startup error:', err);
  process.exit(1);
});
