'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const SOCKET_PATH = process.env.NYAITTER_NMT_EVENT_SOCKET || path.join(os.tmpdir(), 'nyaitter-nmt-events.sock');
const MAX_EVENT_BYTES = 64 * 1024;
let unavailableUntil = 0;

function sendNmtEvent(event) {
  if (!event || Date.now() < unavailableUntil) return false;

  const socket = net.createConnection(SOCKET_PATH);
  let settled = false;
  const markUnavailable = () => {
    if (!settled) unavailableUntil = Date.now() + 1000;
    settled = true;
  };

  socket.setTimeout(500, () => {
    markUnavailable();
    socket.destroy();
  });
  socket.once('connect', () => {
    settled = true;
    socket.end(`${JSON.stringify(event)}\n`);
  });
  socket.once('error', markUnavailable);
  socket.once('close', () => {
    if (!settled) markUnavailable();
  });
  return true;
}

function startNmtEventServer(handler) {
  try {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
  } catch (_) {}

  const server = net.createServer((socket) => {
    let input = '';
    let completed = false;

    const reject = () => {
      if (completed) return;
      completed = true;
      socket.destroy();
    };

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      if (completed) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > MAX_EVENT_BYTES) return reject();

      const newline = input.indexOf('\n');
      if (newline < 0) return;
      completed = true;
      let event;
      try {
        event = JSON.parse(input.slice(0, newline));
      } catch (_) {
        return socket.destroy();
      }
      Promise.resolve(handler(event)).catch(() => {}).finally(() => socket.end());
    });
    socket.on('error', () => {});
  });

  server.listen(SOCKET_PATH, () => {
    try {
      fs.chmodSync(SOCKET_PATH, 0o600);
    } catch (_) {}
  });
  server.on('error', () => {});
  return server;
}

function closeNmtEventServer(server) {
  if (server) server.close();
  try {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
  } catch (_) {}
}

module.exports = {
  SOCKET_PATH,
  sendNmtEvent,
  startNmtEventServer,
  closeNmtEventServer,
};
