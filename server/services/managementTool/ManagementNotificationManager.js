'use strict';

const fs = require('fs');
const path = require('path');
const { requestOperatorCommand } = require('../../utils/operatorControl');

const DATA_DIR = path.resolve(__dirname, '../../data');
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'nmt-notifications.json');

class ManagementNotificationManager {
  constructor({ mainPushService = null, realtimeService = null } = {}) {
    this.mainPushService = mainPushService;
    this.realtimeService = realtimeService;
    this.clients = new Map(); // response -> userId
    this.notifications = [];
    this.subscribedUserIds = new Set(); // ユーザーID -> 通知受信許可
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (fs.existsSync(NOTIFICATIONS_FILE)) {
        const raw = fs.readFileSync(NOTIFICATIONS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.notifications = parsed.slice(-200).map((notification) => ({
            ...notification,
            readBy: notification.readBy && typeof notification.readBy === 'object'
              ? notification.readBy
              : {},
          }));
        }
      }
    } catch (_) {
      this.notifications = [];
    }
  }

  _save() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(this.notifications.slice(0, 200), null, 2), 'utf8');
    } catch (_) {}
  }

  subscribeUser(userId) {
    if (userId) this.subscribedUserIds.add(Number(userId));
  }

  unsubscribeUser(userId) {
    if (userId) this.subscribedUserIds.delete(Number(userId));
  }

  isUserSubscribed(userId) {
    return userId ? this.subscribedUserIds.has(Number(userId)) : false;
  }

  /**
   * SSE クライアント登録
   */
  addClient(res, userId = null, lastEventId = '') {
    if (userId) this.subscribeUser(userId);
    this.clients.set(res, userId);
    this.replaySince(res, lastEventId, userId);

    res.on('close', () => {
      this.clients.delete(res);
    });
  }

  _sendSse(res, item) {
    res.write(`id: ${item.id}\ndata: ${JSON.stringify(item)}\n\n`);
  }

  replaySince(res, lastEventId, userId) {
    if (!lastEventId) return;
    const index = this.notifications.findIndex((notification) => notification.id === lastEventId);
    if (index < 0) return;
    for (const notification of this.notifications.slice(0, index).reverse()) {
      this._sendSse(res, this._formatForUser(notification, userId));
    }
  }

  _formatForUser(notification, userId) {
    const readBy = notification.readBy || {};
    return { ...notification, read: Boolean(readBy[String(userId)] || notification.read) };
  }

  /**
   * 全接続管理者に通知をブロードキャスト
   */
  broadcast({ type, title, message, link = null, requestId = null, errorId = null, data = {} }) {
    const item = {
      id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: type || 'info', // 'error' | 'approval_request' | 'security_alert' | 'info'
      title: title || 'NMT Notice',
      message: message || '',
      link,
      requestId,
      errorId,
      data,
      timestamp: new Date().toISOString(),
      read: false,
      readBy: {},
    };

    this.notifications.unshift(item);
    if (this.notifications.length > 200) this.notifications.pop();
    this._save();

    // SSE 送信
    for (const [client, userId] of this.clients) {
      try {
        this._sendSse(client, this._formatForUser(item, userId));
      } catch (_) {
        this.clients.delete(client);
      }
    }

    // Nyaitter 本体のプッシュサービスとの連携
    if (this.mainPushService && typeof this.mainPushService.sendPushToAdmins === 'function') {
      try {
        this.mainPushService.sendPushToAdmins({ title: item.title, body: item.message });
      } catch (_) {}
    } else {
      void requestOperatorCommand({
        action: 'push-admin-notification',
        notification: { title: item.title, body: item.message },
      }, { timeoutMs: 1000 }).catch(() => {});
    }

    return item;
  }

  getNotifications(limit = 50, userId = null) {
    return this.notifications.slice(0, limit).map((notification) => (
      userId == null ? notification : this._formatForUser(notification, userId)
    ));
  }

  markAllAsRead(userId) {
    if (userId == null) return;
    const key = String(userId);
    for (const notification of this.notifications) {
      if (!notification.readBy || typeof notification.readBy !== 'object') notification.readBy = {};
      notification.readBy[key] = true;
    }
    this._save();
  }
}

module.exports = ManagementNotificationManager;
