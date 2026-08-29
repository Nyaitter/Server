# NyaitterAuthガイド

NyaitterAuth は、外部のWebサイトやBot、別のNyaitterサーバーが、Nyaitterのアカウントを使って安全にログイン・連携できる仕組みです。

ユーザーはパスワードを外部アプリに教えることなく、許可する権限を確認して安全に連携できます。

---

## 概要と特長

1. **セキュアな認可フロー**:
   - アプリケーションIDとシークレットによる事前リクエスト方式
   - 認可コードは5分間のワンタイム利用
   - トークンはSHA-256ハッシュでDBに安全に保存
2. **きめ細やかな権限管理**:
   - プロフィール閲覧、タイムライン閲覧、投稿、DM、通知などの権限を個別要求
   - ユーザーは連携時にスコープを確認可能
3. **ユーザーによる管理・解除**:
   - 設定画面の「連携アプリ」一覧からいつでも付与権限の変更や連携解除が可能
4. **継続アクセストークン (`continuous_access`)**:
   - 継続アクセスを要求・承認された場合、バックグラウンド等でAPIを呼び出すための専用Bearerトークンを発行

---

## 連携フロー

```mermaid
sequenceDiagram
    autonumber
    actor User as ユーザー
    participant App as 外部アプリケーション (Client / Server)
    participant Nyaitter as Nyaitter サーバー

    App->>Nyaitter: 1. POST /server/api/nyaitter-auth/initiate (app_id, api_token, redirect_uri, scopes)
    Nyaitter-->>App: auth_url (/#nyaitter-auth?request_id=...), request_id
    App->>User: 2. auth_url へリダイレクト
    User->>Nyaitter: 3. 画面でアカウント選択・スコープ承認 (POST /approve)
    Nyaitter-->>User: redirect_uri?code=authcode_...&state=...
    User->>App: 4. コールバックURLへリダイレクト
    App->>Nyaitter: 5. POST /server/api/nyaitter-auth/token (app_id, api_token, code)
    Nyaitter-->>App: user情報, granted_scopes, access_token (continuous_access有効時)
    Note over App,Nyaitter: 6. 以降、Authorization: Bearer <access_token> でAPI呼び出し
```

---

## 利用可能なスコープ (Scopes)

| スコープ名 | 名称 | 必須 | 説明 |
|---|---|---|---|
| `profile:read` | 基本情報の閲覧 | **はい** | ユーザー名、アイコン、Nyaitter ID、自己紹介などの基本情報を閲覧します。 |
| `posts:read` | タイムライン・ポストの閲覧 | いいえ | タイムライン、公開ポスト、返信を閲覧します。 |
| `posts:write` | ポストの投稿・リアクション | いいえ | アカウントからポストの投稿、返信、いいね、リポスト等を行います。 |
| `dm:read` | ダイレクトメッセージの閲覧 | いいえ | DMメッセージを閲覧します。 |
| `dm:write` | ダイレクトメッセージの送信 | いいえ | アカウントからDMメッセージを送信します。 |
| `notifications:read` | 通知の閲覧 | いいえ | 通知一覧を確認します。 |
| `continuous_access` | 継続してアカウントにアクセス | いいえ | バックグラウンド等で継続してAPIにアクセスするための専用アクセストークンを発行します。 |

> `offline_access` は `continuous_access` の別名として利用可能です。

---

## API エンドポイント リファレンス

### 1. 認可リクエストの開始 (`POST /server/api/nyaitter-auth/initiate`)

外部アプリケーションのバックエンドから呼び出し、認可セッションを開始します。

- **リクエスト**:
  ```json
  POST /server/api/nyaitter-auth/initiate
  Content-Type: application/json

  {
    "app_id": "my_sample_app",
    "api_token": "secret_token_12345",
    "name": "サンプルアプリ",
    "icon_url": "https://example.com/icon.png",
    "redirect_uri": "https://example.com/oauth/callback",
    "state": "random_csrf_token",
    "scopes": ["profile:read", "posts:read", "continuous_access"]
  }
  ```

- **レスポンス (200 OK)**:
  ```json
  {
    "success": true,
    "request_id": "req_8f1a2b3c4d5e6f...",
    "auth_url": "https://nyaitter.example.com/#nyaitter-auth?request_id=req_8f1a2b3c4d5e6f...",
    "expires_at": "2026-08-21T15:00:00.000Z"
  }
  ```

