ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS user_keyword_affinities (
  user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  score NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, keyword),
  CONSTRAINT user_keyword_affinities_keyword_length CHECK (char_length(keyword) BETWEEN 1 AND 48),
  CONSTRAINT user_keyword_affinities_score_nonnegative CHECK (score >= 0)
);

-- JSONB inverted indexes use different syntax in PostgreSQL and CockroachDB.
-- The application remains correct without this optional acceleration index.
CREATE INDEX IF NOT EXISTS idx_user_keyword_affinities_user_score
  ON user_keyword_affinities(user_id, score DESC, keyword);
