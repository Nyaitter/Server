# Nyaitter

Scratcher 向けのオープンソース SNS です。ブラウザで使う画面と、アカウント・投稿・通知を管理するサーバーで構成されています。

## 構成

| 配置 | 内容 |
|---|---|
| `page/` | Web 画面 |
| `server/` | サーバー本体 |
| `workers/d1-proxy/` | Cloudflare D1 を使う場合の接続プログラム |

## 最短起動

Node.js 22.23.4 以上を用意し、リポジトリのルートで実行します。

```bash
npm install
npm start
```

ブラウザで <http://localhost:3000/> を開きます。

初期状態のデータはメモリに保存されるため、再起動すると消えます。データを残す場合は `server/.env.example` を `server/.env` にコピーし、データベースを設定してください。

## 画面の設定

画面名・製作者・API 接続先は `page/manifest.json` で変更します。接続先は `api_url` です。同じ項目が複数ある場合は ServerStatus、`page/manifest.json`、`page/config.js` の順で使われます。

## ドキュメント

- [サーバーの起動・設定・運用](./server/README.md)
- [セットアップ・運用ガイド一覧](./server/help/README.md)
- [拡張 API キー](./server/help/extension-keys.md)

## ライセンス

MIT ライセンスです。`LICENSE` を確認してください。
