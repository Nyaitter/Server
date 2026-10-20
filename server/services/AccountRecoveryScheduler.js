'use strict';

/**
 * 待機期間を過ぎた復旧依頼を承認し、保留中の依頼について
 * 1日おきの通知を送る定期処理。
 */
function startAccountRecoveryScheduler(
  dbAdapter,
  accountRecoveryService,
  { intervalMs = 60 * 1000, logger = console, autoStart = true } = {},
) {
  let running = false;

  const run = async () => {
    if (running || !dbAdapter || !accountRecoveryService) return;
    running = true;
    try {
      await accountRecoveryService.runCycle(new Date());
    } catch (error) {
      logger.error?.('[account-recovery] scheduler sweep failed:', error.message);
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

module.exports = { startAccountRecoveryScheduler };
