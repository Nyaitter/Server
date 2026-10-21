# D1 Proxy Worker

Nyaitter サーバーと Cloudflare D1 の間を中継する Worker です。D1 を使う場合だけ必要です。

## 設定

1. このディレクトリで `npm install` を実行します。
2. `wrangler.toml` の `database_id` を、作成した D1 データベースの ID に置き換えます。
3. `npx wrangler secret put AUTH_TOKEN` で、十分に長いランダム文字列を設定します。未設定の場合、Worker はすべてのリクエストを拒否します。
4. Nyaitter サーバーの `D1_WORKER_TOKEN` に、手順 3 と同じ値を設定します。

詳しい手順は [Cloudflare D1 設定ガイド](../../server/help/database-d1-worker.md) にあります。

## コマンド

```bash
npm run dev
npm run migrate:local
npm run migrate:remote
npm run deploy
```

設定は `wrangler.toml`、テーブル定義は `migrations/` にあります。
