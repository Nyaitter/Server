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
    if (attachment.type === 'poll') {
      const options = Array.isArray(attachment.options) ? attachment.options : [];
      if (options.length < 2) {
        throw new Error('投票には最低2つの選択肢が必要です');
      }
      continue;
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
  const targetIds = [...new Set([replyTo, repostTo].filter(Boolean))];
  let targetPosts = [];
  if (typeof context.db.getPostsByIds === 'function') {
    try {
      targetPosts = await context.db.getPostsByIds(targetIds);
    } catch (_) {}
  }
  if (targetPosts.length === 0 && targetIds.length > 0 && typeof context.db.getPostById === 'function') {
    targetPosts = await Promise.all(targetIds.map((targetId) => context.db.getPostById(targetId)));
  }
  const targetPostsById = new Map((targetPosts || []).filter(Boolean).map((post) => [Number(post.id), post]));
  for (const targetId of targetIds) {
    const target = targetPostsById.get(Number(targetId));
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

  const rawReplyControl = payload.replyControl ?? payload.reply_control ?? 'everyone';
  let replyControl = ['everyone', 'following', 'mentioned', 'following_or_mentioned', 'mentioned_only'].includes(rawReplyControl)
    ? (rawReplyControl === 'following_or_mentioned' ? 'following' : (rawReplyControl === 'mentioned_only' ? 'mentioned' : rawReplyControl))
    : 'everyone';

  // 返信は強制的に返信先と同一グループに統一し、返信権限を検証
  if (replyTo) {
    let replyTarget = relatedPosts.get(replyTo);
    if (!replyTarget && typeof context.db.getPostById === 'function') {
      replyTarget = await context.db.getPostById(replyTo);
    }
    if (replyTarget) {
      let rootPost = replyTarget;

      // WITH RECURSIVE で祖先を 1 クエリで取得
      if (typeof context.db.getPostAncestors === 'function') {
        const ancestors = await context.db.getPostAncestors(replyTo);
        for (const ancestor of ancestors) {
          relatedPosts.set(Number(ancestor.id), ancestor);
          rootPost = ancestor; // 最後が最も深い祖先
        }
      } else {
        // フォールバック: 旧来の直列走査
        let currentAncestor = replyTarget;
        const visited = new Set([Number(replyTarget.id)]);
        while (currentAncestor && (currentAncestor.replyTo || currentAncestor.reply_to)) {
          const nextParentId = Number(currentAncestor.replyTo || currentAncestor.reply_to);
          if (!Number.isInteger(nextParentId) || visited.has(nextParentId)) break;
          visited.add(nextParentId);
          let nextParent = relatedPosts.get(nextParentId);
          if (!nextParent && typeof context.db.getPostById === 'function') {
            nextParent = await context.db.getPostById(nextParentId);
          }
          if (nextParent) {
            rootPost = nextParent;
            currentAncestor = nextParent;
          } else {
            break;
          }
        }
      }

      const rootReplyControl = rootPost.replyControl || rootPost.reply_control || 'everyone';
      replyControl = rootReplyControl; // 返信には親/ルートポストの返信制限が伝播する

      if (rootReplyControl !== 'everyone') {
        const isRootAuthor = Number(rootPost.userId) === Number(userId);
        const isParentAuthor = Number(replyTarget.userId) === Number(userId);
        if (!isRootAuthor && !isParentAuthor) {
          const isMentionedInRoot = Boolean(rootPost.content && new RegExp(`@${userId}\\b`).test(rootPost.content));
          const isMentionedInParent = Boolean(replyTarget.content && new RegExp(`@${userId}\\b`).test(replyTarget.content));
          const isMentioned = isMentionedInRoot || isMentionedInParent;
          let permitted = false;
          if (rootReplyControl === 'following' || rootReplyControl === 'following_or_mentioned') {
            const relationshipUserIds = [Number(rootPost.userId), Number(replyTarget.userId)]
              .filter((id, index, ids) => Number.isInteger(id) && ids.indexOf(id) === index);
            let followedBy = new Set();
            let relationshipSnapshotLoaded = false;
            if (typeof context.db.getFollowRelationshipSnapshot === 'function') {
              try {
                const snapshot = await context.db.getFollowRelationshipSnapshot(userId, relationshipUserIds);
                followedBy = new Set((snapshot?.followerIds || []).map(Number));
                relationshipSnapshotLoaded = true;
              } catch (_) {}
            }
            const isFollowedByRoot = followedBy.has(Number(rootPost.userId))
              || (!relationshipSnapshotLoaded && typeof context.db.isFollowing === 'function'
                && await context.db.isFollowing(Number(rootPost.userId), Number(userId)));
            const isFollowedByParent = followedBy.has(Number(replyTarget.userId))
              || (!relationshipSnapshotLoaded && typeof context.db.isFollowing === 'function'
                && await context.db.isFollowing(Number(replyTarget.userId), Number(userId)));
            permitted = isMentioned || isFollowedByRoot || isFollowedByParent;
          } else if (rootReplyControl === 'mentioned' || rootReplyControl === 'mentioned_only') {
            permitted = isMentioned;
          }
          if (!permitted) {
            throw new Error('このポストに返信できるユーザーが制限されています');
          }
        }
      }
    }
    groupId = normalizeGroupId(replyTarget?.groupId ?? replyTarget?.group_id);
    groupAnnouncement = false;
  }

  if (groupId) {
    group = await context.db.getGroupById(groupId);
    if (!group) throw new Error('Group not found');
    await requireGroupPermission(context.db, group, userId, 'post');
    if (groupAnnouncement) await requireGroupPermission(context.db, group, userId, 'announce');
  }

  const pollAttachment = attachments.find((a) => a && a.type === 'poll') || (payload.poll && typeof payload.poll === 'object' ? payload.poll : null);
  const fileAttachments = attachments.filter((a) => a && a.type !== 'poll');

  const processedAttachments = fileAttachments.map((attachment) => {
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
    replyControl,
    reply_control: replyControl,
    replyTo,
    repostTo,
  });

  if (pollAttachment && typeof context.db.createPoll === 'function') {
    try {
      const createdPoll = await context.db.createPoll({
        postId: post.id,
        userId,
        title: pollAttachment.title || content || '投票',
        options: pollAttachment.options,
        allowMultiple: Boolean(pollAttachment.allow_multiple ?? pollAttachment.allowMultiple),
        allowOther: Boolean(pollAttachment.allow_other ?? pollAttachment.allowOther),
        showResultsBeforeVoting: Boolean(pollAttachment.show_results_before_voting ?? pollAttachment.showResultsBeforeVoting ?? true),
        expiresAt: pollAttachment.expires_at ?? pollAttachment.expiresAt ?? null,
      });
      post.poll = createdPoll;
    } catch (pollErr) {
      console.warn('[post-actions] failed to create poll for post:', pollErr.message);
    }
  }

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

  // 通知タスクを収集して並列実行
  const notificationTasks = [];
  const excludedNotificationIds = new Set([
    userId,
    replyTarget ? Number(replyTarget.userId) : null,
    repostTarget ? Number(repostTarget.userId) : null,
  ].filter((id) => id != null && Number.isInteger(id)));

  if (replyTarget && canNotifyPostRecipient(replyTarget.userId)) {
    notificationTasks.push(notifyPostAction(context, {
      userId: replyTarget.userId,
      type: 'reply',
      fromUserId: userId,
      postId: post.id,
    }));
  }
  if (repostTarget && canNotifyPostRecipient(repostTarget.userId)) {
    notificationTasks.push(notifyPostAction(context, {
      userId: repostTarget.userId,
      type: 'repost',
      fromUserId: userId,
      postId: post.id,
    }));
  }

  // メンション通知
  for (const match of content.matchAll(/@(\d+)/g)) {
    const mentionedUserId = Number(match[1]);
    if (!Number.isInteger(mentionedUserId) || mentionedUserId <= 0) continue;
    if (excludedNotificationIds.has(mentionedUserId)) continue;
    excludedNotificationIds.add(mentionedUserId);
    if (!canNotifyPostRecipient(mentionedUserId)) continue;
    notificationTasks.push(notifyPostAction(context, {
      userId: mentionedUserId,
      type: 'mention',
      fromUserId: userId,
      postId: post.id,
    }));
  }

  if (groupAnnouncement && group) {
    notificationTasks.push(notifyGroupAnnouncement(context, group, post));
  }

  // 購読者通知
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
            notificationTasks.push(notifyPostAction(context, {
              userId: subId,
              type: 'post',
              fromUserId: userId,
              postId: post.id,
            }));
          }
        }
      }
    } catch (err) {
      console.warn('[post-actions] failed to notify post subscribers:', err.message);
    }
  }

  // 全通知を並列実行
  await Promise.allSettled(notificationTasks);

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

