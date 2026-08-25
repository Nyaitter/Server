'use strict';

const api = require('../utils/ApiRegistry');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const router = api.createRouter({
  tag: 'rules',
  basePath: '/rules',
  description: '利用規約・コミュニティルール API',
});

function getRulesFilePath() {
  const configured = config.rules?.filePath || 'rule.nd';
  if (path.isAbsolute(configured)) return configured;
  const cwdPath = path.resolve(process.cwd(), configured);
  if (fs.existsSync(cwdPath)) return cwdPath;
  const rootPath = path.resolve(__dirname, '..', '..', configured);
  if (fs.existsSync(rootPath)) return rootPath;
  const serverPath = path.resolve(__dirname, '..', configured);
  if (fs.existsSync(serverPath)) return serverPath;
  return cwdPath;
}

router.get({
  path: '/',
  summary: 'コミュニティルール・利用規約テキストの取得',
  auth: 'none',
}, (req, res) => {
  try {
    const filePath = getRulesFilePath();
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const stats = fs.statSync(filePath);
      return res.json({
        success: true,
        rules: content,
        updated_at: stats.mtime.toISOString(),
      });
    }
    return res.json({
      success: true,
      rules: '# コミュニティルール\n\n現在、利用規約・ルールは設定されていません。',
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[rules] Failed to load rules file:', error);
    return res.status(500).json({
      success: false,
      error: 'ルールの読み込みに失敗しました。',
    });
  }
});

module.exports = router;
