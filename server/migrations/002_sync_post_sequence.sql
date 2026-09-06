-- 外部データ移行や明示ID投入後に、postsの採番シーケンスを既存IDより遅れない位置へ同期する。
-- sequence_state（PostgreSQL固有のシーケンス表）を参照せず、CockroachDBでも実行できる形にする。
SELECT setval('nyaitter_posts_id_seq', MAX(id))
FROM posts
HAVING MAX(id) IS NOT NULL;
