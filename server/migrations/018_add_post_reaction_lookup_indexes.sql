-- 投稿一覧での「この閲覧者がリアクション済みか」判定を高速化する。
-- PostgreSQL / CockroachDB 共通の通常インデックスのみを使用する。
CREATE INDEX IF NOT EXISTS idx_likes_post_user
    ON likes (post_id, user_id);

CREATE INDEX IF NOT EXISTS idx_stars_post_user
    ON stars (post_id, user_id);
