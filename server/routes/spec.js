'use strict';

const api = require('../utils/ApiRegistry');

const router = api.createRouter({
  tag: 'spec',
  basePath: '/spec',
  description: 'Nyaitter API 仕様・メタデータ取得',
});

router.get({
  path: '/',
  summary: 'Nyaitter API 全仕様（OpenAPI 互換）の取得',
  auth: 'none',
}, (req, res) => {
  const publicUrl = req.app.locals.publicUrl || `${req.protocol}://${req.get('host')}`;
  const spec = api.getOpenApiSpec({
    servers: [{ url: publicUrl, description: 'Current Nyaitter Instance' }],
  });
  res.json(spec);
});

router.get({
  path: '/endpoints',
  summary: '登録済み全エンドポイント一覧の取得',
  auth: 'none',
}, (req, res) => {
  res.json({
    total: api.getEndpoints().length,
    tagLabels: api.getTagLabels(),
    endpoints: api.getEndpoints(),
  });
});

module.exports = router;
