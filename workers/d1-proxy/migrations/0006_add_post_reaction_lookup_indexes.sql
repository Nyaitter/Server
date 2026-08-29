-- 投稿一覧での閲覧者リアクション判定用。D1/SQLite共通構文。
CREATE INDEX IF NOT EXISTS idx_likes_post_user
    ON likes (post_id, user_id);

CREATE INDEX IF NOT EXISTS idx_stars_post_user
    ON stars (post_id, user_id);
