'use strict';

class MemoryBoundedCache {
  /**
   * @param {Object} options
   * @param {number} [options.maxSize=1000] - 最大エントリ数
   * @param {number} [options.ttlMs=1800000] - 有効期限（ミリ秒、既定30分）
   * @param {number} [options.maxHeapMb=0] - メモリ使用量上限 (MB)。0 の場合は無制限
   */
  constructor({ maxSize = 1000, ttlMs = 1800000, maxHeapMb = 0 } = {}) {
    this.maxSize = Math.max(1, Number(maxSize) || 1000);
    this.ttlMs = Math.max(0, Number(ttlMs) || 1800000);
    this.maxHeapMb = Math.max(0, Number(maxHeapMb) || 0);
    this.cache = new Map();
  }

  get(key) {
    if (key == null) return null;
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (this.ttlMs > 0 && entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }

    // LRU: 最新アクセスのため再挿入
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (key == null || value == null) return;

    // メモリ制限チェック
    this._enforceMemoryLimits();

    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // LRU: 一番古いキー（Map の最初の要素）を削除
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      value,
      expiresAt: this.ttlMs > 0 ? Date.now() + this.ttlMs : Infinity,
    });
  }

  delete(key) {
    if (key == null) return false;
    return this.cache.delete(key);
  }

  updateWhere(predicate, updater) {
    if (typeof predicate !== 'function' || typeof updater !== 'function') return 0;
    const updates = [];
    for (const [key, entry] of this.cache) {
      if (this.ttlMs > 0 && entry.expiresAt <= Date.now()) {
        this.cache.delete(key);
        continue;
      }
      if (!predicate(entry.value, key)) continue;
      const value = updater(entry.value, key);
      if (value !== undefined && value !== null) {
        updates.push([key, value]);
      }
    }
    for (const [key, value] of updates) this.set(key, value);
    return updates.length;
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }

  _enforceMemoryLimits() {
    if (this.maxHeapMb <= 0 || this.cache.size === 0) return;

    try {
      const heapUsedMb = process.memoryUsage().heapUsed / (1024 * 1024);
      if (heapUsedMb >= this.maxHeapMb) {
        // メモリ上限を超過している場合、古い順にキャッシュの半分をパージ
        const trimCount = Math.max(1, Math.floor(this.cache.size / 2));
        let count = 0;
        for (const k of this.cache.keys()) {
          this.cache.delete(k);
          count += 1;
          if (count >= trimCount) break;
        }
      }
    } catch (_) {}
  }
}

module.exports = MemoryBoundedCache;
