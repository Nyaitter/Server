# D1 Proxy Worker ガイド

Nyaitter サーバーが Cloudflare D1と安全に通信するためのプログラムです。

## セットアップ手順

### 1. D1 データベースの作成
```bash
cd workers/d1-proxy
npm install

# D1 データベースを作成
npx wrangler d1 create nyaitter-d1
```

表示された `database_id` を `wrangler.toml` の `database_id = "..."` に貼り付けます。

### 2. 通信用シークレットの設定
```bash
npx wrangler secret put AUTH_TOKEN
# 画面の指示に従い、安全なランダム文字列を入力します
```

### 3. データベースの初期化と公開
```bash
# データベースの初期化
cd ../..
DB_ADAPTER=d1 npm run migrate

# Worker のデプロイ
cd workers/d1-proxy
npm run deploy
```

### 4. サーバー本体への設定
```dotenv
DB_ADAPTER=d1
D1_WORKER_URL=https://あなたのWorker名.workers.dev
D1_WORKER_TOKEN=手順2で設定したAUTH_TOKEN
```

---

- 関連: [Cloudflare D1 設定ガイド](../../server/help/database-d1-worker.md)

