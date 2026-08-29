# 認証プロバイダー 設定ガイド

NyaitterServer では、複数のログイン方法を用途や好みに合わせて自由に有効化・設定できます。

---

## 利用可能な認証方法一覧

| 認証プロバイダー | 説明 | 主な用途 |
|---|---|---|
| **1. Scratch認証** | Scratchのコメント欄を使った確実な本人確認 | Scratcher向けコミュニティ |
| **2. メールアドレス認証** | 6桁の認証コードによる安全なログイン | 一般ユーザー・Scratch未利用者向け |
| **3. パスキー認証** | 指紋・顔認証・セキュリティキーによる高速ログイン | パスワード不要の生体認証 |

---

## 1. Scratch 認証 (`scratch`)

Scratchの認証用プロジェクトにワンタイムコードをコメントすることでログインします。

### 設定方法
デフォルトで有効になっているため、特別な設定を行わなくてもそのまま利用できます。

```dotenv
# server/.env
AUTH_METHOD_SCRATCH_ENABLED=true
```

### オプション設定
- **認証用プロジェクトIDの変更**
  ```dotenv
  SCRATCH_VERIFICATION_PROJECT_ID=1239738451
  ```
- **ボット対策 (Cloudflare Turnstile)**
  ```dotenv
  TURNSTILE_SECRET_KEY=0x4AAAAAA...
  ```

---

## 2. メールアドレス認証 (`email`)

入力したメールアドレス宛に届く **6桁の認証コード** を入力してログインします。  
以下の **3つの方法** から、環境に合ったものを1つ選んで設定してください。

```dotenv
# server/.env (共通: 有効化)
AUTH_METHOD_EMAIL_ENABLED=true
```

### パターンA: 組み込みメールサーバー (おすすめ / 外部サービス不要)
NyaitterServer自身が自動でメールを直接送信します。外部のメール配信サービス契約は不要です。

```dotenv
# 組み込みメールサーバーを有効化
AUTH_EMAIL_EMBEDDED_SERVER_ENABLED=true

# 宛先メールサーバーへ直接送信 (MX直接配信)
EMBEDDED_MAIL_DIRECT_DELIVERY_ENABLED=true

# お使いのサーバーのメール用ドメイン名 (例: mail.example.com または example.com)
EMBEDDED_MAIL_HOSTNAME=mail.example.com
```

---

### パターンB: 外部SMTPサーバー (Gmail / SendGrid / Resend等)
すでにお持ちのメール配信サービスやGmailなどを利用して送信します。

```dotenv
# SMTPサーバーの接続情報
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=user@example.com
SMTP_PASS=your-password
SMTP_FROM=noreply@example.com
```

---

### パターンC: ローカル開発 / テスト環境
メール送信設定を行わない場合、認証コードは **サーバーのコンソール** に自動で表示されます。テストや開発で手軽にログインを試したいときに便利です。

```text
================================================================
[auth:email] 認証メール送信 (ローカル/開発モード)
To: user@example.com
Subject: 【Nyaitter】ログイン認証コード
Verification Code: 123456
================================================================
```

---

## 3. パスキー認証 (`passkey`)

スマートフォンやPCの **Touch ID / Face ID / Windows Hello / セキュリティキー** を使ってログインします。

### 設定方法

```dotenv
# server/.env
AUTH_METHOD_PASSKEY_ENABLED=true

# サイトのドメイン名 (ポート番号を含まない)
AUTH_PASSKEY_RP_ID=nyaitter.example.com

# サイトの公開URL (https://から始まるURL)
AUTH_PASSKEY_ORIGIN=https://nyaitter.example.com
```

> **注意**: パスキー認証はブラウザのセキュリティ仕様上、**HTTPS環境**でのみ動作します。

---

## アカウントへの複数認証の紐付け・解除

ユーザーはログイン後、設定画面の **「プライバシーとセキュリティ」** タブから以下を行えます:

1. **未連携の認証方法を追加連携**:
   - 例: Scratchアカウントでログイン後、メールアドレスやパスキーを追加登録。
   - 次回からどちらの方法でも同じアカウントにログイン可能になります。
2. **不要になった認証方法の連携解除**:
   - 不要な連携をいつでも解除できます。
   - ※ アカウントに最低1つの認証方法が残るよう、自動で保護されます。

## 認証方法ごとの新規登録の制御 (ALLOW_SIGNUP)

各認証方法ごとに、**新規アカウントの作成を許可するか** を個別に設定できます。
`false` に設定した場合、その方法での新規登録は拒否され、既にアカウントをお持ちの既存ユーザーのログインのみが許可されます。

```dotenv
# server/.env
AUTH_METHOD_SCRATCH_ALLOW_SIGNUP=true      # Scratchでの新規登録
AUTH_METHOD_EMAIL_ALLOW_SIGNUP=true        # メールでの新規登録
AUTH_METHOD_PASSKEY_ALLOW_SIGNUP=true      # パスキーでの新規登録
AUTH_METHOD_NYAITTER_AUTH_ALLOW_SIGNUP=true # 他サーバー連携での新規登録
```

> **プライバシー保護**: メールアドレス認証などで新規アカウントを作成する際は、メールアドレスの一部が公開ユーザー名になってしまうのを防ぐため、登録画面で希望のユーザー名を入力します。

---

## 設定の動作確認

設定を変更したら、以下のコマンドで設定に不備がないかチェックできます。

```bash
npm run check:config
```
