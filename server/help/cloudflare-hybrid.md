# Cloudflare 連携構成

Cloudflare のサービスと組み合わせて Nyaitter を動かす場合の構成例です。

| 構成 | データベース | ファイル保存 |
|---|---|---|
| D1 + R2 | `d1` | `r2` |
| PostgreSQL + R2 | `postgres` | `r2` |

## 設定ガイド

- [Cloudflare D1 設定ガイド](./database-d1-worker.md)
- [Cloudflare R2 設定ガイド](./storage-r2.md)
- [本番公開前チェックリスト](./production-checklist.md)
