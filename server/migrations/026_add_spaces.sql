-- スペース（テキスト/ボイスチャンネルを持つ部屋）とそのメンバー・メッセージ。
-- 通話はWebSocketシグナリング+WebRTCで行うため、ボイス状態は恒久テーブルを持たず
-- メンバーとチャンネルの構造だけを永続化する。

CREATE TABLE IF NOT EXISTS spaces (
    id UUID PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon_data TEXT,
    header_image TEXT,
    visibility TEXT NOT NULL DEFAULT 'public',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT spaces_name_length CHECK (char_length(name) BETWEEN 1 AND 50),
    CONSTRAINT spaces_visibility_check CHECK (visibility IN ('public', 'private'))
);

CREATE TABLE IF NOT EXISTS space_channels (
    id UUID PRIMARY KEY,
    space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT space_channels_kind_check CHECK (kind IN ('text', 'voice'))
);

CREATE INDEX IF NOT EXISTS idx_space_channels_space ON space_channels(space_id, sort_order);

CREATE TABLE IF NOT EXISTS space_members (
    space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (space_id, user_id),
    CONSTRAINT space_members_role_check CHECK (role IN ('owner', 'member'))
);

CREATE INDEX IF NOT EXISTS idx_space_members_user ON space_members(user_id);

CREATE TABLE IF NOT EXISTS space_messages (
    id BIGSERIAL PRIMARY KEY,
    space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL REFERENCES space_channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    content TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_space_messages_channel ON space_messages(channel_id, created_at);
