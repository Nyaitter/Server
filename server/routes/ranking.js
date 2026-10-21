const api = require('../utils/ApiRegistry');
const TtlValueCache = require('../utils/TtlValueCache');
const { requireAuth } = require('../middleware/auth');

const router = api.createRouter({
  tag: 'ranking',
  basePath: '/ranking',
  description: 'ユーザーランキング API',
});

function getDbAdapter(req) {
  return req.app.locals.dbAdapter;
}

const rankingCaches = new WeakMap();

function getRankingCache(db) {
  let cache = rankingCaches.get(db);
  if (!cache) {
    cache = new TtlValueCache({ ttlMs: 30000, maxEntries: 2000 });
    rankingCaches.set(db, cache);
  }
  return cache;
}

function getCachedRanking(db, type, limit) {
  return getRankingCache(db).get(`top:${type}:${limit}`, () => db.getRanking(type, limit));
}

function getCachedUserRanking(db, type, userId) {
  return getRankingCache(db).get(`me:${type}:${userId}`, () => db.getUserRanking(type, userId));
}

const RANKING_CACHE_CONTROL = 'public, max-age=30, s-maxage=30, stale-while-revalidate=60';

const VALID_RANKING_TYPES = new Set(['followers', 'posts', 'likes', 'stars']);

router.get({
  path: '/me',
  summary: '自分のランキング順位の取得',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const db = getDbAdapter(req);
  const userId = req.user.id;

  try {
    const [followers, posts, likes, stars] = await Promise.all([
      getCachedUserRanking(db, 'followers', userId),
      getCachedUserRanking(db, 'posts', userId),
      getCachedUserRanking(db, 'likes', userId),
      getCachedUserRanking(db, 'stars', userId),
    ]);

    res.set('Cache-Control', 'private, no-store');
    res.json({
      followers: followers || { rank: null, follower_count: 0 },
      posts: posts || { rank: null, post_count: 0 },
      likes: likes || { rank: null, like_count: 0 },
      stars: stars || { rank: null, star_count: 0 },
    });
  } catch (err) {
    console.error('[ranking] my rank error:', err);
    res.status(500).json({ error: 'ランキングの取得に失敗しました' });
  }
});

router.get({
  path: '/:type',
  summary: '指定した項目のランキング上位ユーザー一覧取得',
  auth: 'none',
}, async (req, res) => {
  const db = getDbAdapter(req);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const type = req.params.type;

  if (!VALID_RANKING_TYPES.has(type)) {
    return res.status(400).json({ error: 'Invalid ranking type' });
  }

  try {
    const rows = await getCachedRanking(db, type, limit);
    const data = rows.map((row, index) => ({ rank: index + 1, ...row }));
    res.set('Cache-Control', RANKING_CACHE_CONTROL);
    res.json({ data });
  } catch (err) {
    console.error('[ranking] list error:', err);
    res.status(500).json({ error: 'ランキングの取得に失敗しました' });
  }
});

module.exports = router;
