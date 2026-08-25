const api = require('../utils/ApiRegistry');
const { createRateLimiter } = require('../middleware/rateLimit');
const { optionalAuth } = require('../middleware/auth');
const { getUrlCard } = require('../services/UrlCardService');
const { getPublicUrl } = require('../utils/nyaitterAddress');

const router = api.createRouter({
  tag: 'url-cards',
  basePath: '/url-cards',
  description: 'URL カード・OGP メタデータ取得 API',
});

const urlCardLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 });

router.get({
  path: '/',
  summary: '指定 URL の OGP カード情報の取得',
  auth: 'optional',
}, optionalAuth, urlCardLimiter, async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  const db = req.app.locals.dbAdapter;
  const currentUserId = req.user ? req.user.id : null;
  const knownViewer = req.user?.visibilityUser || null;
  const publicUrl = getPublicUrl(req);

  const card = await getUrlCard(url, {
    db,
    currentUserId,
    knownViewer,
    publicUrl,
  });
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ card });
});

module.exports = router;
