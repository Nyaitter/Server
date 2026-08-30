CREATE TABLE IF NOT EXISTS post_events (
    id BIGSERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    post_id INT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    worker_id TEXT,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT post_events_status_check CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_post_events_pending
    ON post_events (available_at, id)
    WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_post_events_post_id
    ON post_events (post_id, id);
