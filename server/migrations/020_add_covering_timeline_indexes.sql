-- Migration 020: Add covering indexes for high-speed timeline and profile reads
-- Eliminates table lookup IOPS in PostgreSQL and CockroachDB

CREATE INDEX IF NOT EXISTS idx_posts_timeline_covering 
ON posts (created_at DESC, id DESC) 
INCLUDE (user_id, reply_to, content, view_content, tags, mask, lock, announcement, repost_to)
WHERE group_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_posts_profile_covering 
ON posts (user_id, created_at DESC, id DESC) 
INCLUDE (reply_to, content, view_content, tags, mask, lock, announcement, repost_to);
