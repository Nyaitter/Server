-- 一覧取得で毎回集計しないための投稿カウンター。D1/SQLite共通構文。
ALTER TABLE posts ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN star_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN repost_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0;

UPDATE posts SET like_count = (
    SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id
);
UPDATE posts SET star_count = (
    SELECT COUNT(*) FROM stars WHERE stars.post_id = posts.id
);
UPDATE posts SET repost_count = (
    SELECT COUNT(*) FROM reposts WHERE reposts.post_id = posts.id
);
UPDATE posts SET reply_count = (
    SELECT COUNT(*) FROM posts replies WHERE replies.reply_to = posts.id
);

CREATE TRIGGER IF NOT EXISTS posts_like_count_insert
AFTER INSERT ON likes
BEGIN
    UPDATE posts SET like_count = like_count + 1 WHERE id = NEW.post_id;
END;

CREATE TRIGGER IF NOT EXISTS posts_like_count_delete
AFTER DELETE ON likes
BEGIN
    UPDATE posts SET like_count = MAX(0, like_count - 1) WHERE id = OLD.post_id;
END;

CREATE TRIGGER IF NOT EXISTS posts_star_count_insert
AFTER INSERT ON stars
BEGIN
    UPDATE posts SET star_count = star_count + 1 WHERE id = NEW.post_id;
END;

CREATE TRIGGER IF NOT EXISTS posts_star_count_delete
AFTER DELETE ON stars
BEGIN
    UPDATE posts SET star_count = MAX(0, star_count - 1) WHERE id = OLD.post_id;
END;

CREATE TRIGGER IF NOT EXISTS posts_repost_count_insert
AFTER INSERT ON reposts
BEGIN
    UPDATE posts SET repost_count = repost_count + 1 WHERE id = NEW.post_id;
END;

CREATE TRIGGER IF NOT EXISTS posts_repost_count_delete
AFTER DELETE ON reposts
BEGIN
    UPDATE posts SET repost_count = MAX(0, repost_count - 1) WHERE id = OLD.post_id;
END;

CREATE TRIGGER IF NOT EXISTS posts_reply_count_insert
AFTER INSERT ON posts
WHEN NEW.reply_to IS NOT NULL
BEGIN
    UPDATE posts SET reply_count = reply_count + 1 WHERE id = NEW.reply_to;
END;

CREATE TRIGGER IF NOT EXISTS posts_reply_count_delete
AFTER DELETE ON posts
WHEN OLD.reply_to IS NOT NULL
BEGIN
    UPDATE posts SET reply_count = MAX(0, reply_count - 1) WHERE id = OLD.reply_to;
END;
