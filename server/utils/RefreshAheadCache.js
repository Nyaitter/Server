'use strict';

/**
 * 値をキャッシュし、期限切れ後も古い値を即返しつつ裏で1回だけ再計算する
 * (stale-while-revalidate) キャッシュ。
 *
 * 重い集計（ランキングや話題）をリクエストの待ち時間から切り離すのが目的。
 * - freshMs 以内: そのまま返す
 * - freshMs 経過後 staleMs 以内: 古い値を即返し、裏で loader を1回だけ実行
 * - staleMs 経過後: loader を待って返す（同時アクセスは single-flight で1回に集約）
 *
 * loader は引数なしの関数、またはキーを受け取る関数。
 */
class RefreshAheadCache {
	constructor({ freshMs = 30000, staleMs = 300000, maxEntries = 1000 } = {}) {
		this.freshMs = Math.max(0, Number(freshMs) || 0);
		this.staleMs = Math.max(this.freshMs, Number(staleMs) || this.freshMs);
		this.maxEntries = Math.max(1, Number(maxEntries) || 1000);
		this.entries = new Map();
	}

	get(key, loader) {
		const now = Date.now();
		const entry = this.entries.get(key);

		if (entry) {
			if (entry.promise) return entry.promise;
			if (entry.staleUntil > now && entry.hasValue) {
				if (entry.freshUntil <= now && !entry.refreshing) {
					this._refresh(key, loader, entry);
				}
				return Promise.resolve(entry.value);
			}
		}

		this._prune(now);
		if (this.entries.size >= this.maxEntries) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey !== undefined) this.entries.delete(oldestKey);
		}

		const promise = Promise.resolve()
			.then(loader)
			.then((value) => {
				if (this.entries.get(key)?.promise === promise) this._set(key, value);
				return value;
			})
			.catch((error) => {
				if (this.entries.get(key)?.promise === promise) this.entries.delete(key);
				throw error;
			});
		this.entries.set(key, { promise });
		return promise;
	}

	_refresh(key, loader, entry) {
		entry.refreshing = true;
		Promise.resolve()
			.then(loader)
			.then((value) => {
				if (this.entries.get(key) === entry) this._set(key, value);
			})
			.catch(() => {
				// 再計算に失敗しても古い値を返し続ける。
				if (this.entries.get(key) === entry) {
					entry.refreshing = false;
					entry.freshUntil = Date.now() + Math.min(this.freshMs, 5000);
				}
			});
	}

	_set(key, value) {
		const now = Date.now();
		this.entries.set(key, {
			value,
			hasValue: true,
			freshUntil: now + this.freshMs,
			staleUntil: now + this.staleMs,
			refreshing: false,
		});
	}

	invalidate(key) {
		this.entries.delete(key);
	}

	clear() {
		this.entries.clear();
	}

	_prune(now) {
		for (const [key, entry] of this.entries) {
			if (!entry.promise && entry.staleUntil <= now) this.entries.delete(key);
		}
	}
}

module.exports = RefreshAheadCache;
