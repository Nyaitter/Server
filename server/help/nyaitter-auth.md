# NyaitterAuth ガイド

外部の Web サイト・Bot・別の Nyaitter サーバーが、Nyaitter のアカウントでログイン・連携するための仕組みです。ユーザーはパスワードを渡さず、許可する権限を確認してから連携します。

連携したアプリは、設定画面の「連携アプリ」からいつでも権限を変更・解除できます。

## 連携の流れ

1. アプリが `initiate` を呼び、`auth_url` をユーザーのブラウザに渡します（有効期限 15 分）。
2. ユーザーが画面で権限を確認して承認します。
3. アプリが `code` を `token` と交換します（有効期限 5 分・使い捨て）。
4. `continuous_access` を承認した場合だけ、継続アクセス用の `access_token` が発行されます。承認しない場合は単発のログイン確認として使えます。

## 権限（スコープ）

| スコープ | できること | 必須 |
|---|---|---|
| `profile:read` | ユーザー名、アイコン、自己紹介を見る | はい |
| `posts:read` | タイムライン、公開投稿、返信を見る | いいえ |
| `posts:write` | 投稿、返信、いいね、リポストを行う | いいえ |
| `dm:read` | DM を見る | いいえ |
| `dm:write` | DM を送る | いいえ |
| `notifications:read` | 通知を見る | いいえ |
| `storage:access` | ファイルを保存・閲覧・更新・削除する | いいえ |
| `continuous_access` | バックグラウンド用の専用アクセストークンを発行する | いいえ |

`offline_access` は `continuous_access` の別名です。`read:profile` などの読み替え用の別名も使えます。

## API

`/server/api/` と `/server/` のどちらのプレフィックスでも呼び出せます。

| 用途 | メソッドとパス | 内容 |
|---|---|---|
| 認可の開始 | `POST /server/api/nyaitter-auth/initiate` | 外部アプリのバックエンドから呼ぶ。`app_id`、`api_token`、`redirect_uri`、`scopes` を指定 |
| リクエスト詳細 | `GET /server/api/nyaitter-auth/requests/:requestId` | 承認画面に表示する内容を取得 |
| ユーザー承認 | `POST /server/api/nyaitter-auth/approve` | ログイン中のユーザーが権限を許可 |
| コード交換 | `POST /server/api/nyaitter-auth/token` | `code` をユーザー情報とアクセストークンに交換 |
| ユーザー情報取得 | `GET /server/api/nyaitter-auth/userinfo` | `Authorization: Bearer <access_token>` で呼ぶ |

### リクエスト例

`POST /server/api/nyaitter-auth/initiate` の本文です。

```json
{
  "app_id": "my_sample_app",
  "api_token": "your-api-token",
  "name": "サンプルアプリ",
  "icon_url": "https://example.com/icon.png",
  "redirect_uri": "https://example.com/oauth/callback",
  "state": "random_csrf_token",
  "scopes": ["profile:read", "posts:read", "continuous_access"]
}
```

### レスポンス例

`token` のレスポンスです。

```json
{
  "success": true,
  "user": { "id": 12, "name": "nyanko", "scid": "nyanko_scratch" },
  "granted_scopes": ["profile:read", "posts:read", "continuous_access"],
  "access_token": "nyauth_...",
  "token_type": "Bearer"
}
```

## 連携中のアプリを管理する

| メソッド | パス | できること |
|---|---|---|
| `GET` | `/server/api/nyaitter-auth/authorized-apps` | 連携中のアプリ一覧を取得 |
| `PATCH` | `/server/api/nyaitter-auth/authorized-apps/:id` | 権限を変更 |
| `DELETE` | `/server/api/nyaitter-auth/authorized-apps/:id` | 連携を解除 |

## 関連ドキュメント

[認証プロバイダー設定](./auth-providers.md) / [拡張 API キー](./extension-keys.md)
