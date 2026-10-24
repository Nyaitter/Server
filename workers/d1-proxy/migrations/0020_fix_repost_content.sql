-- 純粋なリポストに元投稿の本文/添付が複製されていた不具合の修正(D1/SQLite)。
-- repost_to を持ち、content が参照先と完全一致し、添付も一致する行だけを
-- 純粋なリポスト(content='', attachments=NULL)へ戻す。ユーザーが本文を書いた
-- 引用ポストは content が元投稿と一致しないため対象外。
UPDATE posts
SET content = '',
    attachments = NULL
WHERE repost_to IS NOT NULL
  AND content IS NOT NULL
  AND content <> ''
  AND content = (SELECT o.content FROM posts AS o WHERE o.id = posts.repost_to)
  AND attachments IS (SELECT o.attachments FROM posts AS o WHERE o.id = posts.repost_to);
