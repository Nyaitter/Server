-- Add polls and poll_votes tables
CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    options TEXT NOT NULL,
    allow_multiple INTEGER NOT NULL DEFAULT 0,
    allow_other INTEGER NOT NULL DEFAULT 0,
    show_results_before_voting INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    closed INTEGER NOT NULL DEFAULT 0,
    closed_notified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_polls_post_id ON polls(post_id);
CREATE INDEX IF NOT EXISTS idx_polls_user_id ON polls(user_id);
CREATE INDEX IF NOT EXISTS idx_polls_expires_at ON polls(expires_at);

CREATE TABLE IF NOT EXISTS poll_votes (
    id INTEGER PRIMARY KEY,
    poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    option_id INTEGER NOT NULL,
    other_text TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_poll_votes_poll_id ON poll_votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_user_id ON poll_votes(user_id);
