# 認証プロバイダー設定ガイド

使うログイン方法だけを有効にします。

| 方法 | ログインのしかた |
|---|---|
| Scratch | Scratch のコメント欄で本人確認 |
| メールアドレス | 届いた 6 桁コードを入力 |
| パスキー | 指紋・顔認証・セキュリティキー |
| Google / Microsoft | OAuth でログイン |

## Scratch

Scratch の認証用プロジェクトにワンタイムコードをコメントしてログインします。最初から有効で、通常は設定不要です。

```dotenv
AUTH_METHOD_SCRATCH_ENABLED=true
```

認証用プロジェクトを変える場合だけ ID を指定します。

```dotenv
SCRATCH_VERIFICATION_PROJECT_ID=<プロジェクトID>
```

## メールアドレス

届いた 6 桁のコードでログインします。

```dotenv
AUTH_METHOD_EMAIL_ENABLED=true
```

送信方法を次の 3 つから選びます。

### 組み込みメールサーバー

サーバー自身がメールを送ります。

```dotenv
AUTH_EMAIL_EMBEDDED_SERVER_ENABLED=true
EMBEDDED_MAIL_DIRECT_DELIVERY_ENABLED=true
EMBEDDED_MAIL_HOSTNAME=mail.example.com
```

### 外部 SMTP サーバー

Gmail、SendGrid、Resend などを使います。

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=user@example.com
SMTP_PASS=your-password
SMTP_FROM=noreply@example.com
```

### 設定しない（開発・テスト用）

認証コードがサーバーのコンソールに表示されます。新規登録時は、メールアドレスが公開されないよう希望のユーザー名を入力します。

## パスキー

端末の生体認証やセキュリティキーでログインします。

```dotenv
AUTH_METHOD_PASSKEY_ENABLED=true
AUTH_PASSKEY_RP_ID=nyaitter.example.com
AUTH_PASSKEY_ORIGIN=https://nyaitter.example.com
```

`AUTH_PASSKEY_RP_ID` と `AUTH_PASSKEY_ORIGIN` にポート番号は含めません。ブラウザの仕様により HTTPS でのみ動作します。

## Google

```dotenv
AUTH_METHOD_GOOGLE_ENABLED=true
GOOGLE_CLIENT_ID=<クライアントID>
GOOGLE_CLIENT_SECRET=<クライアントシークレット>
```

[Google Cloud Console](https://console.cloud.google.com/apis/credentials) で OAuth クライアント ID（ウェブアプリケーション）を作り、承認済みのリダイレクト URI にコールバック URL を登録します。既定は `https://あなたのドメイン/?oauth=google` です。別の URL を使う場合は完全一致する URL を設定します。

```dotenv
GOOGLE_REDIRECT_URI=https://nyaitter.example.com/?oauth=google
```

`email_verified=false` のアカウントはログインできません。初回登録時は公開ユーザー名の入力を求められます。

## Microsoft

```dotenv
AUTH_METHOD_MICROSOFT_ENABLED=true
MICROSOFT_CLIENT_ID=<アプリケーションID>
MICROSOFT_CLIENT_SECRET=<クライアントシークレット>
```

[Microsoft Entra 管理センター](https://entra.microsoft.com/) でアプリを登録し、リダイレクト URI（ウェブ）を追加します。既定のコールバック URL は `https://あなたのドメイン/?oauth=microsoft` です。

```dotenv
MICROSOFT_REDIRECT_URI=https://nyaitter.example.com/?oauth=microsoft
MICROSOFT_TENANT=common
```

`MICROSOFT_TENANT` は特定のテナントに限定する場合だけ変更します。メールアドレスを取得できないアカウントと `email_verified=false` のアカウントはログインできません。初回登録時は公開ユーザー名の入力を求められます。

## Cloudflare Turnstile（任意）

ログイン画面にボット対策を追加します。

```dotenv
TURNSTILE_SECRET_KEY=<シークレットキー>
```

Cloudflare で Turnstile を設定してシークレットキーを取得します。未設定でも各ログイン方法は動作します。

## 新規登録を許可する

方法ごとに新規登録の可否を設定できます。`false` にすると既存ユーザーのログインだけを許可します。

```dotenv
AUTH_METHOD_SCRATCH_ALLOW_SIGNUP=true
AUTH_METHOD_EMAIL_ALLOW_SIGNUP=true
AUTH_METHOD_PASSKEY_ALLOW_SIGNUP=true
AUTH_METHOD_NYAITTER_AUTH_ALLOW_SIGNUP=true
AUTH_METHOD_GOOGLE_ALLOW_SIGNUP=true
AUTH_METHOD_MICROSOFT_ALLOW_SIGNUP=true
```
