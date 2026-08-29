# Cloudflare 連携構成

Cloudflare のサービスを Nyaitter と組み合わせて利用する構成です。

## 主な組み合わせパターン

| 構成 | データベース (`DB_ADAPTER`) | ファイル保存 (`STORAGE_ADAPTER`) | メリット |
|---|---|---|---|
| **D1 + R2 (おすすめ)** | `d1` | `r2` | データベースも画像保存もすべて Cloudflare 上で管理できます。 |
| **PostgreSQL + R2** | `postgres` | `r2` | 安定したPostgreSQLを使いつつ、重い画像データのみ R2 に逃がせます。 |

## 各機能の個別設定ガイド

- データベース設定: [Cloudflare D1 設定ガイド](./database-d1-worker.md)
- 画像保存設定: [Cloudflare R2 設定ガイド](./storage-r2.md)
- 本番運用前の確認: [本番公開前チェックリスト](./production-checklist.md)

