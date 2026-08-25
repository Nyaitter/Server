'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../../data');
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'nmt-notifications.json');

class ManagementNotificationManager {
  constructor({ mainPushService = null, realtimeService = null } = {}) {
    this.mainPushService = mainPushService;
    this.realtimeService = realtimeService;
    this.clients = new Set(); // SSE response connections
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
        if (Array.isArray(parsed)) this.notifications = parsed.slice(-200);
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
  addClient(res, userId = null) {
    if (userId) this.subscribeUser(userId);
    this.clients.add(res);

    res.on('close', () => {
      this.clients.delete(res);
    });
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
    };

    this.notifications.unshift(item);
    if (this.notifications.length > 200) this.notifications.pop();
    this._save();

    // SSE 送信
    const sseData = `data: ${JSON.stringify(item)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(sseData);
      } catch (_) {
        this.clients.delete(client);
      }
    }

    // Nyaitter 本体のプッシュサービスとの連携（もしあれば）
    if (this.mainPushService && typeof this.mainPushService.sendPushToAdmins === 'function') {
      try {
        this.mainPushService.sendPushToAdmins({ title: item.title, body: item.message });
      } catch (_) {}
    }

    return item;
  }

  getNotifications(limit = 50) {
    return this.notifications.slice(0, limit);
  }

  markAllAsRead() {
    for (const n of this.notifications) n.read = true;
    this._save();
  }
}

module.exports = ManagementNotificationManager;
