# PostgreSQL 設定ガイド

PostgreSQL をデータベースとして使う手順です。安定して運用したい場合に向いています。

## 1. 接続先を設定する

`server/.env` に接続 URL を書きます。

```dotenv
DB_ADAPTER=postgres
DATABASE_URL=postgres://ユーザー名:パスワード@ホスト名:5432/データベース名?sslmode=require
```

## 2. テーブルを作る

```bash
npm run migrate
```

## 3. 起動して確認する

```bash
npm start
```

ブラウザで <http://localhost:3000/> を開きます。設定の不備は `npm run check:config` でも確認できます。

## 関連ドキュメント

[保存先の選び方](./adapters-overview.md) / [Cloudflare R2 設定ガイド](./storage-r2.md) / [本番公開前チェックリスト](./production-checklist.md)