async function processEditPostAction(context, { postId, userId, content, attachments, mask, lock, replyControl }) {
  const post = await context.db.getPostById(postId);
  if (!post) throw new Error('Post not found');
  if (post.userId !== userId) throw new Error('You can only edit your own posts');

  const { extractViewContent } = require('../utils/viewContent');
  const { extractPostKeywords } = require('./PostKeywordService');

  const normalizedContent = content.trim();
  const viewContent = extractViewContent(normalizedContent);
  const updatePayload = {
    content: normalizedContent,
    viewContent,
    view_content: viewContent,
    tags: await extractPostKeywords(viewContent),
    tagsGeneratedAt: new Date().toISOString(),
    attachments: Array.isArray(attachments) && attachments.length > 0 ? attachments : null,
    mask: !!mask,
    lock: !!lock,
  };

  const isReply = Boolean(post.replyTo != null || post.reply_to != null);
  if (replyControl !== undefined && !isReply) {
    updatePayload.reply_control = replyControl;
    updatePayload.replyControl = replyControl;
  }

  const updated = await context.db.updatePost(postId, updatePayload);

  // 返信制限変更時スレッド全体に伝播、条件外の返信を削除
  if (!isReply && replyControl !== undefined) {
    try {
      let replyIds = [];
      if (typeof context.db.getThreadReplyPostIds === 'function') {
        replyIds = (await context.db.getThreadReplyPostIds(postId, 500, 0))?.ids || [];
      } else if (typeof context.db.getReplyPostIds === 'function') {
        replyIds = (await context.db.getReplyPostIds(postId, 500, 0))?.ids || [];
      }
      if (replyIds.length > 0) {
        const existingReplies = await context.db.getPostsByIds(replyIds);
        for (const reply of existingReplies) {
          if (!reply) continue;
          if (replyControl !== 'everyone' && Number(reply.userId) !== Number(userId)) {
            const isMentioned = Boolean(normalizedContent && new RegExp(`@${reply.userId}\\b`).test(normalizedContent));
            let permitted = false;
            if (replyControl === 'following') {
              const isFollowed = typeof context.db.isFollowing === 'function'
                ? await context.db.isFollowing(Number(userId), Number(reply.userId))
                : false;
              permitted = isMentioned || isFollowed;
            } else if (replyControl === 'mentioned') {
              permitted = isMentioned;
            }
            if (!permitted) {
              if (typeof context.db.adminDeletePost === 'function') await context.db.adminDeletePost(reply.id);
              else if (typeof context.db.deletePost === 'function') await context.db.deletePost(reply.id, reply.userId);
              continue;
            }
          }
          await context.db.updatePost(reply.id, {
            reply_control: replyControl,
            replyControl,
          }).catch(() => {});
        }
      }
    } catch (cleanupError) {
      console.warn('[post-actions] Failed to clean up invalid replies on post edit:', cleanupError.message);
    }
  }

  const moderatedPost = updated || post;
  timelineCacheManager.updatePost(moderatedPost);
  enqueueGeminiModeration(context, moderatedPost);
  return moderatedPost;
}

module.exports = {
  processCreatePostAction,
  processDeletePostAction,
  processEditPostAction,
};
