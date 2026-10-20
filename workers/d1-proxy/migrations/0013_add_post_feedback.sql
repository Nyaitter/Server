CREATE TABLE IF NOT EXISTS post_feedback (
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'not_interested',
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, post_id, kind),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_post_feedback_user ON post_feedback(user_id, kind);
