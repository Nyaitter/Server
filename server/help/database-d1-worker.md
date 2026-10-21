# Cloudflare D1 設定ガイド

Cloudflare D1 をデータベースとして使う手順です。専用の Worker を経由して通信します。Cloudflare アカウントと Node.js 20.9 以上が必要です。

## 1. D1 データベースを作る

```bash
cd workers/d1-proxy
npm install
npx wrangler login
npx wrangler d1 create nyaitter-d1
```

表示された `database_id` を `workers/d1-proxy/wrangler.toml` に書きます。

## 2. 認証トークンを設定する

```bash
npx wrangler secret put AUTH_TOKEN
```

安全なランダム文字列を入力します。この値は手順 4 の `D1_WORKER_TOKEN` に使用します。

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

`npm run check:config` で不備を確認できます。Worker の操作コマンドは [D1 Proxy Worker](../../workers/d1-proxy/README.md) にあります。

## 関連ドキュメント

[本番公開前チェックリスト](./production-checklist.md) / [Cloudflare 連携構成](./cloudflare-hybrid.md)
