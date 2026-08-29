# Cloudflare R2 設定ガイド

画像を Cloudflare R2に保存する設定です。画像転送量が多い場合や、サーバーレス運用に適しています。

## 1. 設定方法 (`server/.env`)

```dotenv
STORAGE_ADAPTER=r2
STORAGE_USER_QUOTA_MB=1024 # ユーザー1人あたりの上限 (1GB)

# Cloudflare R2 の接続情報
R2_ACCOUNT_ID=あなたのAccount ID
R2_BUCKET=バケット名
R2_ACCESS_KEY_ID=アクセスキーID
R2_SECRET_ACCESS_KEY=シークレットアクセスキー
R2_PUBLIC_DOMAIN=https://media.example.com # 公開カスタムドメイン
```

## 2. 動作のポイント

- `R2_PUBLIC_DOMAIN` を設定した場合、画像は直接 Cloudflare から配信され、サーバーの負荷を軽減できます。
- クライアント側の `userFileEndpoint` にも同じ公開ドメインを設定してください。

---

- 関連: [ローカル保存 設定ガイド](./storage-local.md) / [Cloudflare構成](./cloudflare-hybrid.md)

