# Nyaitter

Scratcher 向けのオープンソース SNS です。ブラウザで使う画面と、アカウント・投稿・通知を管理するサーバーで構成されています。

| 配置 | 内容 |
|---|---|
| `page/` | Web 画面 |
| `server/` | サーバー本体 |
| `workers/d1-proxy/` | Cloudflare D1 を使う場合の接続プログラム |

## できること

投稿、返信、引用、リポスト、いいね、スター、検索、フォロー、通知、グループ、グループ DM、プッシュ通知、各種ログインが使えます。

ブロック中の相手とは、投稿・通知・DM が表示されません。DM への追加もできません。

## 使い始める

Node.js を用意し、次を実行します。

```bash
npm install
npm start
```

ブラウザで <http://localhost:3000/> を開くと使えます。

初期状態ではデータが一時保存のため、サーバーを再起動すると消えます。データを残す方法は [`server/README.md`](./server/README.md) を確認してください。

## サーバーを操作する

プロジェクトの外からも CLI で起動状態を確認できます。

```bash
/path/to/Server/nscli server status
```

PowerShell では `./nscli.ps1` を使います。`npm link` を実行すると `nscli` を直接呼べます。

### メンテナンス

緊急時はサーバーの起動を拒否できます。拒否中もエラー終了せず、警告だけを表示します。

```bash
/path/to/Server/nscli maintenance enable
/path/to/Server/nscli maintenance status
/path/to/Server/nscli maintenance disable
```

解除後は `server start` または PM2 の再起動を行います。

### 連携キー

Nditor などの連携キーは `nscli extension-key create` で発行できます。詳しくは [拡張 API キー](server/help/extension-keys.md) を確認してください。

## 画面の設定

Web 画面の名前、製作者、API の接続先は `page/manifest.json` で変更できます。接続先は `api_url` に設定します。

同じ項目が複数ある場合は、ServerStatus、`page/manifest.json`、`page/config.js` の順で使われます。通常は `manifest.json` を変更してください。

## ライセンス

MIT ライセンスです。著作権表示を残せば、自由に利用・改変・再配布できます。詳しくは `LICENSE` を確認してください。

## ドキュメント

- [サーバーの起動・設定・運用](./server/README.md)
- [セットアップガイド一覧](./server/help/README.md)
