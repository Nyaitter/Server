'use strict';

const crypto = require('crypto');

class PostEventOutbox {
  constructor({ db, handlers = {}, batchSize = 50, intervalMs = 250, concurrency = 4 } = {}) {
    if (!db) throw new TypeError('db is required');
    this.db = db;
    this.handlers = new Map(Object.entries(handlers));
    this.batchSize = Math.max(1, Math.min(Number(batchSize) || 50, 500));
    this.intervalMs = Math.max(50, Number(intervalMs) || 250);
    // 取得件数 (batchSize) と並列度を分離する。全件を同時処理すると
    // 1イベントごとに接続を要求し、PostgreSQL の接続上限を使い切るため。
    this.concurrency = Math.max(1, Math.min(Number(concurrency) || 4, 16));
    this.workerId = crypto.randomUUID();
    this.timer = null;
    this.running = false;
  }

  async _processEvent(event) {
    try {
      const handler = this.handlers.get(event.event_type);
      if (typeof handler !== 'function') {
        throw new Error(`No handler for ${event.event_type}`);
      }
      await handler(event);
      await this.db.completePostEvent(event.id);
    } catch (error) {
      const retryAt = new Date(Date.now() + Math.min(60000, 1000 * (2 ** Math.min(event.attempts, 6))));
      try {
        await this.db.failPostEvent(event.id, error, retryAt);
      } catch (failError) {
        // 失敗記録に失敗してもポーリングを止めない。イベントは processing のまま
        // 残り、ロック期限切れ後に再取得される。
        console.error(`[post-events] failed to record event ${event.id}:`, failError.message);
      }
    }
  }

  async runOnce() {
    if (this.running) return 0;
    this.running = true;
    try {
      const events = await this.db.claimPostEvents(this.batchSize, this.workerId);
      const tails = new Map();
      const queue = [...events];
      const worker = async () => {
        while (queue.length > 0) {
          const event = queue.shift();
          const key = event.post_id == null ? `event:${event.id}` : `post:${event.post_id}`;
          // 同一投稿のイベントは順序を保つため、直前の処理完了を待つ。
          const previous = tails.get(key) || Promise.resolve();
          const current = previous.then(() => this._processEvent(event));
          tails.set(key, current);
          await current;
        }
      };
      const workerCount = Math.min(this.concurrency, queue.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      return events.length;
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => console.error('[post-events] poll failed:', error.message));
    }, this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = PostEventOutbox;
