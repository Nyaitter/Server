# ローカル保存 設定ガイド

画像をサーバー本体のフォルダに保存する方法です。サーバー 1 台で動かす場合に向いています。

## 1. 設定する（`server/.env`）

```dotenv
STORAGE_ADAPTER=local
STORAGE_USER_QUOTA_MB=1024
```

`STORAGE_USER_QUOTA_MB` は 1 人あたりの保存上限（MB）です。

## 2. 保存のしくみ

- 画像は自動で圧縮・縮小され、位置情報は削除されます。
- 保存先フォルダはサーバー起動時に自動で作られます。

## 関連ドキュメント

[Cloudflare R2 設定ガイド](./storage-r2.md) / [保存先の選び方](./adapters-overview.md)
