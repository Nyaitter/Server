'use strict';

const { encodePostCursor } = require('./postCursor');

/**
 * High-performance Timeline ID Cache Manager.
 * 
 * Design Principles:
 * 1. O(1) post ingestion using Array.prototype.push() instead of unshift().
 *    Posts are appended chronologically and returned in reverse (newest first).
 * 2. Strict per-tab and per-viewer timeline mapping so new posts appear instantly
 *    on relevant timelines (all, foryou, following, groups) without stale reads.
 * 3. Bounded memory with LRU cleanup and TTL support.
 */

class TimelineCacheManager {
	constructor(options = {}) {
		this.ttlMs = options.ttlMs ?? 600000;
		this.maxEntries = options.maxEntries ?? 300;
		this.maxTimelineSize = options.maxTimelineSize ?? 60;
		// Map<string, { idsAsc: number[], idsSet: Set<number>, postsById: Map, has_more: boolean, next_cursor: string|null, expiresAt: number }>
		this.cache = new Map();
	}

	getIds(key) {
		const entry = this.cache.get(key);
		if (!entry) return null;

		if (entry.expiresAt <= Date.now()) {
			this.cache.delete(key);
			return null;
		}
		this.cache.delete(key);
		this.cache.set(key, entry);

		// Return copy of IDs in descending order (newest first)
		const idsDesc = [];
		const len = entry.idsAsc.length;
		for (let i = len - 1; i >= 0; i--) {
			idsDesc.push(entry.idsAsc[i]);
		}

		return {
			ids: idsDesc,
			posts: entry.postsById
				? idsDesc.map((id) => entry.postsById.get(id)).filter(Boolean)
				: undefined,
			has_more: entry.has_more,
			next_cursor: entry.next_cursor || null,
		};
	}

	/**
	 * Stores timeline IDs in internal ascending order (chronological) to allow
	 * efficient push() for new incoming posts.
	 */
	setIds(key, { ids = [], posts = [], has_more = false, next_cursor = null }, customTtlMs = null) {
		if (!Array.isArray(ids)) return;

		// Input IDs from DB are in descending order (newest first).
		// We store them internally in ascending order (oldest first) so that new posts can be push()ed to the end!
		const idsAsc = [];
		for (let i = ids.length - 1; i >= 0; i--) {
			const id = Number(ids[i]);
			if (Number.isInteger(id) && id > 0) {
				idsAsc.push(id);
			}
		}
		const postsById = new Map((Array.isArray(posts) ? posts : [])
			.filter((post) => post && Number.isInteger(Number(post.id)))
			.map((post) => [Number(post.id), post]));

		// Enforce LRU cap
		if (this.cache.size >= this.maxEntries) {
			const oldestKey = this.cache.keys().next().value;
			if (oldestKey) this.cache.delete(oldestKey);
		}

		const ttl = customTtlMs ?? this.ttlMs;
		this.cache.set(key, {
			idsAsc,
			idsSet: new Set(idsAsc),
			postsById,
			has_more: Boolean(has_more),
			next_cursor: next_cursor == null || next_cursor === '' ? null : String(next_cursor),
			expiresAt: Date.now() + ttl,
		});
	}

	_appendPost(entry, postId, post, maxSize = this.maxTimelineSize) {
		if (entry.idsSet.has(postId)) return false;
		entry.idsAsc.push(postId);
		entry.idsSet.add(postId);
		entry.postsById?.set(postId, post);
		if (entry.idsAsc.length > maxSize) {
			const removed = entry.idsAsc.splice(0, entry.idsAsc.length - maxSize);
			for (const id of removed) {
				entry.idsSet.delete(id);
				entry.postsById?.delete(id);
			}
			entry.has_more = true;
		}
		const boundaryPost = entry.postsById?.get(entry.idsAsc[0]);
		entry.next_cursor = boundaryPost
			? (encodePostCursor(boundaryPost) || String(entry.idsAsc[0]))
			: String(entry.idsAsc[0] || '');
		return true;
	}

	updatePost(post) {
		if (!post || post.id == null) return;
		const postId = Number(post.id);
		if (!Number.isInteger(postId) || postId <= 0) return;
		for (const entry of this.cache.values()) {
			const cached = entry.postsById?.get(postId);
			if (cached) entry.postsById.set(postId, { ...cached, ...post });
		}
	}

