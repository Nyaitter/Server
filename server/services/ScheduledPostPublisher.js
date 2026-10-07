const timelineCacheManager = require('../utils/TimelineCacheManager');
const { serializeNotifications } = require('../utils/serialize');
const { getPublicUrl } = require('../utils/nyaitterAddress');
const { publishNewTimelinePost } = require('./PostActionProcessor');

function startScheduledPostPublisher(
  dbAdapter,
  realtimeConnections,
  pushNotificationService,
  { intervalMs = 15 * 1000, logger = console, autoStart = true } = {},
) {
  let running = false;

  const run = async () => {
    if (
      running
      || typeof dbAdapter?.getDueScheduledPosts !== 'function'
      || typeof dbAdapter?.publishScheduledPost !== 'function'
    ) return;

    running = true;
    try {
      const now = new Date().toISOString();
      const duePosts = await dbAdapter.getDueScheduledPosts(now, 100);
      for (const duePost of Array.isArray(duePosts) ? duePosts : []) {
        const postId = Number(duePost?.id);
        if (!Number.isSafeInteger(postId) || postId <= 0) continue;

        try {
          const published = await dbAdapter.publishScheduledPost(postId, now);
          if (!published) continue;

          timelineCacheManager.onPostCreated(published);
          await publishNewTimelinePost({
            db: dbAdapter,
            realtime: realtimeConnections,
          }, published);

          const userId = Number(published.userId ?? published.user_id);
          if (!Number.isSafeInteger(userId)) continue;
          const notification = await dbAdapter.createNotification({
            userId,
            type: 'scheduled_post',
            fromUserId: null,
            postId,
            target: { kind: 'post', id: postId },
            message: '予約投稿を公開しました。',
          });
          const [structured] = notification
            ? await serializeNotifications(dbAdapter, [notification], getPublicUrl(), {
                targetPosts: [published],
              })
            : [];
          if (structured && realtimeConnections) {
            await realtimeConnections.publishNewNotification(userId, structured, dbAdapter);
            if (pushNotificationService?.enabled) {
              void pushNotificationService.sendNotificationToUser(userId, structured).catch(() => {});
            }
          }
        } catch (error) {
          logger.warn?.(`[scheduled-posts] failed to publish post #${postId}:`, error.message);
        }
      }
    } catch (error) {
      logger.error?.('[scheduled-posts] publish sweep failed:', error.message);
    } finally {
      running = false;
    }
  };

  if (autoStart) void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();

  return {
    run,
    stop: () => clearInterval(timer),
  };
}

module.exports = { startScheduledPostPublisher };
