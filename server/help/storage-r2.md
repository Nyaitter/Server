# Cloudflare R2 設定ガイド

画像を Cloudflare R2 に保存する手順です。画像が多かったり、複数サーバーで動かしたりする場合に向いています。

## 1. 設定する（`server/.env`）

```dotenv
STORAGE_ADAPTER=r2
STORAGE_USER_QUOTA_MB=1024

R2_ACCOUNT_ID=あなたのAccount ID
R2_BUCKET=バケット名
R2_ACCESS_KEY_ID=アクセスキーID
R2_SECRET_ACCESS_KEY=シークレットアクセスキー
R2_PUBLIC_DOMAIN=https://media.example.com
```

`STORAGE_USER_QUOTA_MB` は 1 人あたりの保存上限（MB）です。

## 2. 画像の配信先を分ける（任意）

`R2_PUBLIC_DOMAIN` を設定すると、画像は Cloudflare から直接配信され、サーバーの負担が減ります。

配信先を分ける場合は、`NYAITTER_USER_FILES_ENDPOINT` にも同じ URL を設定してください。Web 画面側は `page/manifest.json` の `user_file_endpoint` でも指定できます。

## 関連ドキュメント

[ローカル保存 設定ガイド](./storage-local.md) / [Cloudflare 連携構成](./cloudflare-hybrid.md)
