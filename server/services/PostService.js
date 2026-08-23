const { extractViewContent } = require('../utils/viewContent');

class PostService {
  constructor({ dbAdapter, storageAdapter }) {
    this.db = dbAdapter;
    this.storage = storageAdapter;
  }

  /**
   * 新規投稿を作成
   * attachments can be:
   * - raw files: { buffer, fileName, contentType }
   * - or pre-uploaded: { id, url, type, name }
   */
  async createPost({ userId, content, viewContent = null, tags = [], tagsGeneratedAt = null, attachments = [], mask = false, lock = false, announcement = false, groupId = null, groupAnnouncement = false, replyControl = 'everyone', reply_control = 'everyone', replyTo = null, repostTo = null }) {
    const attachmentData = [];
    const uploadedKeys = [];
    const normalizedViewContent = viewContent != null ? String(viewContent) : extractViewContent(content);
    const normalizedReplyControl = String(replyControl || reply_control || 'everyone');

    try {
      for (const att of attachments) {
        // 先に /uploads で所有者検証済みの添付は、IDだけで投稿へ関連付ける。
        // クライアントはURLを保持しないため、ここでURLを必須にすると二重アップロード扱いになって失敗する。
        if (att.id) {
          attachmentData.push({
            id: att.id,
            ...(att.url ? { url: att.url } : {}),
            type: att.type || (att.contentType?.startsWith('image/') ? 'image' : 'file'),
            name: att.name || att.fileName || '添付ファイル',
          });
          continue;
        }

        if (!att.buffer || !this.storage) {
          throw new Error('Invalid attachment or unavailable storage adapter');
        }

        const uploaded = await this.storage.upload({
          file: att.buffer,
          fileName: att.fileName,
          contentType: att.contentType,
          folder: `attachments/${userId}`,
        });
        uploadedKeys.push(uploaded.id);
        attachmentData.push({
          id: uploaded.id,
          url: uploaded.url,
          type: att.contentType?.startsWith('image/') ? 'image' : 'file',
          name: att.fileName,
        });
      }

      return await this.db.createPost({
        userId,
        content,
        viewContent: normalizedViewContent,
        view_content: normalizedViewContent,
        tags,
        tagsGeneratedAt,
        attachments: attachmentData.length > 0 ? attachmentData : null,
        mask,
        lock,
        announcement,
        groupId,
        groupAnnouncement,
        replyControl: normalizedReplyControl,
        reply_control: normalizedReplyControl,
        replyTo,
        repostTo,
      });
    } catch (error) {
		if (this.storage && uploadedKeys.length > 0) {
			try {
				if (typeof this.storage.deleteMany === 'function') {
					await this.storage.deleteMany(uploadedKeys);
				} else if (typeof this.storage.delete === 'function') {
					await Promise.all(uploadedKeys.map((key) => this.storage.delete(key)));
				}
			} catch (cleanupError) {
				console.warn('[PostService] Attachment cleanup failed:', cleanupError.message);
			}
		}
      throw error;
    }
  }

  async getPost(postId) {
    return this.db.getPostById(postId);
  }

  async getPostDetail(postId, currentUserId = null) {
    if (!this.db.getPostDetail) {
      const post = await this.db.getPostById(postId);
      return post;
    }
    return this.db.getPostDetail(postId, currentUserId);
  }

  async toggleLike(userId, postId) {
    if (!this.db.toggleLike) {
      throw new Error('DatabaseAdapter does not support likes yet');
    }

    return this.db.toggleLike(userId, postId);
  }

  async getLikeCount(postId) {
    if (!this.db.getLikeCount) {
      return 0;
    }
    return this.db.getLikeCount(postId);
  }

  async toggleStar(userId, postId) {
    if (!this.db.toggleStar) {
      throw new Error('DatabaseAdapter does not support stars yet');
    }
    return this.db.toggleStar(userId, postId);
  }

  async getStarCount(postId) {
    if (!this.db.getStarCount) return 0;
    return this.db.getStarCount(postId);
  }
}

module.exports = PostService;
