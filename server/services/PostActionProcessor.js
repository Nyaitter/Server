'use strict';

const PostService = require('./PostService');
const { extractPostKeywords } = require('./PostKeywordService');
const { extractViewContent } = require('../utils/viewContent');
const {
  serializeNotification,
} = require('../utils/serialize');
const timelineCacheManager = require('../utils/TimelineCacheManager');
const {
  isOwnedAttachmentKey,
  normalizeContentType,
} = require('../adapters/storage/safeStoragePath');
const {
  canViewPost,
} = require('../utils/postVisibility');
const {
  createNotificationIfAllowed,
} = require('./NotificationDeliveryService');
const {
  resolvePostingUser,
  assertPostingUserWritable,
} = require('./auth/PostAsUserService');
const {
  normalizeGroupId,
  requireGroupPermission,
  listActiveGroupMemberIds,
} = require('./GroupService');

const idempotencyCache = new Map();
const recentUserPostSignatures = new Map();

function pruneIdempotencyCache(now = Date.now()) {
  for (const [key, entry] of idempotencyCache) {
    if (!entry || now - entry.createdAt > 60000) idempotencyCache.delete(key);
  }
  for (const [userId, entry] of recentUserPostSignatures) {
    if (!entry || now - entry.createdAt > 5000) recentUserPostSignatures.delete(userId);
  }
}

const idempotencyPruner = setInterval(pruneIdempotencyCache, 30000);
idempotencyPruner.unref();

function decodeBase64File(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    throw new Error('Invalid base64 file data');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('Invalid base64 file data');
  }
  return Buffer.from(value, 'base64');
}

function isValidAttachmentUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return true;
  if (value.startsWith('/')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch (_) {
    return false;
  }
}

function validateAttachmentReferences(attachments, userId) {
  if (!Array.isArray(attachments)) {
    throw new Error('attachments must be an array');
  }

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') {
      throw new Error('Invalid attachment');
    }
    if (attachment.data !== undefined) {
      normalizeContentType(attachment.contentType);
      decodeBase64File(attachment.data);
      continue;
    }
    if (typeof attachment.id !== 'string' || !isOwnedAttachmentKey(attachment.id, userId)) {
      throw new Error('Attachment does not belong to the current user');
    }
    if (attachment.url !== undefined && !isValidAttachmentUrl(attachment.url)) {
      throw new Error('Invalid attachment URL');
    }
  }
}

function getAttachmentStorageKeys(attachments) {
  let parsed = attachments;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (_) {
      parsed = null;
    }
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed
    .map((attachment) => attachment && (attachment.id || attachment.key || null))
    .filter((key) => typeof key === 'string' && key.length > 0))];
}

async function deleteStoredAttachments(storage, attachments, context) {
  const keys = getAttachmentStorageKeys(attachments);
  if (keys.length === 0 || !storage) return;
  try {
    if (typeof storage.deleteMany === 'function') {
      await storage.deleteMany(keys);
    } else if (typeof storage.delete === 'function') {
      await Promise.all(keys.map((key) => storage.delete(key)));
    }
  } catch (error) {
    console.warn(
      `[post-actions] Failed to delete ${keys.length} attachment(s) during ${context}:`,
      error.message,
    );
  }
}

async function publishNewNotification(context, userId, notification) {
  const structuredNotification = await serializeNotification(
    context.db,
    notification,
    context.publicUrl,
  );
  if (!structuredNotification) return;

  if (context.realtime) {
    try {
      await context.realtime.publishNewNotification(
        userId,
        structuredNotification,
        context.db,
      );
    } catch (error) {
      console.warn('[post-actions] notification realtime delivery failed:', error.message);
    }
  }

  if (context.pushService?.enabled) {
    void context.pushService.sendNotificationToUser(userId, structuredNotification, {
      publicUrl: context.publicUrl,
    }).catch((error) => {
      console.warn('[post-actions] notification push delivery failed:', error.message);
    });
  }
}

async function notifyPostAction(context, { userId, type, fromUserId, postId }) {
  if (Number(userId) === Number(fromUserId)) return;
  const notification = await createNotificationIfAllowed(context.db, {
    userId: Number(userId),
    type,
    fromUserId: Number(fromUserId),
    target: { kind: 'post', id: Number(postId) },
  });
  if (notification) await publishNewNotification(context, Number(userId), notification);
}

async function publishNewTimelinePost(context, post) {
  if (!post || post.groupId || post.group_id || post.replyTo != null || post.reply_to != null) return;
  if (!context.realtime?.publishPostToFollowers) return;
  try {
    await context.realtime.publishPostToFollowers(post.userId, context.db, post);
  } catch (error) {
    console.warn('[post-actions] timeline realtime delivery failed:', error.message);
  }
}

