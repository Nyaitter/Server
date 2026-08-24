-- getUserPostSubscribers の JSONB フルスキャンを高速化するための GIN インデックス
-- settings->'user_notifications' に対してインデックスを張り、任意のユーザー購読設定キー検索を O(N) から O(log N) へ改善
-- NOTE: CONCURRENTLY は migrate.js のトランザクション内では実行不可のため使用しない
CREATE INDEX IF NOT EXISTS idx_users_settings_user_notifications
  ON users USING GIN ((settings -> 'user_notifications'));
