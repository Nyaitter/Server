-- JSONB inverted indexes use different syntax in PostgreSQL and CockroachDB.
-- Keep this migration a no-op so both adapters can run the same migration set.
SELECT 1;
