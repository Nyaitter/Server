-- 担当管理者が破壊的処理に入る前に lease として書き込む最終取得時刻。
-- 期限切れの再割り当てスイープと管理者の手動対応が同時に走ると二重適用になるため、
-- スイープが「最近 claim された行」を飛ばす判断に使う（排他ロックではなく lease の更新）。
ALTER TABLE moderation_reports ADD COLUMN claimed_at TEXT;
