-- スペース（テキスト/ボイスチャンネルを持つ部屋）とそのメンバー・メッセージ。
-- 通話はWebSocketシグナリング+WebRTCで行うため、ボイス状態は恒久テーブルを持たず
-- メンバーとチャンネルの構造だけを永続化する。

CREATE TABLE IF NOT EXISTS spaces (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon_data TEXT,
    header_image TEXT,
    visibility TEXT NOT NULL DEFAULT 'public',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS space_channels (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(space_id) REFERENCES spaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_space_channels_space ON space_channels(space_id, sort_order);

CREATE TABLE IF NOT EXISTS space_members (
    space_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (space_id, user_id),
    FOREIGN KEY(space_id) REFERENCES spaces(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_space_members_user ON space_members(user_id);

CREATE TABLE IF NOT EXISTS space_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(space_id) REFERENCES spaces(id) ON DELETE CASCADE,
    FOREIGN KEY(channel_id) REFERENCES space_channels(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_space_messages_channel ON space_messages(channel_id, created_at);
