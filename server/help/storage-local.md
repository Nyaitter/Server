# ローカル保存 設定ガイド

画像をサーバー本体のディスクに保存する方法です。サーバー 1 台で運用する場合に使います。

## 設定する（`server/.env`）

```dotenv
STORAGE_ADAPTER=local
STORAGE_USER_QUOTA_MB=1024
```

- `STORAGE_USER_QUOTA_MB` は 1 人あたりの保存上限（MB）です。
- 保存先は既定でリポジトリ直下の `uploads/` です。変える場合は `server/config.json` の `storage.local.uploadDir` を設定します。

## 注意

- サーバーを動かすユーザーが、保存先に書き込める必要があります。
- サーバーを移行・削除する前に `uploads/` をバックアップしてください。データベースだけを戻しても画像は復元できません。
- 複数サーバーで同じ画像を扱う場合は、共有ディスクがある場合を除き [Cloudflare R2 設定ガイド](./storage-r2.md) を使ってください。
