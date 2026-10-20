# Cloudflare 連携構成

Cloudflare のサービスと組み合わせて Nyaitter を動かす構成です。

| 構成 | データベース | ファイル保存 | 向いている場合 |
|---|---|---|---|
| D1 + R2（おすすめ） | `d1` | `r2` | すべて Cloudflare 上で管理したい。 |
| PostgreSQL + R2 | `postgres` | `r2` | PostgreSQL を使いつつ、画像は R2 に任せたい。 |

## 設定ガイド

- [Cloudflare D1 設定ガイド](./database-d1-worker.md)
- [Cloudflare R2 設定ガイド](./storage-r2.md)
- [本番公開前チェックリスト](./production-checklist.md)
