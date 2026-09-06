-- Migration 020: Add common timeline indexes for PostgreSQL and CockroachDB.

CREATE INDEX IF NOT EXISTS idx_posts_timeline_covering
ON posts (created_at DESC, id DESC)
WHERE group_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_posts_profile_covering
ON posts (user_id, created_at DESC, id DESC);
