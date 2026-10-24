-- 純粋なリポストに元投稿の本文/添付が複製されていた不具合の修正。
-- repostPost() が posts.content / attachments に元投稿をコピーしていたため、
-- クライアントが content の有無でリポストを引用ポストと誤判定していた。
-- repost_to を持ち、content が参照先と完全一致し、添付も一致する行だけを
-- 純粋なリポスト(content='', attachments=NULL)へ戻す。ユーザーが本文を書いた
-- 引用ポストは content が元投稿と一致しないため対象外。
UPDATE posts AS rp
SET content = '',
    view_content = NULL,
    attachments = NULL
FROM posts AS origin
WHERE rp.repost_to IS NOT NULL
  AND rp.repost_to = origin.id
  AND rp.content IS NOT NULL
  AND rp.content <> ''
  AND rp.content = origin.content
  AND rp.attachments IS NOT DISTINCT FROM origin.attachments;
