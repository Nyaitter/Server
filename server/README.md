# Nyaitter サーバー設定ガイド

Nyaitter のデータ保存、アカウント管理、通知、投稿配信を行うサーバーです。

## 1. 起動する

```bash
npm install
cp server/.env.example server/.env
npm start
```

ブラウザで <http://localhost:3000/> を開くと使えます。`server/.env` を変更したら、サーバーを再起動してください。

## 2. データを保存する

初期状態では、サーバーを止めるとデータが消えます。データを残すには PostgreSQL か Cloudflare D1 を設定します。

### PostgreSQL

```dotenv
DB_ADAPTER=postgres
DATABASE_URL=postgresql://ユーザー名:パスワード@ホスト名:5432/データベース名?sslmode=require
```

設定後にテーブルを作ります。

```bash
npm run migrate
```

### Cloudflare D1

[Cloudflare D1 設定ガイド](./help/database-d1-worker.md) の手順に従ってください。

## 3. 画像を保存する

```dotenv
# サーバー本体に保存する
STORAGE_ADAPTER=local

# 1人あたりの保存上限（MB）
STORAGE_USER_QUOTA_MB=512
```

Cloudflare R2 に保存する場合は [Cloudflare R2 設定ガイド](./help/storage-r2.md) を確認してください。

## 4. 投稿リンクをカード表示する

Discord や SNS に投稿リンクを貼ったとき、文章や画像をカードで表示できます。使うポート番号を指定します。

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

Google / Microsoft はクライアント ID とシークレットも必要です。[認証プロバイダー設定ガイド](./help/auth-providers.md) を確認してください。

## 6. アカウントを復旧する

「不明な場所からのログインを拒否」でログインできなくなったときは、承認待ち画面から復旧を始められます。待機期間はアカウントの状態で決まり、信頼度が高いほど短くなります。待機中は指定した間隔で通知が届き、心当たりがなければブロックできます。待機期間が終わると、復旧を始めた場所が自動で信頼されます。

```dotenv
AUTH_ACCOUNT_RECOVERY_ENABLED=true
AUTH_ACCOUNT_RECOVERY_MIN_WAIT_HOURS=24
AUTH_ACCOUNT_RECOVERY_MAX_WAIT_HOURS=168
AUTH_ACCOUNT_RECOVERY_NOTIFICATION_INTERVAL_HOURS=24
```

## 7. AI で投稿をチェックする

AI サービスを登録すると、投稿内容の自動チェックと AI 機能を使えます。

```dotenv
AI_PROVIDERS=[{"type":"openai","apikey":"YOUR_API_KEY"}]
AUTOMOD_AI_PROVIDER=auto
AUTOMOD_PROMPT=緩めに判断してください
```

詳しくは [AI プロバイダー設定](./help/ai-providers.md) と [AutoMod 設定ガイド](./help/automod.md) を確認してください。

## 8. ステージと通話を使う

サイドメニューの「ステージ」から、公開・グループ限定・招待者限定のステージを開始できます。予約したステージはホストが詳細画面から開始します。ホストは参加者を招待でき、スピーカーの発言権を変更できます。

メッセージ画面の右上にある電話ボタンから、そのメッセージの通話に参加できます。どちらも参加前にマイクとカメラを選べます。通話中は画面共有、コメント、対応ブラウザーでの文字起こしを使えます。ステージの視聴者は視聴とコメントができます。コメントと文字起こしは通話中だけ共有され、保存されません。

マイクとカメラを使うには HTTPS か localhost で接続してください。別のネットワーク間で通話する場合は TURN サーバーを設定します。

```dotenv
SPACES_ICE_SERVERS=[{"urls":"turn:turn.example.com:3478","username":"利用者名","credential":"パスワード"}]
```

`server/config.json` の `spaces.iceServers` にも書けますが、環境変数がある場合はそちらが優先されます。

## 9. 設定とデータベースを確認する

設定の不備を確認します。

```bash
npm run check:config
```

テーブル定義を更新したときは、データベースを更新します。

```bash
npm run migrate
```

詳しくは [マイグレーション](./migrations/README.md) を確認してください。
