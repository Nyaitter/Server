# PostgreSQL 設定ガイド

PostgreSQL をデータベースとして使う手順です。

## 1. 接続先を設定する

`server/.env` に接続 URL を書きます。

```dotenv
DB_ADAPTER=postgres
DATABASE_URL=postgres://ユーザー名:パスワード@ホスト名:5432/データベース名?sslmode=require
```

パスワードに `@`、`:`、`/` などの記号を含む場合は URL エンコードしてください。

## 2. テーブルを作る

```bash
npm run migrate
```

## 3. 起動して確認する

```bash
npm start
```

ブラウザで <http://localhost:3000/> を開きます。設定の不備は `npm run check:config` でも確認できます。公開前は [本番公開前チェックリスト](./production-checklist.md) を確認してください。

## 補足: 検索用の索引

`npm run migrate` は、PostgreSQL で検索を速くするために `pg_trgm` の GIN 索引も作成します。`pg_trgm` を利用できない、または `CREATE EXTENSION` の権限がない環境では、索引作成だけをスキップし、移行は失敗しません。

索引を作成できたかは次の SQL で確認できます。

```sql
SELECT indexname FROM pg_indexes
WHERE tablename = 'posts' AND indexname LIKE '%trgm';
```

大人数のデータベースでは、索引作成中に対象テーブルへの書き込みが待たされます。書き込みが少ない時間帯に適用してください。詳しくは [データベースの初期化・更新](../migrations/README.md) を確認してください。
