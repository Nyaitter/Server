-- 復旧依頼はユーザーごとに同時1件だけにする。複数IPからの乱立と通知スパムを防ぐ。
WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (
        PARTITION BY user_id
        ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END, started_at DESC, id DESC
    ) AS rn
    FROM account_recovery_requests
    WHERE status IN ('waiting', 'approved')
)
UPDATE account_recovery_requests AS r
SET status = 'expired', decided_at = COALESCE(r.decided_at, NOW())
FROM ranked
WHERE r.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_recovery_one_open
    ON account_recovery_requests (user_id)
    WHERE status IN ('waiting', 'approved');
