# Nyaitter サーバー設定ガイド

サーバーの起動と主要な設定の入口です。各項目の詳しい手順はリンク先のガイドを参照してください。

## 1. 起動する

Node.js 22.23.4 以上が必要です（Node.js 20 は 2026-07 に EOL）。

```bash
npm install
cp server/.env.example server/.env
npm start
```

ブラウザで <http://localhost:3000/> を開きます。`server/.env` を変更したらサーバーを再起動してください。設定の不備は `npm run check:config` で確認できます。

### サーバーごとの待ち受け設定

Nyaitter サーバーは用途ごとに別の HTTP サーバーを持ちます。ホストとポートをそれぞれ指定できます。

| サーバー | 用途 | ポート | ホスト | 未設定時 |
|---|---|---|---|---|
| メイン | API・画面・WebSocket | `PORT`（既定 `3000`） | `HOST` / `NYAITTER_HOST` / `server.host` | 全インターフェース |
| ユーザーファイル | 画像・添付の配信 | `NYAITTER_USER_FILES_PORT` / `userFiles.port` | `NYAITTER_USER_FILES_HOST` / `userFiles.host` | 専用サーバーなし。メイン配下で配信 |
| 投稿共有 | クローラー向けOGP | `POST_SHARE_PORT`（メインと別のときだけ起動） | `NYAITTER_POST_SHARE_HOST` / `postShare.host` | 起動せずメインが配信 |
| 埋め込みメール | メール送信の受け口 | `EMBEDDED_MAIL_SERVER_PORT`（既定 `2525`） | `EMBEDDED_MAIL_SERVER_HOST`（既定 `0.0.0.0`） | 起動しない |
| 運用コントロール | CLI からの操作 | Unix ソケット | `NYAITTER_OPERATOR_SOCKET`（既定 `/tmp/nyaitter-operator.sock`） | 常に起動 |

- `NYAITTER_BIND=0.0.0.0:3000` を指定すると、メインサーバーのホストとポートをまとめて上書きできます（`HOST` / `PORT` より優先）。
- ユーザーファイルと投稿共有のホストは、指定しなければメインサーバーと同じホストで待ち受けます。
- ホストにはホスト名、IPv4、IPv6（`::` や `::1`）を指定できます。不正な値は起動時に警告され、`npm run check:config` で検出されます。

#### リバースプロキシの背後で公開する

直接公開せず、プロキシだけが接続できるようにします。

```dotenv
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=true
PUBLIC_URL=https://nyaitter.example.com
```

#### 直接公開する

```dotenv
HOST=0.0.0.0
PORT=3000
# または
NYAITTER_BIND=0.0.0.0:3000
```

#### 画像を別ポート、投稿共有を別オリジンにする

```dotenv
PORT=3000
NYAITTER_USER_FILES_PORT=3001
NYAITTER_USER_FILES_HOST=127.0.0.1
POST_SHARE_PORT=3002
NYAITTER_POST_SHARE_HOST=0.0.0.0
POST_SHARE_URL=https://share.example.com
```

#### 埋め込みメールサーバーを立てる

```dotenv
EMBEDDED_MAIL_SERVER_ENABLED=true
EMBEDDED_MAIL_SERVER_HOST=0.0.0.0
EMBEDDED_MAIL_SERVER_PORT=2525
EMBEDDED_MAIL_HOSTNAME=mail.example.com
```

## 2. データを保存する

初期状態ではメモリに保存され、サーバーを止めるとデータが消えます。`DB_ADAPTER` を `postgres` または `d1` に設定してください。

### PostgreSQL

```dotenv
DB_ADAPTER=postgres
DATABASE_URL=postgresql://ユーザー名:パスワード@ホスト名:5432/データベース名?sslmode=require
```

設定後にテーブルを作ります。テーブル定義を更新したときも同じコマンドを実行します。

```bash
npm run migrate
```

詳しくは [マイグレーション](./migrations/README.md) を参照してください。

### Cloudflare D1

[Cloudflare D1 設定ガイド](./help/database-d1-worker.md) の手順に従ってください。

## 3. 画像を保存する

```dotenv
STORAGE_ADAPTER=local
STORAGE_USER_QUOTA_MB=512
```

`STORAGE_USER_QUOTA_MB` は 1 人あたりの保存上限（MB）です。Cloudflare R2 を使う場合は [Cloudflare R2 設定ガイド](./help/storage-r2.md) を参照してください。

## 4. 投稿リンクをカード表示する

投稿リンクをカード表示するポート番号を指定します。

```dotenv
POST_SHARE_PORT=3000
```

## 5. ログイン方法を選ぶ

使う方法を `true`、使わない方法を `false` にします。

```dotenv
AUTH_METHOD_SCRATCH_ENABLED=true
AUTH_METHOD_PASSKEY_ENABLED=true
AUTH_METHOD_EMAIL_ENABLED=false
AUTH_METHOD_GOOGLE_ENABLED=false
AUTH_METHOD_MICROSOFT_ENABLED=false
```

Google / Microsoft はクライアント ID とシークレットも必要です。[認証プロバイダー設定ガイド](./help/auth-providers.md) を参照してください。

## 6. アカウントを復旧する

「不明な場所からのログインを拒否」でログインできなくなった場合、承認待ち画面から復旧できます。待機時間と通知の間隔を設定します。

```dotenv
AUTH_ACCOUNT_RECOVERY_ENABLED=true
AUTH_ACCOUNT_RECOVERY_MIN_WAIT_HOURS=24
AUTH_ACCOUNT_RECOVERY_MAX_WAIT_HOURS=168
AUTH_ACCOUNT_RECOVERY_NOTIFICATION_INTERVAL_HOURS=24
```

## 7. AI で投稿をチェックする

AI サービスを登録すると、AutoMod による投稿の自動チェックを使えます。

```dotenv
AI_PROVIDERS=[{"type":"openai","apikey":"YOUR_API_KEY"}]
AUTOMOD_AI_PROVIDER=auto
AUTOMOD_PROMPT=緩めに判断してください
```

[AI プロバイダー設定](./help/ai-providers.md) と [AutoMod 設定ガイド](./help/automod.md) を参照してください。

## 8. ステージと通話に TURN を使う

マイクとカメラを使うには HTTPS または localhost で接続してください。別のネットワーク間で通話する場合は TURN サーバーを設定します。

```dotenv
SPACES_ICE_SERVERS=[{"urls":"turn:turn.example.com:3478","username":"利用者名","credential":"パスワード"}]
```

`server/config.json` の `spaces.iceServers` にも設定できますが、環境変数がある場合はそちらが優先されます。

## 9. サーバーを操作する

```bash
node server/cli.js server status
node server/cli.js maintenance enable
node server/cli.js maintenance disable
```

メンテナンスを解除した後は、サーバーを再起動してください。
