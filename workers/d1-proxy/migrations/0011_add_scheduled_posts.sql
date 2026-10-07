ALTER TABLE posts ADD COLUMN scheduled_at TEXT;
CREATE INDEX IF NOT EXISTS idx_posts_scheduled_due ON posts(scheduled_at) WHERE scheduled_at IS NOT NULL;
