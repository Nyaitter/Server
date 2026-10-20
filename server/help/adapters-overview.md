# 保存先の選び方

データベースとファイルの保存先は、自由に組み合わせられます。

## データベース（`DB_ADAPTER`）

| 設定値 | 保存先 | こんな場合に使う |
|---|---|---|
| `memory` | メモリ | すぐ試したい。サーバーを再起動するとデータは消えます。 |
| `postgres` | PostgreSQL | 安定して運用したい。 |
| `d1` | Cloudflare D1 | Cloudflare 上で運用したい。 |

データベースを設定したら、必ず `npm run migrate` を実行してください。

## ファイル保存先（`STORAGE_ADAPTER`）

| 設定値 | 保存先 | こんな場合に使う |
|---|---|---|
| `local` | サーバー本体のディスク | サーバー 1 台で動かしたい。 |
| `r2` | Cloudflare R2 | 複数サーバーで動かしたい。画像や動画が多い。 |

## 関連ドキュメント

- [PostgreSQL 設定ガイド](./database-postgres.md)
- [Cloudflare D1 設定ガイド](./database-d1-worker.md)
- [ローカル保存 設定ガイド](./storage-local.md)
- [Cloudflare R2 設定ガイド](./storage-r2.md)
