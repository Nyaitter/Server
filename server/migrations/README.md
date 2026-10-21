# データベースの初期化・更新（マイグレーション）

`server/migrations/` の SQL を順番に適用します。適用済みのファイルは記録され、再実行されません。

## 実行する

`server/.env` にデータベースを設定し、リポジトリのルートで実行します。

```bash
npm run migrate
```

実行前にデータベースをバックアップしてください。PostgreSQL で特定のファイルだけ適用する場合は `npm run migrate -- --only <ファイル名>` を使います。

## データベースごとの設定

| データベース | `server/.env` に書く内容 |
|---|---|
| PostgreSQL | `DB_ADAPTER=postgres`<br>`DATABASE_URL=postgres://...` |
| Cloudflare D1 | `DB_ADAPTER=d1`<br>`D1_WORKER_URL=https://...`<br>`D1_WORKER_TOKEN=...` |

D1 では `workers/d1-proxy` で `npm install` を済ませてください。適用先は既定でリモートです。ローカルの D1 に適用する場合は `D1_MIGRATION_TARGET=local` を設定します。
