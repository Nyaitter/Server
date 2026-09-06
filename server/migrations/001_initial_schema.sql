-- Nyaitter Server の新規DB用スキーマ
-- PostgreSQL互換のデータベースで使用する。

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    scid TEXT UNIQUE,
    name TEXT NOT NULL,
    handle TEXT,
    nyaitter_address TEXT UNIQUE,
    auth_provider TEXT DEFAULT 'local',
    provider_domain TEXT,
    external_id TEXT,
    external_profile JSONB,
    uuid TEXT,
    settings JSONB DEFAULT '{}'::jsonb,
    bio TEXT,
    header_image TEXT,
    icon_data TEXT,
    verify BOOLEAN NOT NULL DEFAULT false,
    "freeze" TEXT,
    admin BOOLEAN NOT NULL DEFAULT false,
    shadow BOOLEAN NOT NULL DEFAULT false,
    block JSONB NOT NULL DEFAULT '[]'::jsonb,
    account_operation TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT users_block_is_array CHECK (jsonb_typeof(block) = 'array'),
    CONSTRAINT users_account_operation_check CHECK (account_operation IS NULL OR account_operation IN ('reassigning', 'deleting'))
);

CREATE SEQUENCE IF NOT EXISTS nyaitter_posts_id_seq AS INTEGER START WITH 1 MINVALUE 1;
CREATE SEQUENCE IF NOT EXISTS nyaitter_dm_messages_id_seq AS INTEGER START WITH 1 MINVALUE 1;
CREATE SEQUENCE IF NOT EXISTS nyaitter_notifications_id_seq AS INTEGER START WITH 1 MINVALUE 1;
CREATE SEQUENCE IF NOT EXISTS nyaitter_moderation_reports_id_seq AS INTEGER START WITH 1 MINVALUE 1;
CREATE SEQUENCE IF NOT EXISTS nyaitter_logs_id_seq AS INTEGER START WITH 1 MINVALUE 1;

CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY DEFAULT nextval('nyaitter_posts_id_seq'),
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    content TEXT NOT NULL,
    attachments JSONB,
    mask BOOLEAN DEFAULT false,
    lock BOOLEAN NOT NULL DEFAULT false,
    announcement BOOLEAN NOT NULL DEFAULT false,
    reply_to INTEGER,
    repost_to INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS stars (
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS reposts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS pinned_posts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    following_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (follower_id, following_id)
);

CREATE TABLE IF NOT EXISTS dm_channels (
    id TEXT PRIMARY KEY,
    participants INTEGER[] NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dm_messages (
    id INTEGER PRIMARY KEY DEFAULT nextval('nyaitter_dm_messages_id_seq'),
    channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    content TEXT NOT NULL,
    sent_at TIMESTAMPTZ DEFAULT NOW(),
    read_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS group_dms (
    id TEXT PRIMARY KEY,
    host_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    title TEXT DEFAULT '',
    member INTEGER[] NOT NULL DEFAULT '{}',
    post JSONB NOT NULL DEFAULT '[]'::jsonb,
    unread JSONB NOT NULL DEFAULT '{}'::jsonb,
    time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dm_e2e_keys (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY DEFAULT nextval('nyaitter_notifications_id_seq'),
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    type TEXT NOT NULL,
    from_user_id INTEGER REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
    post_id INTEGER,
    message TEXT,
    open TEXT DEFAULT '',
    target JSONB,
    read BOOLEAN DEFAULT false,
    clicked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    ip TEXT,
    user_agent TEXT,
    session_id TEXT NOT NULL UNIQUE,
    ip_hash TEXT,
    ip_masked TEXT
);

CREATE TABLE IF NOT EXISTS trusted_login_ips (
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    ip_hash TEXT NOT NULL,
    ip_masked TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, ip_hash)
);

CREATE TABLE IF NOT EXISTS login_approvals (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    ip_hash TEXT NOT NULL,
    ip_masked TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    poll_token_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    decided_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ,
    CONSTRAINT login_approvals_status_check CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed'))
);

CREATE TABLE IF NOT EXISTS bot_tokens (
    token_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    expiration_time TIMESTAMPTZ,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    session_token TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, endpoint)
);

CREATE TABLE IF NOT EXISTS moderation_reports (
    id INTEGER PRIMARY KEY DEFAULT nextval('nyaitter_moderation_reports_id_seq'),
    reporter_user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    target_kind VARCHAR(16) NOT NULL,
    target_id TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    target_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    assignment_type VARCHAR(24) NOT NULL DEFAULT 'report',
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    assigned_admin_id INTEGER REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
    assigned_at TIMESTAMPTZ,
    excluded_admin_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    resolution JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    CONSTRAINT moderation_reports_target_kind_check CHECK (target_kind IN ('user', 'post', 'dm', 'dm_message')),
    CONSTRAINT moderation_reports_assignment_type_check CHECK (assignment_type IN ('report', 'freeze_appeal', 'verification_application')),
    CONSTRAINT moderation_reports_status_check CHECK (status IN ('pending', 'assigned', 'resolved'))
);

CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY DEFAULT nextval('nyaitter_logs_id_seq'),
    scratch_id TEXT,
    nyaitter_id INTEGER,
    masked_ip_uuid TEXT,
    log_time TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_scid ON users(scid);
CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle);
CREATE INDEX IF NOT EXISTS idx_users_nyaitter_address ON users(nyaitter_address);
CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_root_created_id_desc ON posts(created_at DESC, id DESC) WHERE reply_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_posts_user_created_id_desc ON posts(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_reply_created_id_desc ON posts(reply_to, created_at DESC, id DESC) WHERE reply_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_lock_created_at ON posts(lock, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_announcements ON posts(created_at DESC, id DESC) WHERE announcement = true AND reply_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_likes_post_id ON likes(post_id);
CREATE INDEX IF NOT EXISTS idx_stars_post_id ON stars(post_id);
CREATE INDEX IF NOT EXISTS idx_reposts_post_created_desc ON reposts(post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower_created_desc ON follows(follower_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_follows_following_created_desc ON follows(following_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_messages_channel_sent_id_desc ON dm_messages(channel_id, sent_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_group_dms_time ON group_dms(time DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created_id_desc ON notifications(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_clicked ON notifications(user_id, clicked, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_target_kind ON notifications ((target->>'kind'));
CREATE INDEX IF NOT EXISTS idx_bot_tokens_user ON bot_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user_ip_hash ON sessions(user_id, ip_hash) WHERE ip_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_login_approvals_user_status ON login_approvals(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_approvals_expiry ON login_approvals(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(log_time DESC);
CREATE INDEX IF NOT EXISTS moderation_reports_assignee_status_idx ON moderation_reports(assigned_admin_id, status, assigned_at DESC);
CREATE INDEX IF NOT EXISTS moderation_reports_status_assigned_at_idx ON moderation_reports(status, assigned_at);
CREATE INDEX IF NOT EXISTS moderation_reports_reporter_created_idx ON moderation_reports(reporter_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_reports_appeal_reporter_status_idx ON moderation_reports(reporter_user_id, assignment_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_reports_verification_reporter_status_idx ON moderation_reports(reporter_user_id, assignment_type, status, created_at DESC);
