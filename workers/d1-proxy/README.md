# D1 Proxy Worker

Nyaitter サーバーが Cloudflare D1 と通信するための接続プログラムです。D1 を使う場合だけ必要です。

- 設定手順は [Cloudflare D1 設定ガイド](../../server/help/database-d1-worker.md) にまとめています。
- Worker の操作コマンド（`npm run dev` / `migrate:local` / `migrate:remote` / `deploy`）も同じガイドにあります。
- 設定は `wrangler.toml`、テーブル定義は `migrations/` にあります。
