-- スペースの公開範囲に「グループ限定」を追加する。
-- group_id はスペースを閲覧・参加できるグループを指す。

ALTER TABLE spaces ADD COLUMN IF NOT EXISTS group_id UUID;

ALTER TABLE spaces DROP CONSTRAINT IF EXISTS spaces_visibility_check;
ALTER TABLE spaces ADD CONSTRAINT spaces_visibility_check CHECK (visibility IN ('public', 'private', 'group'));
