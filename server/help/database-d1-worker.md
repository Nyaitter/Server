# Cloudflare D1設定ガイド

Cloudflare D1 を Nyaitter のデータベースとして使用する手順です。専用の接続プログラムを経由して安全に通信します。

## 1. D1 データベースの作成

```bash
cd workers/d1-proxy
npm install

# D1 データベースの新規作成
npx wrangler d1 create nyaitter-d1
```

画面に表示された `database_id` を `workers/d1-proxy/wrangler.toml` に記入します。

## 2. 認証トークンの設定

通信保護用のトークンを設定します。

```bash
# 安全なランダム文字列を入力
npx wrangler secret put AUTH_TOKEN
```

## 3. データベースの初期化とデプロイ

```bash
# リポジトリのルートへ戻る
cd ../..

# データベースの初期化
DB_ADAPTER=d1 npm run migrate

# Worker の公開
cd workers/d1-proxy
npm run deploy
```

## 4. サーバー本体の設定 (`server/.env`)

```dotenv
DB_ADAPTER=d1
D1_WORKER_URL=https://あなたのWorker名.workers.dev
D1_WORKER_TOKEN=手順2で設定したAUTH_TOKEN
```

---

- 関連: [D1 Proxy Worker ガイド](../../workers/d1-proxy/README.md) / [本番公開前チェックリスト](./production-checklist.md)

