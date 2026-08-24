'use strict';

const { createNotificationIfAllowed } = require('./NotificationDeliveryService');
const { serializeNotification } = require('../utils/serialize');
const { getPublicUrl } = require('../utils/nyaitterAddress');

function startPollExpirationScheduler(
  dbAdapter,
  realtimeConnections,
  pushNotificationService,
  { intervalMs = 60 * 1000, logger = console, autoStart = true } = {},
) {
  let running = false;

  const run = async () => {
    if (running || !dbAdapter || typeof dbAdapter.getExpiredUnnotifiedPolls !== 'function') return;
    running = true;
    try {
      const expiredPolls = await dbAdapter.getExpiredUnnotifiedPolls();
      if (!Array.isArray(expiredPolls) || expiredPolls.length === 0) return;

      for (const poll of expiredPolls) {
        const pollId = Number(poll.id);
        const postId = Number(poll.post_id);
        const authorId = Number(poll.user_id);
        const title = String(poll.title || '投票');

        // まず通知済みフラグをセットして二重送信を防止
        await dbAdapter.markPollClosedNotified(pollId);

        const voters = typeof dbAdapter.getPollVoters === 'function'
          ? await dbAdapter.getPollVoters(pollId)
          : [];

        // 1. ポスト主への通知
        try {
          const authorNotification = await createNotificationIfAllowed(dbAdapter, {
            userId: authorId,
            type: 'poll_ended',
            fromUserId: authorId,
            target: { kind: 'post', id: postId },
            message: `投票「${title}」が終了しました。結果を確認しましょう！`,
          });
          if (authorNotification && realtimeConnections) {
            const structured = await serializeNotification(dbAdapter, authorNotification, getPublicUrl());
            if (structured) {
              await realtimeConnections.publishNewNotification(authorId, structured, dbAdapter);
              if (pushNotificationService?.enabled) {
                void pushNotificationService.sendNotificationToUser(authorId, structured).catch(() => {});
              }
            }
          }
        } catch (err) {
          logger.warn?.('[polls] failed to notify author:', err.message);
        }

        // 2. 投票者への通知（ポスト主を除く）
        const recipientVoters = voters.filter((vId) => Number(vId) !== authorId);
        for (const voterId of recipientVoters) {
          try {
            const voterNotification = await createNotificationIfAllowed(dbAdapter, {
              userId: voterId,
              type: 'poll_ended',
              fromUserId: authorId,
              target: { kind: 'post', id: postId },
              message: `あなたが投票した「${title}」の投票が終了しました。結果を確認しましょう！`,
            });
            if (voterNotification && realtimeConnections) {
              const structured = await serializeNotification(dbAdapter, voterNotification, getPublicUrl());
              if (structured) {
                await realtimeConnections.publishNewNotification(voterId, structured, dbAdapter);
                if (pushNotificationService?.enabled) {
                  void pushNotificationService.sendNotificationToUser(voterId, structured).catch(() => {});
                }
              }
            }
          } catch (err) {
            logger.warn?.('[polls] failed to notify voter:', err.message);
          }
        }
      }
    } catch (error) {
      logger.error?.('[polls] Poll expiration sweep failed:', error.message);
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

module.exports = { startPollExpirationScheduler };
