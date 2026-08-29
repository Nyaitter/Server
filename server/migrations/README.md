# データベースの初期化・更新 (マイグレーション)

データベースに必要なテーブルを一括で作成・更新するコマンドです。

## 実行方法

`server/.env` にデータベースの設定を記入し、リポジトリのルートで実行します。

```bash
npm run migrate
```

## 各データベースでの設定例

| データベース | `server/.env` に必要な設定 |
|---|---|
| PostgreSQL | `DB_ADAPTER=postgres`<br>`DATABASE_URL=postgres://...` |
| Cloudflare D1 | `DB_ADAPTER=d1`<br>`D1_WORKER_URL=https://...`<br>`D1_WORKER_TOKEN=...` |

---

- 関連: [PostgreSQL 設定ガイド](../help/database-postgres.md) / [Cloudflare D1 設定ガイド](../help/database-d1-worker.md)

