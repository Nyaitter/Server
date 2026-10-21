-- DM 一覧を会話履歴の長さから切り離すための集約カラム。
--
-- group_dms.post は会話の全メッセージを JSONB 配列で保持している。
-- 一覧で jsonb_array_length(post) や post -> -1 を参照すると、TOAST された
-- 全履歴を展開するため、履歴が長いほど遅くなる。
-- 件数と最新メッセージを別カラムに持たせ、一覧では post を読まない。
--
-- 既存行はこのマイグレーションで1回だけバックフィルする。

ALTER TABLE group_dms
    ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE group_dms
    ADD COLUMN IF NOT EXISTS latest_message JSONB;

UPDATE group_dms
SET message_count = jsonb_array_length(post),
    latest_message = CASE
        WHEN jsonb_array_length(post) > 0 THEN post -> -1
        ELSE NULL
    END
WHERE message_count = 0
  AND jsonb_array_length(post) > 0;
