-- 「関連性が低いと評価」(dislike) を推薦の負のシグナルとして永続化する。
-- 投稿そのものは推薦から除外し、投稿者には負のペナルティを与える。

CREATE TABLE IF NOT EXISTS post_feedback (
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON UPDATE CASCADE ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'not_interested',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, post_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_post_feedback_user ON post_feedback(user_id, kind);
