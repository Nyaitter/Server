# Cloudflare R2 設定ガイド

画像を Cloudflare R2 に保存する手順です。複数サーバーで動かす場合や、画像・動画が多い場合に使います。

## 1. R2 を用意する

Cloudflare のダッシュボードで R2 バケットを作成し、S3 API 用のアクセストークンを発行します。次の値を控えます。

- Account ID
- バケット名
- Access Key ID
- Secret Access Key

## 2. 設定する（`server/.env`）

```dotenv
STORAGE_ADAPTER=r2
STORAGE_USER_QUOTA_MB=1024

R2_ACCOUNT_ID=あなたのAccount ID
R2_BUCKET=バケット名
R2_ACCESS_KEY_ID=アクセスキーID
R2_SECRET_ACCESS_KEY=シークレットアクセスキー
R2_PUBLIC_DOMAIN=https://media.example.com
```

`STORAGE_USER_QUOTA_MB` は 1 人あたりの保存上限（MB）です。`npm run check:config` で必須項目の不足を確認できます。

## 3. 画像の配信先を決める

`R2_PUBLIC_DOMAIN` を設定すると、画像は Cloudflare から直接配信され、URL も固定されます。バケットの公開読み取りを有効にし、`media.example.com` などのカスタムドメインを接続してください。

未設定の場合は 1 時間で切れる署名付き URL が返るため、外部に貼った画像が後から表示されません。公開するサーバーでは設定してください。

アクセストークンは対象バケットの読み書きに必要な権限だけを付け、`server/.env` を公開しないでください。