	updatePostMetrics(postId, metrics = {}) {
		const normalizedId = Number(postId);
		if (!Number.isInteger(normalizedId) || normalizedId <= 0) return;
		for (const entry of this.cache.values()) {
			const cached = entry.postsById?.get(normalizedId);
			if (cached) entry.postsById.set(normalizedId, { ...cached, ...metrics });
		}
	}

	/**
	 * Appends new post ID to top-page timeline caches using push() - O(1) complexity.
	 */
	onPostCreated(post) {
		if (!post || !post.id) return;
		const postId = Number(post.id);
		const postAuthorId = Number(post.userId ?? post.user_id);
		const groupId = post.groupId ?? post.group_id ?? null;
		const isReply = Boolean(post.replyTo ?? post.reply_to);
		const now = Date.now();

		const replyTargetId = Number(post.replyTo ?? post.reply_to);
		if (isReply && Number.isInteger(replyTargetId) && replyTargetId > 0) {
			let targetCount = null;
			for (const entry of this.cache.values()) {
				const cachedParent = entry.postsById?.get(replyTargetId);
				if (cachedParent) {
					targetCount = (Number(cachedParent.reply_count ?? cachedParent.replyCount) || 0) + 1;
					break;
				}
			}
			if (targetCount !== null) {
				for (const entry of this.cache.values()) {
					const cachedParent = entry.postsById?.get(replyTargetId);
					if (cachedParent) {
						entry.postsById.set(replyTargetId, {
							...cachedParent,
							reply_count: targetCount,
							replyCount: targetCount,
						});
					}
				}
			}
		}

		for (const [key, entry] of this.cache.entries()) {
			if (entry.expiresAt <= now) {
				this.cache.delete(key);
				continue;
			}

			// Only the first page receives live updates.
			const pageKey = key.match(/:(\d+):(\d+):(\d+):([^:]*)$/);
			if (!pageKey || Number(pageKey[2]) !== 0 || Number(pageKey[3]) !== 0 || pageKey[4]) continue;
			const pageLimit = Math.max(1, Number(pageKey[1]) || this.maxTimelineSize);

			const parts = key.split(':');
			const mode = parts[0];
			const tab = parts[1];
			const viewerId = Number(parts[3]) || 0;

			// If it's a search query cache, invalidate it
			if (parts[2] && parts[2].length > 0) {
				this.cache.delete(key);
				continue;
			}

			if (mode === 'timeline') {
				// Replies only show if viewing replies or thread
				if (isReply) {
					continue;
				}

				if (groupId) {
					// Group post: only update matching group caches or invalidate
					if (tab === `group:${groupId}`) {
						this._appendPost(entry, postId, post, pageLimit);
					}
					continue;
				}

				// Public post
				if (tab === 'all' || tab === 'foryou') {
					this._appendPost(entry, postId, post, pageLimit);
				} else if (tab === 'following') {
					// If author matches viewer
					if (viewerId === postAuthorId) {
						this._appendPost(entry, postId, post);
					} else {
						// For other viewers' following tabs, invalidate so next fetch queries DB
						this.cache.delete(key);
					}
				}
			} else if (mode === 'recommended') {
				if (!isReply && !groupId) {
					this._appendPost(entry, postId, post);
				}
			}
		}
	}

	/**
	 * Removes deleted post ID from timeline caches.
	 */
	onPostDeleted(postId) {
		const pId = Number(postId);
		const now = Date.now();

		for (const [key, entry] of this.cache.entries()) {
			if (entry.expiresAt <= now) {
				this.cache.delete(key);
				continue;
			}
			const idx = entry.idsAsc.indexOf(pId);
			if (idx !== -1) {
				entry.idsAsc.splice(idx, 1);
				entry.idsSet.delete(pId);
			}
			entry.postsById?.delete(pId);
		}
	}

	invalidatePost(postId) {
		const pId = Number(postId);
		if (!Number.isInteger(pId) || pId <= 0) return;
		for (const [key, entry] of this.cache) {
			if (entry.idsAsc.includes(pId)) this.cache.delete(key);
		}
	}

	/**
	 * Invalidate all cached timeline keys.
	 */
	clear() {
		this.cache.clear();
	}
}

const timelineCacheManager = new TimelineCacheManager({
	ttlMs: 600000,
	maxEntries: 500,
	maxTimelineSize: 100,
});

module.exports = timelineCacheManager;
