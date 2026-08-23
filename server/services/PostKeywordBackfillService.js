'use strict';

const { extractPostKeywords } = require('./PostKeywordService');
const { extractViewContent } = require('../utils/viewContent');

/**
 * 旧投稿に対する主要語生成を、通常の投稿アクションと同じ順次キューで実行する。
 * DB上でtags_generated_atを持つ投稿は、本文が空でも補完済みとして扱う。
 */
class PostKeywordBackfillService {
  constructor({ postActionQueue, maxPendingPosts = 2000 } = {}) {
    if (!postActionQueue || typeof postActionQueue.enqueue !== 'function') {
      throw new TypeError('Post keyword backfill requires a post action queue');
    }
    this.postActionQueue = postActionQueue;
    this.maxPendingPosts = maxPendingPosts;
    this.pendingPostIds = new Set();
    this.stopped = false;
  }

  enqueue(db, post) {
    if (this.stopped || !db || !post || post.tagsGeneratedAt != null || post.tags_generated_at != null) {
      return false;
    }
    const postId = Number(post.id);
    if (!Number.isSafeInteger(postId) || postId <= 0 || this.pendingPostIds.has(postId)) {
      return false;
    }
    if (this.pendingPostIds.size >= this.maxPendingPosts) {
      console.warn('[post-keywords] backfill queue is full; skipping post', postId);
      return false;
    }

    this.pendingPostIds.add(postId);
    try {
      this.postActionQueue.enqueue('post-keyword-backfill', async () => {
        try {
          const currentPost = await db.getPostById(postId);
          if (!currentPost || currentPost.tagsGeneratedAt != null || currentPost.tags_generated_at != null) {
            return;
          }
          const viewContent = extractViewContent(currentPost.content || '');
          const tags = await extractPostKeywords(viewContent);
          await db.updatePost(postId, {
            viewContent,
            view_content: viewContent,
            tags,
            tagsGeneratedAt: new Date().toISOString(),
          });
        } finally {
          this.pendingPostIds.delete(postId);
        }
      });
      return true;
    } catch (error) {
      this.pendingPostIds.delete(postId);
      if (error.statusCode === 503) {
        console.warn('[post-keywords] backfill enqueue skipped:', error.message);
        return false;
      }
      throw error;
    }
  }

  stop() {
    this.stopped = true;
    this.pendingPostIds.clear();
  }
}

module.exports = PostKeywordBackfillService;
