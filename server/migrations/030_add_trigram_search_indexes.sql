-- Migration 030: Add PostgreSQL trigram indexes for post keyword search.
--
-- These indexes do not change search results. They only accelerate the existing
-- ILIKE predicates used by PostgresAdapter.searchPostIds() and
-- PostgresAdapter.searchGroupPostIds(), including the tags::text fallback.
--
-- This file is PostgreSQL-only. The migration runner never applies it for the
-- D1 adapter (workers/d1-proxy has its own migrations) or the InMemory adapter,
-- so neither backend is affected.
--
-- pg_trgm may be unavailable or the role may lack CREATE EXTENSION permission
-- on managed PostgreSQL. In that case the DO blocks below skip index creation
-- instead of failing the whole migration. A privileged operator can install the
-- extension and re-run this migration manually later.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_trgm';
  ELSE
    RAISE NOTICE 'pg_trgm is not available; skipping trigram search indexes';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_posts_content_trgm ON posts USING gin (content gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_posts_view_content_trgm ON posts USING gin (view_content gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_posts_tags_text_trgm ON posts USING gin ((tags::text) gin_trgm_ops)';
  ELSE
    RAISE NOTICE 'pg_trgm extension is not installed; skipping trigram search indexes';
  END IF;
END
$$;
