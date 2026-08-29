# Nyaitter

Nyaitter は、Scratcher 向けのオープンソース SNS です。Webブラウザから使える画面と、アカウント管理やデータ配信を行うサーバーで構成されています。

| 区分 | 配置 | 内容 |
|---|---|---|
| NyaitterClient | `page/` | Web画面 |
| NyaitterServer | `server/` | サーバー本体 |
| D1 Proxy Worker | `workers/d1-proxy/` | Cloudflare D1を使う場合の接続用プログラム |

## 主な機能

投稿、返信、引用、リポスト、いいね、スター、検索、フォロー、通知、グループ機能、グループDM、プッシュ通知、各種ログインが使えます。

> ブロック関係にある利用者同士では、お互いの投稿・通知・DMメッセージが表示されず、DMへの追加も防ぎます。

## クイックスタート

Node.jsをインストールし、次のコマンドを実行します。

```bash
npm install
npm start
```

ブラウザで <http://localhost:3000/> を開くと利用できます。

サーバーの状態確認や起動・停止は、プロジェクト外からも次のCLIで実行できます。

```bash
/path/to/Server/NyaitterServerCLI server status
/path/to/Server/NyaitterServerCLI nmt status
```

このCLIは内部で`npm run cli`を実行します。

緊急メンテナンス中は、サーバーの起動を拒否できます。拒否中もエラー終了せず、警告だけを表示します。

```bash
/path/to/Server/NyaitterServerCLI maintenance enable
/path/to/Server/NyaitterServerCLI maintenance status
/path/to/Server/NyaitterServerCLI maintenance disable
```

解除後にサーバーを起動する場合は、`server start`またはPM2の再起動を実行してください。

初期状態ではデータが一時保存のため、サーバーを再起動するとデータが消えます。データを保存して本格的に運用する手順は `server/README.md` を確認してください。

## クライアント情報と接続先

Web画面の名前、製作者、リポジトリ、APIの接続先などは `page/manifest.json` で確認できます。接続先を変更する場合は、`api_url` を設定してください。

同じ項目を複数の場所で設定した場合は、サーバーが返す ServerStatus、`page/manifest.json`、`page/config.js` の順で優先されます。通常は `manifest.json` を変更し、`config.js` は予備の設定として使用します。

## ライセンス

MIT ライセンスです。著作権表示を残すことで、誰でも自由に利用・改変・再配布できます。詳細は `LICENSE` を確認してください。

## ドキュメント

- サーバーの起動・設定・運用: [`server/README.md`](./server/README.md)
- ログイン方法の設定: [`server/help/auth-providers.md`](./server/help/auth-providers.md)
- データの保存先の選び方: [`server/adapters/README.md`](./server/adapters/README.md)
- 各種セットアップガイド: [`server/help/README.md`](./server/help/README.md)
- 外部アプリ連携機能: [`server/help/nyaitter-auth.md`](./server/help/nyaitter-auth.md)
