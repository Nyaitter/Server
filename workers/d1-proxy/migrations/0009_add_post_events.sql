-- Nyaitter post events (Outbox pattern for asynchronous event processing)

CREATE TABLE IF NOT EXISTS post_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    post_id INTEGER,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    worker_id TEXT,
    available_at TEXT NOT NULL DEFAULT (datetime('now')),
    locked_at TEXT,
    processed_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_post_events_pending
    ON post_events (available_at, id)
    WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_post_events_post_id
    ON post_events (post_id, id);

CREATE TRIGGER IF NOT EXISTS posts_post_created_event
AFTER INSERT ON posts
BEGIN
    INSERT INTO post_events (event_type, post_id, payload, available_at)
    VALUES ('post.created', NEW.id, json_object('postId', NEW.id, 'userId', NEW.user_id), NEW.created_at);
END;
