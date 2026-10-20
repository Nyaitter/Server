# データベースの初期化・更新（マイグレーション）

必要なテーブルをまとめて作成・更新するコマンドです。

## 実行する

`server/.env` にデータベースを設定し、リポジトリのルートで実行します。

```bash
npm run migrate
```

## データベースごとの設定

| データベース | `server/.env` に書く内容 |
|---|---|
| PostgreSQL | `DB_ADAPTER=postgres`<br>`DATABASE_URL=postgres://...` |
| Cloudflare D1 | `DB_ADAPTER=d1`<br>`D1_WORKER_URL=https://...`<br>`D1_WORKER_TOKEN=...` |

## 関連ドキュメント

[PostgreSQL 設定ガイド](../help/database-postgres.md) / [Cloudflare D1 設定ガイド](../help/database-d1-worker.md)