ユーザーを `auth_url` へブラウザでリダイレクトしてください。有効期限は15分です。

---

### 2. 認可リクエスト情報の取得 (`GET /server/api/nyaitter-auth/requests/:requestId`)

Nyaitterクライアントの承認画面 (`/#nyaitter-auth`) がリクエスト詳細を表示するために呼び出します。

- **レスポンス (200 OK)**:
  ```json
  {
    "success": true,
    "request": {
      "request_id": "req_8f1a2b3c4d5e6f...",
      "app_id": "my_sample_app",
      "name": "サンプルアプリ",
      "icon_url": "https://example.com/icon.png",
      "redirect_uri": "https://example.com/oauth/callback",
      "scopes": [
        {
          "scope": "profile:read",
          "name": "基本情報の閲覧",
          "description": "ユーザー名、アイコン、Nyaitter ID、自己紹介などの基本情報を閲覧します。",
          "required": true
        },
        {
          "scope": "posts:read",
          "name": "タイムライン・ポストの閲覧",
          "description": "タイムライン、公開ポスト、返信を閲覧します。",
          "required": false
        }
      ],
      "state": "random_csrf_token",
      "already_authorized": false,
      "existing_scopes": [],
      "expires_at": "2026-08-21T15:00:00.000Z"
    }
  }
  ```

---

### 3. 認可コードの交換 (`POST /server/api/nyaitter-auth/token`)

ユーザー承認後にリダイレクトされた `code`を、ユーザー情報およびアクセストークンと交換します。

- **リクエスト**:
  ```json
  POST /server/api/nyaitter-auth/token
  Content-Type: application/json

  {
    "app_id": "my_sample_app",
    "api_token": "secret_token_12345",
    "code": "authcode_a1b2c3d4e5f6..."
  }
  ```

- **レスポンス (200 OK)**:
  ```json
  {
    "success": true,
    "user": {
      "id": 12,
      "name": "nyanko",
      "scid": "nyanko_scratch",
      "handle": "nyanko@nyaitter.example.com",
      "icon_data": "https://example.com/icon.png",
      "me": "よろしくお願いします！",
      "created_at": "2026-01-01T00:00:00.000Z"
    },
    "granted_scopes": ["profile:read", "posts:read", "continuous_access"],
    "access_token": "nyauth_0123456789abcdef_abcdef0123456789...",
    "token_type": "Bearer"
  }
  ```

> `continuous_access` が承認されていない場合、`access_token` は発行されず単発のログイン確認として利用されます。

---

### 4. ユーザー情報取得 (`GET /server/api/nyaitter-auth/userinfo`)

発行されたアクセストークンを付与してユーザー情報を取得します。

- **リクエスト**:
  ```http
  GET /server/api/nyaitter-auth/userinfo
  Authorization: Bearer nyauth_0123456789abcdef_abcdef0123456789...
  ```

- **レスポンス (200 OK)**:
  ```json
  {
    "success": true,
    "user": {
      "id": 12,
      "name": "nyanko",
      "scid": "nyanko_scratch",
      "handle": "nyanko@nyaitter.example.com",
      "icon_data": "https://example.com/icon.png",
      "me": "よろしくお願いします！",
      "created_at": "2026-01-01T00:00:00.000Z"
    },
    "scopes": ["profile:read", "posts:read", "continuous_access"],
    "app_id": "my_sample_app"
  }
  ```

---

## 連携アプリの管理 API

ユーザーは自身のログインセッションから連携中アプリの一覧取得・権限変更・解除を行えます。

| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/server/api/nyaitter-auth/authorized-apps` | 連携中のアプリ一覧を取得 |
| `PATCH` | `/server/api/nyaitter-auth/authorized-apps/:id` | 連携中アプリの付与スコープを更新 |
| `DELETE` | `/server/api/nyaitter-auth/authorized-apps/:id` | 連携中アプリの認証を取り消し |

---

## 他の Nyaitter サーバーとのログイン連携

別の Nyaitter サーバーを認証プロバイダーとして使用する場合、ログイン画面の「他のNyaitterでログイン」機能から連携元サーバーのURLを入力するだけで、NyaitterAuth のプロトコルを通じてシームレスに認証が行われます。
