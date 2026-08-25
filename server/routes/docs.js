'use strict';

const api = require('../utils/ApiRegistry');

const router = api.createRouter({
  tag: 'docs',
  basePath: '/docs',
  description: '公式ドキュメント・ポータル API',
});

const DEFAULT_DOCUMENTS = [
  {
    id: 'api-reference',
    category: 'developer',
    title: 'REST API リファレンス',
    description: 'Nyaitter の全エンドポイント仕様、認証要件、パラメータ、Nyaitter.js / cURL コード例を検索・閲覧できます。',
    url: '#docs/api',
    icon: 'code',
    isExternal: false,
  },
  {
    id: 'nyaitter-auth',
    category: 'developer',
    title: 'NyaitterAuth 連携仕様',
    description: '外部 Web サイトやアプリに Nyaitter アカウントでのシングルサインオン（SSO）と認可を提供する連携仕様書です。',
    url: '#docs/nyaitter-auth',
    icon: 'key',
    isExternal: false,
  },
  {
    id: 'nyaitter-js',
    category: 'developer',
    title: 'Nyaitter.js SDK',
    description: 'Nyaitter API を簡単に呼び出せる公式 JavaScript / TypeScript クライアントライブラリのリポジトリです。',
    url: 'https://github.com/Nyaitter/Nyaitter.js',
    icon: 'code',
    isExternal: true,
  },
];

