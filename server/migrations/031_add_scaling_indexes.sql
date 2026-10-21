-- スケーリング向けの追加インデックス。
-- いずれも既存クエリの結果は変えず、走査コストだけを下げる。
-- 冪等（IF NOT EXISTS）で、再実行しても何度でも安全に適用できる。
--
-- このファイルの GIN 索引は PostgreSQL 固有の構文を使う。
-- 移行ランナーは PostgreSQL アダプタでのみ SQL ファイルを順に適用する
-- （D1 は workers/d1-proxy 側、InMemory は永続化なしで別管理）。

-- 1. group_dms.member の配列包含判定（member @> ARRAY[...]）を高速化する。
--    PostgresAdapter.findGroupDmByMembers() などが member @> $2::int[] を使う。
--    既存の idx_group_dms_time は time 順の一覧用で、配列包含には効かない。
CREATE INDEX IF NOT EXISTS idx_group_dms_member_gin
    ON group_dms USING gin (member);

-- 1b. 1対1 DM の参加者配列も @> で引くため、GIN 索引を追加する。
CREATE INDEX IF NOT EXISTS idx_dm_channels_participants_gin
    ON dm_channels USING gin (participants);

-- 2. 未読 DM の集計（channel_id 単位・read_at IS NULL）を高速化する。
--    PostgresAdapter.getUnreadDmCount() / markDmMessagesAsRead() が
--    channel_id と sender_id で絞り込み、read_at IS NULL を条件にする。
--    部分索引により未読行だけを保持する。
--    既存の idx_dm_messages_channel_sent_id_desc は送信時刻順の一覧用で、
--    read_at 条件や sender_id 絞り込みには効かない。
CREATE INDEX IF NOT EXISTS idx_dm_messages_channel_sender_unread
    ON dm_messages (channel_id, sender_id)
    WHERE read_at IS NULL;

-- 3. 話題の集計（直近3日間）を高速化する。
--    PostgresAdapter.getTrendingPosts() が l/s/r.created_at >= NOW() - INTERVAL '3 days'
--    で絞り込むため、created_at 先頭の索引が必要。
--    既存の idx_likes_post_created_desc 等は post_id 先頭のため、
--    期間だけで絞る集計には使われない。
CREATE INDEX IF NOT EXISTS idx_likes_created_at_desc
    ON likes (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stars_created_at_desc
    ON stars (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reposts_created_at_desc
    ON reposts (created_at DESC);

-- 4. ランキングの投稿数集計（ユーザー単位）を高速化する。
--    PostgresAdapter.getUserRanking('posts', ...) が
--    WHERE group_id IS NULL で GROUP BY user_id する。
--    idx_posts_user_public_created (user_id, created_at DESC, id DESC) WHERE group_id IS NULL
--    と先頭列・述語は重なるが、こちらは created_at/id を持たない分だけ索引が小さく、
--    user_id 単位の件数集計（全走査相当）で有利になる。
CREATE INDEX IF NOT EXISTS idx_posts_user_id_public
    ON posts (user_id)
    WHERE group_id IS NULL;