function enqueueGeminiModeration(context, post) {
  const service = context.autoModerationService;
  if (!service?.enabled || !post || post.groupId || post.group_id) return;
  try {
    service.enqueue(post);
  } catch (error) {
    console.warn('[post-actions] Gemini moderation enqueue failed:', error.message);
  }
}

function normalizeTargetPostId(value) {
  const postId = Number(value);
  return Number.isInteger(postId) && postId > 0 ? postId : null;
}

async function notifyGroupAnnouncement(context, group, post) {
  const memberIds = await listActiveGroupMemberIds(context.db, group.id);
  for (const memberId of memberIds) {
    if (Number(memberId) === Number(post.userId)) continue;
    const notification = await createNotificationIfAllowed(context.db, {
      userId: memberId,
      type: 'group_announcement',
      fromUserId: post.userId,
      target: { kind: 'post', id: Number(post.id) },
      message: `「${group.name}」のグループアナウンスが投稿されました。`,
    });
    if (notification) await publishNewNotification(context, memberId, notification);
  }
}

async function processCreatePostAction(context, payload) {
  const postingUser = assertPostingUserWritable(
    await resolvePostingUser(context.authRequest, context.db, payload.postAsUserId),
  );
  const userId = Number(postingUser.id);
  const content = typeof payload.content === 'string' ? payload.content.trim() : '';
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const replyTo = normalizeTargetPostId(payload.replyTo);
  const repostTo = normalizeTargetPostId(payload.repostTo);
  const isAnnouncement = payload.announcement === true;
  let groupId = normalizeGroupId(payload.groupId ?? payload.group_id);
  let groupAnnouncement = payload.groupAnnouncement === true || payload.group_announcement === true;
  let group = null;
  const isSimpleRepost = content.length === 0 && repostTo != null;

  const clientNonce = typeof payload.clientNonce === 'string' ? payload.clientNonce.trim() : (
    typeof payload.client_nonce === 'string' ? payload.client_nonce.trim() : null
  );
  const idempotencyKey = clientNonce ? `${userId}:${clientNonce}` : null;
  if (idempotencyKey && idempotencyCache.has(idempotencyKey)) {
    return idempotencyCache.get(idempotencyKey).post;
  }

  // 短時間の完全同一ポスト連投検知 (Flood Protection)
  const now = Date.now();
  const signature = `${userId}:${replyTo || 0}:${repostTo || 0}:${groupId || 0}:${content}`;
  const recentSignature = recentUserPostSignatures.get(userId);
  if (recentSignature && recentSignature.signature === signature && (now - recentSignature.createdAt) < 2500 && attachments.length === 0) {
    return recentSignature.post;
  }

  if (!content && attachments.length === 0 && !isSimpleRepost) {
    throw new Error('content, attachments, or repost_to is required');
  }
  if (isAnnouncement && postingUser.admin !== true) {
    throw new Error('Only administrators can create announcements');
  }
  if (isAnnouncement && (replyTo || repostTo)) {
    throw new Error('Announcements cannot be replies or reposts');
  }
  if (isAnnouncement && groupId) throw new Error('Global announcements cannot be group posts');
  if (groupAnnouncement && !groupId) throw new Error('Group announcements require a group');
  if (groupAnnouncement && replyTo) throw new Error('Group announcements cannot be replies');

  if (isSimpleRepost) {
    groupId = null;
    groupAnnouncement = false;
  }

  validateAttachmentReferences(attachments, userId);
  const relatedPosts = new Map();
  for (const targetId of [replyTo, repostTo].filter(Boolean)) {
    const target = await context.db.getPostById(targetId);
    if (!target || !(await canViewPost(
      context.db,
      target,
      userId,
      null,
      null,
      postingUser,
    ))) {
      throw new Error('Post not found');
    }
    relatedPosts.set(targetId, target);
  }

  // 返信は強制的に返信先と同一グループ（またはグループなし）に統一
  if (replyTo) {
    const replyTarget = relatedPosts.get(replyTo);
    groupId = normalizeGroupId(replyTarget?.groupId ?? replyTarget?.group_id);
    groupAnnouncement = false;
  }

  if (groupId) {
    group = await context.db.getGroupById(groupId);
    if (!group) throw new Error('Group not found');
    await requireGroupPermission(context.db, group, userId, 'post');
    if (groupAnnouncement) await requireGroupPermission(context.db, group, userId, 'announce');
  }

  const processedAttachments = attachments.map((attachment) => {
    if (attachment.data !== undefined) {
      return {
        buffer: decodeBase64File(attachment.data),
        fileName: attachment.fileName || 'file',
        contentType: normalizeContentType(attachment.contentType),
      };
    }
    return attachment;
  });

  const viewContent = isSimpleRepost ? '' : extractViewContent(content);
  const tags = isSimpleRepost ? [] : await extractPostKeywords(viewContent);
  const postService = new PostService({
    dbAdapter: context.db,
    storageAdapter: context.storage,
  });
  const post = await postService.createPost({
    userId,
    content,
    viewContent,
    view_content: viewContent,
    tags,
    tagsGeneratedAt: new Date().toISOString(),
    attachments: processedAttachments,
    mask: Boolean(payload.mask),
    lock: Boolean(payload.lock),
    announcement: isAnnouncement,
    groupId,
    groupAnnouncement,
    replyTo,
    repostTo,
  });

  if (idempotencyKey) {
    idempotencyCache.set(idempotencyKey, { post, createdAt: now });
  }
  recentUserPostSignatures.set(userId, { signature, createdAt: now, post });

  const replyTarget = replyTo ? relatedPosts.get(replyTo) : null;
  const repostTarget = repostTo ? relatedPosts.get(repostTo) : null;
  const needsGroupRecipientCheck = Boolean(group && (replyTarget || repostTarget || /@\d+/.test(content)));
  const activeGroupMemberIds = needsGroupRecipientCheck
    ? new Set(await listActiveGroupMemberIds(context.db, group.id))
    : null;
  const canNotifyPostRecipient = (recipientId) => (
    !activeGroupMemberIds || activeGroupMemberIds.has(Number(recipientId))
  );
  if (replyTarget && canNotifyPostRecipient(replyTarget.userId)) {
    await notifyPostAction(context, {
      userId: replyTarget.userId,
      type: 'reply',
      fromUserId: userId,
      postId: post.id,
    });
  }
  if (repostTarget && canNotifyPostRecipient(repostTarget.userId)) {
    await notifyPostAction(context, {
      userId: repostTarget.userId,
      type: isSimpleRepost ? 'repost' : 'quote',
      fromUserId: userId,
      postId: post.id,
    });
  }

  const excludedNotificationIds = new Set([
    userId,
    Number(replyTarget?.userId),
    Number(repostTarget?.userId),
  ]);
  for (const match of content.matchAll(/@(\d+)/g)) {
    const mentionedUserId = Number(match[1]);
    if (!Number.isInteger(mentionedUserId) || mentionedUserId <= 0) continue;
    if (excludedNotificationIds.has(mentionedUserId)) continue;
    excludedNotificationIds.add(mentionedUserId);
    if (!canNotifyPostRecipient(mentionedUserId)) continue;
    await notifyPostAction(context, {
      userId: mentionedUserId,
      type: 'mention',
      fromUserId: userId,
      postId: post.id,
    });
  }

  if (groupAnnouncement && group) await notifyGroupAnnouncement(context, group, post);

  // 通知設定されたフォロワー/購読者への新規ポスト通知 (返信・リポスト以外)
  if (!replyTo && !isSimpleRepost && typeof context.db.getUserPostSubscribers === 'function') {
    try {
      const subscribers = await context.db.getUserPostSubscribers(userId);
      if (Array.isArray(subscribers) && subscribers.length > 0) {
        const hasHeading = /(?:^|\n)#{1,6}\s+\S/.test(content);
        const hasMedia = Array.isArray(processedAttachments) && processedAttachments.length > 0;

        for (const sub of subscribers) {
          const subId = Number(sub?.userId ?? sub?.user_id ?? sub?.id);
          const mode = sub?.mode;
          if (!Number.isInteger(subId) || subId <= 0) continue;
          if (excludedNotificationIds.has(subId)) continue;
          if (subId === userId) continue;
          if (!canNotifyPostRecipient(subId)) continue;

          let shouldNotify = false;
          if (mode === 'all') {
            shouldNotify = true;
          } else if (mode === 'important' && hasHeading) {
            shouldNotify = true;
          } else if (mode === 'media' && hasMedia) {
            shouldNotify = true;
          }

          if (shouldNotify) {
            excludedNotificationIds.add(subId);
            await notifyPostAction(context, {
              userId: subId,
              type: 'post',
              fromUserId: userId,
              postId: post.id,
            });
          }
        }
      }
    } catch (err) {
      console.warn('[post-actions] failed to notify post subscribers:', err.message);
    }
  }

  await publishNewTimelinePost(context, post);
  timelineCacheManager.onPostCreated(post);
  enqueueGeminiModeration(context, post);
  return post;
}

async function processDeletePostAction(context, { postId, userId, admin = false }) {
  const postToDelete = await context.db.getPostById(postId);
  if (!postToDelete) throw new Error('Post not found');

  const success = admin
    ? await context.db.adminDeletePost(postId)
    : await context.db.deletePost(postId, userId);
  if (!success) {
    throw new Error(admin ? 'Post not found' : 'You do not have permission to delete this post');
  }

  timelineCacheManager.onPostDeleted(postId);
  await deleteStoredAttachments(
    context.storage,
    postToDelete.attachments,
    admin ? 'admin post deletion' : 'post deletion',
  );
}

module.exports = {
  processCreatePostAction,
  processDeletePostAction,
};