const NYAITTER_AUTH_DOC = {
  id: 'nyaitter-auth',
  title: 'NyaitterAuth 連携仕様書',
  description: '外部アプリケーションから Nyaitter のアカウント認証とデータアクセスを利用するための仕様です。',
  updated_at: '2026-08-25',
  content: `# NyaitterAuth 連携仕様書

NyaitterAuth は、外部 Web アプリケーションやツールが Nyaitter アカウントを利用してログイン認証（SSO）を行い、ユーザーの許可を得て Nyaitter のリソースにアクセスするための認可システムです。

---

## 1. 認証・認可フロー概要

NyaitterAuth は OAuth 2.0 / PKCE (Proof Key for Code Exchange) に準拠した安全な認可コードフローを採用しています。

\`\`\`text
1. [外部アプリ] ─── POST /nyaitter-auth/initiate ───> [Nyaitter]
   (リダイレクトURI、スコープ、PKCEチャレンジを送信し、認証リクエストIDを取得)

2. [外部アプリ] ─── ユーザーを認可画面へ転送 ───> [NyaitterClient (#nyaitter-auth)]
   (ユーザーがログインし、連携スコープを確認して「許可」をクリック)

3. [Nyaitter] ─── 認可コード付きでリダイレクト ───> [外部アプリのコールバック]
   (例: https://example.com/callback?code=AUTH_CODE&state=XYZ)

4. [外部アプリ] ─── POST /nyaitter-auth/token ───> [Nyaitter]
   (認可コードと PKCE verifier を送信し、アクセストークンを取得)

5. [外部アプリ] ─── GET /nyaitter-auth/userinfo ───> [Nyaitter]
   (アクセストークンでユーザーのプロフィール情報を取得)
\`\`\`

---

## 2. エンドポイント一覧

### 2.1 認証リクエストの開始
外部アプリから認証リクエストを作成し、\`request_id\` を取得します。

- **URL**: \`POST /server/nyaitter-auth/initiate\` (または \`/api/nyaitter-auth/initiate\`)
- **認証**: 不要
- **リクエスト (JSON)**:
\`\`\`json
{
  "app_id": "your-app-id",
  "name": "あなたのアプリ名",
  "redirect_uri": "https://yourapp.example.com/callback",
  "scopes": ["profile", "posts:read", "posts:write"],
  "state": "ランダムな状態文字列",
  "code_challenge": "PKCEコードチャレンジ（推奨）",
  "code_challenge_method": "S256"
}
\`\`\`

- **レスポンス (JSON)**:
\`\`\`json
{
  "success": true,
  "request_id": "req_1234567890",
  "auth_url": "https://nyaitter.net/#nyaitter-auth?request_id=req_1234567890"
}
\`\`\`

ユーザーを上記 \`auth_url\` または \`#nyaitter-auth?request_id=...\` に遷移させてください。

---

### 2.2 トークンの交換
認可後にコールバックURLへ渡された \`code\` をアクセストークンと交換します。

- **URL**: \`POST /server/nyaitter-auth/token\`
- **認証**: 不要
- **リクエスト (JSON)**:
\`\`\`json
{
  "code": "auth_code_from_callback",
  "code_verifier": "PKCEコードベリファイア（S256検証用）"
}
\`\`\`

- **レスポンス (JSON)**:
\`\`\`json
{
  "success": true,
  "access_token": "nyauth_xxxxxxxxxxxxxxxxxxxx",
  "token_type": "Bearer",
  "expires_in": 2592000,
  "user": {
    "id": 123,
    "name": "ユーザー名",
    "handle": "username",
    "icon_data": "https://..."
  },
  "scopes": ["profile", "posts:read", "posts:write"]
}
\`\`\`

---

### 2.3 ユーザー情報の取得
アクセストークンを用いて、現在のユーザー情報を取得します。

- **URL**: \`GET /server/nyaitter-auth/userinfo\`
- **ヘッダー**: \`Authorization: Bearer nyauth_xxxxxxxxxxxxxxxxxxxx\`
- **レスポンス (JSON)**:
\`\`\`json
{
  "success": true,
  "user": {
    "id": 123,
    "name": "ユーザー名",
    "handle": "username",
    "scid": "ScratchID",
    "icon_data": "https://...",
    "me": "自己紹介文",
    "created_at": "2025-01-01T00:00:00.000Z"
  },
  "scopes": ["profile", "posts:read", "posts:write"],
  "app_id": "your-app-id"
}
\`\`\`

---

## 3. 利用可能なスコープ (Scopes)

| スコープ | 説明 |
| :--- | :--- |
| \`profile\` | ユーザーの基本プロフィール（ID、名前、アイコン、自己紹介）の閲覧 |
| \`posts:read\` | タイムラインおよび投稿の読み取り |
| \`posts:write\` | ユーザー名義での新規投稿作成・リアクション |
| \`dm:read\` | ダイレクトメッセージの閲覧 |
| \`dm:write\` | ダイレクトメッセージの送信 |
| \`notifications\` | 通知一覧の取得 |

---

## 4. Nyaitter.js SDK での利用

Nyaitter.js SDK を使用すると、数行で NyaitterAuth を統合できます。

\`\`\`javascript
import { NyaitterClient, NyaitterAuthClient } from 'nyaitter';

const auth = new NyaitterAuthClient({
  appId: 'my-web-app',
  appName: 'マイWebアプリ',
  redirectUri: window.location.origin + '/callback',
  scopes: ['profile', 'posts:read'],
});

// 1. 認証開始（認可画面へリダイレクト）
document.getElementById('login-btn').addEventListener('click', async () => {
  await auth.login();
});

// 2. コールバック処理
if (window.location.search.includes('code=')) {
  const session = await auth.handleCallback();
  console.log('ログイン成功:', session.user);
  
  // 3. トークンで NyaitterClient を初期化
  const client = new NyaitterClient({ token: session.access_token });
  const posts = await client.posts.getTimeline();
}
\`\`\`
`,
};

router.get({
  path: '/',
  summary: '利用可能な公式ドキュメント一覧の取得',
  auth: 'none',
}, (req, res) => {
  res.json({
    documents: DEFAULT_DOCUMENTS,
  });
});

router.get({
  path: '/:docId',
  summary: '指定したドキュメントの詳細・本文取得',
  auth: 'none',
}, (req, res) => {
  const docId = String(req.params.docId || '').trim();
  if (docId === 'nyaitter-auth') {
    return res.json({
      document: NYAITTER_AUTH_DOC,
    });
  }
  return res.status(404).json({
    error: 'ドキュメントが見つかりません。',
  });
});

module.exports = router;
