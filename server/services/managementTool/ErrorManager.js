'use strict';

const fs = require('fs');
const path = require('path');

const MAX_ERROR_RECORDS = 500;
const DATA_DIR = path.resolve(__dirname, '../../data');
const ERRORS_FILE = path.join(DATA_DIR, 'nmt-errors.json');

class ErrorManager {
  constructor() {
    this.errors = [];
    this.logHub = null;
    this._load();
  }

  setLogHub(logHub) {
    this.logHub = logHub;
  }

  _load() {
    try {
      if (fs.existsSync(ERRORS_FILE)) {
        const raw = fs.readFileSync(ERRORS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.errors = parsed.slice(0, MAX_ERROR_RECORDS);
        }
      }
    } catch (_) {
      this.errors = [];
    }
  }

  _save() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(ERRORS_FILE, JSON.stringify(this.errors, null, 2), 'utf8');
    } catch (_) {}
  }

  static recordExternalError(err, context = {}) {
    if (!err) return null;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      let list = [];
      if (fs.existsSync(ERRORS_FILE)) {
        try {
          const raw = fs.readFileSync(ERRORS_FILE, 'utf8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) list = parsed;
        } catch (_) {}
      }

      const message = typeof err === 'string' ? err : err.message || 'Unknown Error';
      const stack = typeof err === 'object' && err.stack ? err.stack : '';
      const name = typeof err === 'object' && err.name ? err.name : 'Error';
      const source = context.source || 'server';
      const now = new Date().toISOString();

      const existing = list.find((e) => (
        e.status === 'open' &&
        e.message === message &&
        e.source === source &&
        Date.now() - new Date(e.lastOccurredAt || e.timestamp).getTime() < 60000
      ));

      if (existing) {
        existing.count = (existing.count || 1) + 1;
        existing.lastOccurredAt = now;
        existing.context = { ...existing.context, ...context };
      } else {
        const item = {
          id: `err_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name,
          message,
          stack,
          source,
          context,
          count: 1,
          status: 'open',
          timestamp: now,
          lastOccurredAt: now,
        };
        list.unshift(item);
      }

      if (list.length > MAX_ERROR_RECORDS) {
        list = list.slice(0, MAX_ERROR_RECORDS);
      }
      fs.writeFileSync(ERRORS_FILE, JSON.stringify(list, null, 2), 'utf8');
    } catch (_) {}
  }

  recordError(err, context = {}) {
    if (!err) return null;

    const message = typeof err === 'string' ? err : err.message || 'Unknown Error';
    const stack = typeof err === 'object' && err.stack ? err.stack : '';
    const name = typeof err === 'object' && err.name ? err.name : 'Error';
    const source = context.source || 'server';
    const now = new Date().toISOString();

    const existing = this.errors.find((e) => (
      e.status === 'open' &&
      e.message === message &&
      e.source === source &&
      Date.now() - new Date(e.lastOccurredAt || e.timestamp).getTime() < 60000
    ));

    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.lastOccurredAt = now;
      existing.context = { ...existing.context, ...context };
      this._save();
      return existing;
    }

    const errorItem = {
      id: `err_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      message,
      stack,
      source,
      context,
      count: 1,
      status: 'open',
      timestamp: now,
      lastOccurredAt: now,
    };

    this.errors.unshift(errorItem);
    if (this.errors.length > MAX_ERROR_RECORDS) {
      this.errors = this.errors.slice(0, MAX_ERROR_RECORDS);
    }
    this._save();

    if (this.logHub && typeof this.logHub.addLog === 'function') {
      this.logHub.addLog({
        type: 'error',
        level: 'error',
        message: `[Error] ${message}${context.url ? ` (${context.method || 'GET'} ${context.url})` : ''}`,
        source,
        details: { stack, context },
      });
    }

    return errorItem;
  }

  getErrors({ status = 'all', search = '', limit = 100, offset = 0 } = {}) {
    this._load();
    let list = this.errors;
    if (status && status !== 'all') {
      list = list.filter((e) => e.status === status);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((e) => (
        (e.message && e.message.toLowerCase().includes(q)) ||
        (e.source && e.source.toLowerCase().includes(q)) ||
        (e.name && e.name.toLowerCase().includes(q))
      ));
    }

    const total = list.length;
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
    const paginated = list.slice(safeOffset, safeOffset + safeLimit);

    return {
      errors: paginated,
      total,
      openCount: this.errors.filter((e) => e.status === 'open').length,
    };
  }

  getErrorById(id) {
    this._load();
    return this.errors.find((e) => e.id === id) || null;
  }

  updateErrorStatus(id, status) {
    this._load();
    const error = this.errors.find((e) => e.id === id);
    if (!error) return null;
    if (['open', 'resolved', 'ignored'].includes(status)) {
      error.status = status;
      this._save();
    }
    return error;
  }

  clearErrors() {
    this.errors = [];
    this._save();
    return true;
  }
}

module.exports = ErrorManager;
