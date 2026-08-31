-- Migration 021: Add trigram GIN indexes for fast fuzzy and substring search
-- Compatible with PostgreSQL and CockroachDB (v22.2+)

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_posts_view_content_trgm
ON posts USING GIN (view_content gin_trgm_ops)
WHERE group_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_name_trgm
ON users USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_users_scid_trgm
ON users USING GIN (scid gin_trgm_ops)
WHERE scid IS NOT NULL;
