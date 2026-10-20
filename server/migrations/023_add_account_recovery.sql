-- アカウントアクセスの復旧: 不明な場所からのログインで締め出されたときの復旧依頼と、
-- 復旧をブロックした際の恒久的なIPブロックを管理する。

ALTER TABLE login_approvals ADD COLUMN IF NOT EXISTS auth_provider TEXT;

CREATE TABLE IF NOT EXISTS account_recovery_requests (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    ip_hash TEXT NOT NULL,
    ip_masked TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    auth_provider TEXT NOT NULL,
    request_token_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    trust_score INTEGER NOT NULL DEFAULT 0,
    wait_until TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_notified_at TIMESTAMPTZ,
    notified_count INTEGER NOT NULL DEFAULT 0,
    decided_at TIMESTAMPTZ,
    decided_by TEXT,
    consumed_at TIMESTAMPTZ,
    CONSTRAINT account_recovery_status_check CHECK (status IN ('waiting', 'approved', 'blocked', 'expired', 'consumed'))
);

CREATE INDEX IF NOT EXISTS idx_account_recovery_user_status ON account_recovery_requests(user_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_recovery_wait_due ON account_recovery_requests(status, wait_until);
CREATE INDEX IF NOT EXISTS idx_account_recovery_notify ON account_recovery_requests(status, last_notified_at);

CREATE TABLE IF NOT EXISTS blocked_login_ips (
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    ip_hash TEXT NOT NULL,
    ip_masked TEXT NOT NULL,
    reason TEXT,
    source_recovery_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, ip_hash)
);
