-- 明示IDを含むデータ移行後も、notifications.id の採番が既存行と衝突しないよう同期する。
-- sequence_state（PostgreSQL固有のシーケンス表）を参照せず、CockroachDBでも実行できる形にする。
SELECT setval('nyaitter_notifications_id_seq', MAX(id))
FROM notifications
HAVING MAX(id) IS NOT NULL;
