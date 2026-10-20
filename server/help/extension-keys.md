# 拡張 API キー

別のサービスから NyaitterAuth を使うためのキーです。CLI で管理でき、サーバーを起動していなくても作成・失効できます。

## キーを作る

`--name` は利用するサービス名、`--redirect-origin` は利用先のオリジン（パスなし）です。利用先が複数ある場合は繰り返します。

```bash
node server/cli.js extension-key create --name MyService --scope nyaitter-auth \
  --redirect-origin http://localhost:3001 \
  --output /path/to/myservice/secrets/nyaitter-extension-api-key
```

- `--output` を省略すると、キーを 1 回だけ画面に表示します。後から再取得はできません。
- 保存先にファイルが既にある場合は上書きしません。

## 一覧と失効

```bash
node server/cli.js extension-key list
node server/cli.js extension-key revoke <キーID>
```

失効はサーバーの再起動なしで反映されます。キーを変えるときは、新しいキーを利用先に置いてから古いキーを失効してください。

`nscli` でも同じ操作ができます（Linux / Git Bash は `./nscli`、PowerShell は `./nscli.ps1`）。

```bash
./nscli extension-key list
./nscli server status
```

## 保存先

キーのハッシュは `server/data/secrets/extension-keys.json` に保存されます。場所を変える場合は `NYAITTER_EXTENSION_KEYS_FILE` を設定します（相対パスは `server/` が基準）。複数のサーバーで使う場合は、各サーバーに同じキー台帳を参照させてください。

## `nyaitter-auth` スコープで使える API

ヘッダー `x-nyaitter-extension-key` にキーを指定します。

| 用途 | メソッドとパス | できること |
|---|---|---|
| 認可の開始 | `POST /server/internal/extensions/nyaitter-auth/initiate` | 認可セッションを開始 |
| コード交換 | `POST /server/internal/extensions/nyaitter-auth/token` | `code` をユーザー情報とトークンに交換 |
| ユーザー情報取得 | `GET /server/internal/extensions/nyaitter-auth/userinfo` | トークンのユーザー情報を取得 |

認可にはユーザーの承認が必要です。使える権限は `profile:read`、`storage:access`、`continuous_access` です。他の拡張に発行されたユーザートークンは使えません。ストレージへの書き込みには `storage:access` の許可が必要です（連携済みの場合は再ログインして許可してください）。

## 関連ドキュメント

- [NyaitterAuth ガイド](./nyaitter-auth.md)
