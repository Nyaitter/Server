ALTER TABLE login_approvals ADD COLUMN auth_provider TEXT;

CREATE TABLE IF NOT EXISTS account_recovery_requests (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    ip_hash TEXT NOT NULL,
    ip_masked TEXT DEFAULT '不明なIPアドレス',
    user_agent TEXT DEFAULT '不明な端末',
    auth_provider TEXT NOT NULL,
    request_token_hash TEXT NOT NULL,
    status TEXT DEFAULT 'waiting',
    trust_score INTEGER NOT NULL DEFAULT 0,
    wait_until TEXT NOT NULL,
    started_at TEXT DEFAULT (datetime('now')),
    last_notified_at TEXT,
    notified_count INTEGER NOT NULL DEFAULT 0,
    decided_at TEXT,
    decided_by TEXT,
    consumed_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_recovery_user_status ON account_recovery_requests(user_id, status, started_at);
CREATE INDEX IF NOT EXISTS idx_account_recovery_wait_due ON account_recovery_requests(status, wait_until);
CREATE INDEX IF NOT EXISTS idx_account_recovery_notify ON account_recovery_requests(status, last_notified_at);

CREATE TABLE IF NOT EXISTS blocked_login_ips (
    user_id INTEGER NOT NULL,
    ip_hash TEXT NOT NULL,
    ip_masked TEXT DEFAULT '不明なIPアドレス',
    reason TEXT,
    source_recovery_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, ip_hash),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
