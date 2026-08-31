'use strict';

const crypto = require('crypto');

class PostActionQueue {
  constructor({ maxPendingJobs = 1000, concurrency = 5 } = {}) {
    this.maxPendingJobs = maxPendingJobs;
    this.concurrency = Math.max(1, Math.min(concurrency, 20));
    this.queue = [];
    this.head = 0;
    this.activeWorkers = 0;
    this.stopped = false;
  }

  get length() {
    return this.queue.length - this.head;
  }

  enqueue(type, run) {
    if (this.stopped) {
      const error = new Error('Post action queue is unavailable');
      error.statusCode = 503;
      throw error;
    }
    if (typeof run !== 'function') {
      throw new TypeError('Post action must be a function');
    }
    if (this.length >= this.maxPendingJobs) {
      const error = new Error('Post action queue is full');
      error.statusCode = 503;
      throw error;
    }

    const actionId = crypto.randomUUID();
    this.queue.push({ actionId, type: String(type || 'post'), run });
    this._dispatch();
    return actionId;
  }

  stop() {
    this.stopped = true;
    this.queue.length = 0;
    this.head = 0;
  }

  _dispatch() {
    while (!this.stopped && this.activeWorkers < this.concurrency && this.head < this.queue.length) {
      const job = this.queue[this.head];
      this.queue[this.head] = null;
      this.head += 1;

      // Periodic compact to release memory
      if (this.head > 64 && this.head * 2 >= this.queue.length) {
        this.queue = this.queue.slice(this.head);
        this.head = 0;
      }

      if (job) {
        this.activeWorkers += 1;
        this._runJob(job);
      }
    }

    if (this.head >= this.queue.length) {
      this.queue.length = 0;
      this.head = 0;
    }
  }

  async _runJob(job) {
    try {
      await job.run();
    } catch (error) {
      console.error(
        `[post-actions] ${job.type} action=${job.actionId} failed:`,
        error.message,
      );
    } finally {
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      if (!this.stopped && this.head < this.queue.length) {
        this._dispatch();
      }
    }
  }
}

module.exports = PostActionQueue;
