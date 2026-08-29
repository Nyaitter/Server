# 保存先の選び方

Nyaitter は「データベース」と「ファイル保存先」を自由に組み合わせて設定できます。

## 1. データベースの選び方 (`DB_ADAPTER`)

| 設定値 | 保存先 | 特徴 |
|---|---|---|
| `DB_ADAPTER=memory` | メモリ | 設定不要ですぐ動かせます。サーバーを再起動するとデータは消えます。 |
| `DB_ADAPTER=postgres` | PostgreSQL | 最も標準的で安定したデータベースです。 |
| `DB_ADAPTER=d1` | Cloudflare D1 | Cloudflare のインフラでサーバーレス運用したい場合に使用します。 |

> データベースを設定した後は、必ず `npm run migrate` を実行して初期化してください。

## 2. ファイル保存先の選び方 (`STORAGE_ADAPTER`)

| 設定値 | 保存先 | 特徴 |
|---|---|---|
| `STORAGE_ADAPTER=local` | サーバー本体のディスク | サーバー1台で動かす場合に簡単です。 |
| `STORAGE_ADAPTER=r2` | Cloudflare R2 | 複数サーバー構成や、大量の画像・動画を扱う場合に適しています。 |

## 関連ドキュメント

- [PostgreSQL 設定ガイド](./database-postgres.md)
- [Cloudflare D1 設定ガイド](./database-d1-worker.md)
- [ローカル保存 設定ガイド](./storage-local.md)
- [Cloudflare R2 設定ガイド](./storage-r2.md)

