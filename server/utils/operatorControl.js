'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { writeSnapshot, readSnapshot } = require('../services/DataMigrationService');

const MAX_COMMAND_BYTES = 8 * 1024;

function getOperatorSocketPath() {
  if (process.env.NYAITTER_OPERATOR_SOCKET) {
    return process.env.NYAITTER_OPERATOR_SOCKET;
  }

  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\nyaitter-operator';
  }

  return path.join(os.tmpdir(), 'nyaitter-operator.sock');
}

function parseUserId(value) {
  const normalized = String(value ?? '').replace(/^#/, '');
  const userId = Number(normalized);
  if (!Number.isSafeInteger(userId) || userId < 0) return null;
  return userId;
}

function writeResponse(socket, payload) {
  socket.end(`${JSON.stringify(payload)}\n`);
}

function createCommandHandler({ dbAdapter, shutdown, getStatus, managers = {} }) {
  return async (command) => {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      return { ok: false, error: 'Invalid operator command' };
    }

    // ── ステータス ──────────────────────────────────────────────────────────
    if (command.action === 'status' || command.action === 'get-server-status') {
      return { ok: true, status: getStatus() };
    }

    // ── ユーザー / 管理者 ──────────────────────────────────────────────────
    if (command.action === 'get-admins') {
      try {
        let admins = [];
        if (typeof dbAdapter.getAllUsers === 'function') {
          const users = await dbAdapter.getAllUsers();
          admins = users.filter((u) => u.admin === true || u.is_admin === true);
        } else if (typeof dbAdapter.searchUsers === 'function') {
          const users = await dbAdapter.searchUsers({ query: '', limit: 1000 });
          admins = users.filter((u) => u.admin === true || u.is_admin === true);
        }
        return { ok: true, admins };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    if (command.action === 'search-users') {
      try {
        const q = String(command.query || '').trim();
        const limit = Number(command.limit) || 20;
        let users = [];

        const numId = Number(q.replace(/^#/, ''));
        if (Number.isInteger(numId) && numId > 0) {
          const user = await dbAdapter.getUserById(numId);
          if (user) users = [user];
        } else if (typeof dbAdapter.getUserByScid === 'function') {
          const user = await dbAdapter.getUserByScid(q);
          if (user) users = [user];
        }

        if (users.length === 0 && typeof dbAdapter.searchUsers === 'function') {
          users = await dbAdapter.searchUsers({ query: q, limit });
        }

        return { ok: true, users };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    if (command.action === 'get-user') {
      try {
        const userId = parseUserId(command.userId);
        if (userId == null) return { ok: false, error: 'Invalid userId' };
        const user = await dbAdapter.getUserById(userId);
        return { ok: true, user: user || null };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    if (command.action === 'set-admin') {
      const userId = parseUserId(command.userId);
      if (userId == null || typeof command.admin !== 'boolean') {
        return { ok: false, error: 'set-admin requires a valid userId and boolean admin value' };
      }
      const existing = await dbAdapter.getUserById(userId);
      if (!existing) return { ok: false, error: `User #${userId} was not found` };

      const updated = await dbAdapter.updateUserProfile(userId, { admin: command.admin });
      if (!updated) return { ok: false, error: `Unable to update user #${userId}` };
      return {
        ok: true,
        user: {
          id: Number(updated.id),
          admin: updated.admin === true,
        },
      };
    }

    // ── エラー管理 ─────────────────────────────────────────────────────────
    if (command.action === 'get-errors') {
      if (!managers.errorManager) return { ok: false, error: 'ErrorManager not available' };
      try {
        const errors = managers.errorManager.getErrors(command.filters || {});
        return { ok: true, errors };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    if (command.action === 'update-error-status') {
      if (!managers.errorManager) return { ok: false, error: 'ErrorManager not available' };
      try {
        const updated = managers.errorManager.updateStatus(command.errorId, command.status);
        if (!updated) return { ok: false, error: 'Error not found' };
        return { ok: true, error: updated };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    // ── セキュリティ ───────────────────────────────────────────────────────
    if (command.action === 'get-security-events') {
      if (!managers.securityManager) return { ok: false, error: 'SecurityManager not available' };
      try {
        const result = managers.securityManager.getSecurityEvents(command.filters || {});
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    if (command.action === 'get-access-logs') {
      if (!managers.securityManager) return { ok: false, error: 'SecurityManager not available' };
      try {
        const logs = managers.securityManager.getRecentAccessLogs(command.filters || {});
        return { ok: true, logs: Array.isArray(logs) ? logs : logs?.logs || [] };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    // ── 通知 / 承認 ────────────────────────────────────────────────────────
    if (command.action === 'get-notifications') {
      if (!managers.notificationManager) return { ok: false, error: 'NotificationManager not available' };
      try {
        const notifications = managers.notificationManager.getNotifications(command.limit || 50);
        return { ok: true, notifications };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    if (command.action === 'get-approvals') {
      if (!managers.approvalManager) return { ok: false, error: 'ApprovalManager not available' };
      try {
        const requests = managers.approvalManager.getPendingRequests
          ? managers.approvalManager.getPendingRequests()
          : [];
        return { ok: true, requests };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    if (command.action === 'approve-request') {
      if (!managers.approvalManager) return { ok: false, error: 'ApprovalManager not available' };
      try {
        const result = managers.approvalManager.approveRequest(command.requestId, command.user);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    if (command.action === 'deny-request') {
      if (!managers.approvalManager) return { ok: false, error: 'ApprovalManager not available' };
      try {
        const result = managers.approvalManager.denyRequest(command.requestId, command.user);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    // ── 監査ログ ───────────────────────────────────────────────────────────
    if (command.action === 'get-audit-logs') {
      if (!managers.adminAuditFn) return { ok: false, error: 'Audit log provider not available' };
      try {
        const logs = managers.adminAuditFn();
        return { ok: true, logs };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    // ── ログ転送（NyaitterServer → NMT） ──────────────────────────────────────
    if (command.action === 'push-log') {
      if (!managers.logHub) return { ok: false, error: 'LogHub not available' };
      try {
        managers.logHub.addLog(command.log);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    if (command.action === 'push-admin-notification') {
      if (!managers.pushNotificationService) return { ok: false, error: 'Push service not available' };
      const notification = command.notification || {};
      try {
        const users = typeof dbAdapter.getAllUsers === 'function' ? await dbAdapter.getAllUsers() : [];
        const admins = users.filter((user) => user.admin === true || user.is_admin === true);
        await Promise.all(admins.map((user) => managers.pushNotificationService.sendNotificationToUser(
          user.id,
          notification,
        )));
        return { ok: true, count: admins.length };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    // ── データ操作 ─────────────────────────────────────────────────────────
    if (command.action === 'export-data') {
      const filePath = typeof command.filePath === 'string' ? command.filePath : '';
      if (!filePath) return { ok: false, error: 'export-data requires filePath' };
      const snapshot = await dbAdapter.exportDataSnapshot();
      const savedPath = await writeSnapshot(filePath, snapshot);
      return { ok: true, filePath: savedPath };
    }

    if (command.action === 'import-data') {
      const filePath = typeof command.filePath === 'string' ? command.filePath : '';
      if (!filePath || command.replace !== true) {
        return { ok: false, error: 'import-data requires filePath and replace=true' };
      }
      const snapshot = await readSnapshot(filePath);
      const counts = await dbAdapter.importDataSnapshot(snapshot, { replace: true });
      return { ok: true, counts };
    }

    if (command.action === 'shutdown') {
      setImmediate(() => shutdown('operator-cli'));
      return { ok: true, stopping: true };
    }

    return { ok: false, error: `Unsupported operator action: ${String(command.action)}` };
  };
}

async function removeStaleSocket(socketPath) {
  if (process.platform === 'win32') {
    return;
  }

  try {
    await fs.promises.unlink(socketPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function startOperatorControlServer({ dbAdapter, shutdown, getStatus, managers = {} }) {
  const socketPath = getOperatorSocketPath();
  await removeStaleSocket(socketPath);
  const handleCommand = createCommandHandler({ dbAdapter, shutdown, getStatus, managers });

  // クライアントは要求送信後に書込み側だけを閉じる。非同期操作の完了応答を返すため半閉接続を許可する。
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding('utf8');
    let input = '';
    let completed = false;

    const fail = (error) => {
      if (completed) return;
      completed = true;
      writeResponse(socket, { ok: false, error });
    };

    socket.on('data', (chunk) => {
      if (completed) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > MAX_COMMAND_BYTES) {
        fail('Operator command is too large');
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      completed = true;
      let command;
      try {
        command = JSON.parse(input.slice(0, newline));
      } catch (_) {
        writeResponse(socket, { ok: false, error: 'Operator command must be JSON' });
        return;
      }
      Promise.resolve(handleCommand(command))
        .then((response) => writeResponse(socket, response))
        .catch((error) => {
          console.error('[operator-control] Command failed:', error);
          writeResponse(socket, { ok: false, error: 'Operator command failed' });
        });
    });

    socket.on('error', () => {});
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path: socketPath, readableAll: false, writableAll: false }, () => {
      server.off('error', reject);
      resolve();
    });
  });

  if (process.platform !== 'win32') {
    await fs.promises.chmod(socketPath, 0o600);
  }

  return {
    socketPath,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      await removeStaleSocket(socketPath);
    },
  };
}

function requestOperatorCommand(command, { timeoutMs = 3000, socketPath = getOperatorSocketPath() } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Operator command timed out'));
    }, timeoutMs);

    const finish = (callback) => (value) => {
      clearTimeout(timeout);
      callback(value);
    };

    socket.setEncoding('utf8');
    socket.once('error', finish(reject));
    socket.on('data', (chunk) => { response += chunk; });
    socket.once('end', finish(() => {
      try {
        const payload = JSON.parse(response.trim());
        resolve(payload);
      } catch (_) {
        reject(new Error('Invalid response from operator control socket'));
      }
    }));
    socket.once('connect', () => socket.end(`${JSON.stringify(command)}\n`));
  });
}

module.exports = {
  getOperatorSocketPath,
  parseUserId,
  requestOperatorCommand,
  startOperatorControlServer,
};
