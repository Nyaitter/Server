CREATE TABLE IF NOT EXISTS authorized_apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    app_id TEXT NOT NULL,
    app_token_hash TEXT NOT NULL,
    app_name TEXT NOT NULL,
    app_icon_url TEXT,
    scopes TEXT NOT NULL DEFAULT '[]',
    access_token_id TEXT,
    access_token_hash TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT,
    UNIQUE (user_id, app_id, app_token_hash)
);

CREATE INDEX IF NOT EXISTS idx_authorized_apps_user_id ON authorized_apps(user_id);
CREATE INDEX IF NOT EXISTS idx_authorized_apps_access_token_id ON authorized_apps(access_token_id);
CREATE INDEX IF NOT EXISTS idx_authorized_apps_lookup ON authorized_apps(user_id, app_id, app_token_hash);
