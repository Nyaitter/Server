-- 投票機能のためのテーブル作成
CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    post_id INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    options JSONB NOT NULL DEFAULT '[]'::jsonb,
    allow_multiple BOOLEAN NOT NULL DEFAULT FALSE,
    allow_other BOOLEAN NOT NULL DEFAULT FALSE,
    show_results_before_voting BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at TIMESTAMPTZ,
    closed BOOLEAN NOT NULL DEFAULT FALSE,
    closed_notified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_polls_post_id ON polls(post_id);
CREATE INDEX IF NOT EXISTS idx_polls_user_id ON polls(user_id);
CREATE INDEX IF NOT EXISTS idx_polls_expiration ON polls(expires_at) WHERE closed_notified = FALSE AND expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS poll_votes (
    id TEXT PRIMARY KEY,
    poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    option_id INT NOT NULL,
    other_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_votes_unique ON poll_votes(poll_id, user_id, option_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll_id ON poll_votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_user_poll ON poll_votes(user_id, poll_id);

-- 既存テーブルが存在する場合の型変更
ALTER TABLE polls ALTER COLUMN id TYPE TEXT;
ALTER TABLE poll_votes ALTER COLUMN id TYPE TEXT;
ALTER TABLE poll_votes ALTER COLUMN poll_id TYPE TEXT;
