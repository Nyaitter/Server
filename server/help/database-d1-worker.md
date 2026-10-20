# Cloudflare D1 設定ガイド

Cloudflare D1 をデータベースとして使う手順です。専用の接続プログラム（Worker）を経由して通信します。

## 1. D1 データベースを作る

```bash
cd workers/d1-proxy
npm install
npx wrangler d1 create nyaitter-d1
```

表示された `database_id` を `workers/d1-proxy/wrangler.toml` に書きます。

## 2. 認証トークンを設定する

```bash
npx wrangler secret put AUTH_TOKEN
```

安全なランダム文字列を入力してください。

## 3. テーブルを作り、Worker を公開する

```bash
cd ../..
DB_ADAPTER=d1 npm run migrate
cd workers/d1-proxy
npm run deploy
```

## 4. サーバーに接続先を設定する

`server/.env` に次を書きます。

```dotenv
DB_ADAPTER=d1
D1_WORKER_URL=https://あなたのWorker名.workers.dev
D1_WORKER_TOKEN=手順2で設定したAUTH_TOKEN
```

`npm run check:config` で不備がないか確認できます。

## 開発時の Worker 操作

`workers/d1-proxy` で次のコマンドを使えます。

```bash
npm run dev
npm run migrate:local
npm run migrate:remote
```

## 関連ドキュメント

[D1 Proxy Worker の説明](../../workers/d1-proxy/README.md) / [本番公開前チェックリスト](./production-checklist.md) / [Cloudflare 連携構成](./cloudflare-hybrid.md)
