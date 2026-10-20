-- ユーザーごとの複数認証プロバイダー紐づけ用テーブル（Postgresの010と同じ役割）。
-- users行のauth_provider/external_idは後方互換の「primary」情報として残し、
-- 紐づけの正はこのテーブルとする。
CREATE TABLE IF NOT EXISTS user_auth_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    provider_profile TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_auth_providers_unique_provider_user
    ON user_auth_providers(provider, provider_user_id);
CREATE INDEX IF NOT EXISTS idx_user_auth_providers_user_id
    ON user_auth_providers(user_id);
