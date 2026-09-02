'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const fs = require('fs');
const config = require('../../config');
const { createDatabaseAdapter } = require('../../adapters');
const ManagementToolServer = require('./ManagementToolServer');

const DATA_DIR = path.resolve(__dirname, '../../data');
const PID_FILE = path.join(DATA_DIR, 'nmt.pid');

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');

  process.on('exit', () => {
    try {
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    } catch (_) {}
  });

  let dbAdapter = null;
  try {
    dbAdapter = createDatabaseAdapter();
    await dbAdapter.connect();
    console.log('[NMT] Database adapter connected.');
  } catch (err) {
    console.warn('[NMT] Database connection warning:', err.message);
  }

  const server = new ManagementToolServer({
    config,
    dbAdapter,
  });

  server.start();

  const shutdown = () => {
    console.log('[NMT] Shutting down NMT gracefully...');
    server.stop();
    try {
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    } catch (_) {}
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[NMT] Fatal startup error:', err);
  process.exit(1);
});
