-- スペースの公開範囲に「グループ限定」を追加する。
-- group_id はスペースを閲覧・参加できるグループを指す。

ALTER TABLE spaces ADD COLUMN group_id TEXT;
