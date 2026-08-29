# ローカル保存

サーバー本体のフォルダに画像を保存する方法です。サーバー1台でシンプルに動かす場合に適しています。

## 1. 設定方法 (`server/.env`)

```dotenv
STORAGE_ADAPTER=local
STORAGE_USER_QUOTA_MB=1024 # ユーザー1人あたりの上限 (1GB)
```

## 2. 動作のポイント

- 画像は自動的に圧縮・縮小され、位置情報は削除されます。
- 保存先フォルダはサーバー起動時に自動で作成されます。

---

- 関連: [Cloudflare R2 設定ガイド](./storage-r2.md) / [保存先の選び方](./adapters-overview.md)

