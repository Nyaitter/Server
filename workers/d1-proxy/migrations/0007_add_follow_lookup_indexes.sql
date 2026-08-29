-- フォロー一覧とフォロー中タイムラインの検索用。D1/SQLite共通構文。
CREATE INDEX IF NOT EXISTS idx_follows_follower_created_desc
    ON follows (follower_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_follows_following_created_desc
    ON follows (following_id, created_at DESC);
