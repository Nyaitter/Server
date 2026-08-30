'use strict';

const crypto = require('crypto');

class PostEventOutbox {
  constructor({ db, handlers = {}, batchSize = 50, intervalMs = 250 } = {}) {
    if (!db) throw new TypeError('db is required');
    this.db = db;
    this.handlers = new Map(Object.entries(handlers));
    this.batchSize = Math.max(1, Math.min(Number(batchSize) || 50, 500));
    this.intervalMs = Math.max(50, Number(intervalMs) || 250);
    this.workerId = crypto.randomUUID();
    this.timer = null;
    this.running = false;
  }

  async runOnce() {
    if (this.running) return 0;
    this.running = true;
    try {
      const events = await this.db.claimPostEvents(this.batchSize, this.workerId);
      const tails = new Map();
      const processEvent = async (event) => {
        const handler = this.handlers.get(event.event_type);
        if (typeof handler !== 'function') {
          await this.db.failPostEvent(event.id, new Error(`No handler for ${event.event_type}`));
          return;
        }
        try {
          await handler(event);
          await this.db.completePostEvent(event.id);
        } catch (error) {
          const retryAt = new Date(Date.now() + Math.min(60000, 1000 * (2 ** Math.min(event.attempts, 6))));
          await this.db.failPostEvent(event.id, error, retryAt);
        }
      };
      await Promise.all(events.map((event) => {
        const key = event.post_id == null ? `event:${event.id}` : `post:${event.post_id}`;
        const previous = tails.get(key) || Promise.resolve();
        const current = previous.then(() => processEvent(event));
        tails.set(key, current.catch(() => {}));
        return current;
      }));
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
