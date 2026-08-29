const api = require('../utils/ApiRegistry');
const { requireAuth } = require('../middleware/auth');
const { getVisibleDmUnreadCount } = require('../services/DmVisibilityService');

const router = api.createRouter({
  tag: 'ui',
  basePath: '/ui',
  description: 'UI / ナビゲーション集計 API',
});

function getDbAdapter(req) {
  return req.app.locals.dbAdapter;
}

router.get({
  path: '/summary',
  summary: 'ナビゲーション用の未読カウントサマリーの取得',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const db = getDbAdapter(req);
  const userId = req.user.id;

  try {
    const [notificationUnreadCount, dmUnreadCount] = await Promise.all([
      db.getUnreadNotificationCount ? db.getUnreadNotificationCount(userId) : 0,
			getVisibleDmUnreadCount(db, userId),
    ]);

    res.json({
      notification_unread_count: Number(notificationUnreadCount || 0),
      dm_unread_count: Number(dmUnreadCount || 0),
    });
  } catch (error) {
    console.error('[ui] summary error:', error);
    res.status(500).json({ error: 'ナビゲーション情報の取得に失敗しました' });
  }
});

module.exports = router;
