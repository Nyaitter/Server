'use strict';

class TtlValueCache {
	constructor({ ttlMs = 30000, maxEntries = 1000 } = {}) {
		this.ttlMs = ttlMs;
		this.maxEntries = Math.max(1, maxEntries);
		this.entries = new Map();
	}

	get(key, loader) {
		const entry = this.entries.get(key);
		if (entry) {
			if (entry.promise) return entry.promise;
			if (entry.expiresAt > Date.now()) return entry.value;
			this.entries.delete(key);
		}

		this.prune();
		if (this.entries.size >= this.maxEntries) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey !== undefined) this.entries.delete(oldestKey);
		}

		const promise = Promise.resolve()
			.then(loader)
			.then((value) => {
				if (this.entries.get(key)?.promise === promise) {
					this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
				}
				return value;
			})
			.catch((error) => {
				if (this.entries.get(key)?.promise === promise) this.entries.delete(key);
				throw error;
			});
		this.entries.set(key, { promise });
		return promise;
	}

	prune() {
		const now = Date.now();
		for (const [key, entry] of this.entries) {
			if (!entry.promise && entry.expiresAt <= now) this.entries.delete(key);
		}
	}

	clear() {
		this.entries.clear();
	}
}

module.exports = TtlValueCache;
