# 本番公開前チェックリスト

サーバーを一般公開する前に、設定とバックアップを確認します。各項目の詳細はリンク先のガイドを参照してください。

## 設定

- [ ] `DB_ADAPTER` を `postgres` または `d1` にし、`npm run migrate` を実行した。`memory` のままでは再起動でデータが消える。
- [ ] Node.js を `22.23.4` 以上（または `24.22.1` 以上）にした。2026-10-21 の HIGH 脆弱性修正（Brotli RCE など）を含みます。Node.js 20 は 2026-07 に EOL のため使わない。
- [ ] `STORAGE_ADAPTER` と、保存先の設定を済ませた（[ローカル保存](./storage-local.md) / [Cloudflare R2](./storage-r2.md)）。
- [ ] `NODE_ENV=production` と `PUBLIC_URL`（公開する HTTPS URL）を設定した。
- [ ] リバースプロキシの背後で動かす場合は `TRUST_PROXY=true` を設定した。直接公開する場合は設定しない。
- [ ] `NYAITTER_CORS_ALLOWED_ORIGINS` に、公開する画面のオリジンだけを指定した。
- [ ] `npm run check:config` でエラーが出ない。
- [ ] サーバーを再起動し、ログイン、投稿、画像表示を確認した。

## セキュリティ

- [ ] `server/.env`、`server/data/`、`uploads/` を Git に含めていない。
- [ ] `D1_WORKER_TOKEN`、`LOGIN_SECURITY_HMAC_SECRET`、R2 のキー、SMTP のパスワードは推測できない値にした。
- [ ] HTTPS で公開し、パスキーを使う場合は `AUTH_PASSKEY_RP_ID` と `AUTH_PASSKEY_ORIGIN` を公開ドメインに合わせた。
- [ ] 不要なログイン方法を `false` にし、必要に応じて `*_ALLOW_SIGNUP` で新規登録を制限した。
- [ ] 管理用・テスト用のアカウントを削除した。
- [ ] R2 で画像を公開する場合はバケットを公開読み取りにし、アクセストークンには必要な権限だけを付けた。

## バックアップと監視

- [ ] データベースと画像の保存先を定期的にバックアップし、復元を 1 回試した。
- [ ] ディスク容量、プロセスの停止、エラーログを監視している。
- [ ] メール送信、プッシュ通知、TURN など外部サービスを使う場合は、本番の値で動作を確認した。

## AI を使う場合

- [ ] AI プロバイダーを登録し、起動ログでモデルの読み込みを確認した（[AI プロバイダー設定](./ai-providers.md)）。
- [ ] AutoMod の判定をテスト投稿で確認した（[AutoMod 設定ガイド](./automod.md)）。
