# 拡張APIキー

Nditorなど、別のサービスからNyaitterAuthを利用するためのキーです。Serverを起動していない状態でもCLIで管理できます。

## 生成

Serverリポジトリで次を実行します。

```bash
node server/cli.js extension-key create --name Nditor --scope nyaitter-auth --redirect-origin http://localhost:3001 --redirect-origin http://127.0.0.1:3001 --output ../NditorScratch/data/secrets/nyaitter-extension-api-key
```

保存先に既存のファイルがある場合は上書きしません。`--output`を省略するとキーを一度だけ表示します。表示されたキーは再取得できません。

`--redirect-origin`には、Editorなどの利用先サービスのオリジンを指定してください。パスを含めず、必要なオリジンごとに繰り返して指定します。

## 一覧・失効

```bash
node server/cli.js extension-key list
node server/cli.js extension-key revoke <キーID>
```

失効はServerの再起動なしで反映されます。キーを交換する場合は新しいキーを生成して利用先へ配置したあと、古いキーを失効してください。

## nscli

Linux／Git Bashでは`./nscli`、PowerShellでは`./nscli.ps1`を使えます。

```bash
./nscli extension-key list
./nscli server status
```

```powershell
./nscli.ps1 extension-key list
```

PATHから`nscli`として呼び出す場合は、Serverリポジトリで`npm link`を実行します。`npm run nscli -- ...`も利用できます。

## 保存先と利用範囲

Serverはキーのハッシュを`server/data/secrets/extension-keys.json`に保存します。別の場所へ保存する場合は`NYAITTER_EXTENSION_KEYS_FILE`を設定します。相対パスは`server/`が基準です。

複数のServerを使う場合は、認証を受け付ける各Serverで同じキー台帳を利用してください。

`nyaitter-auth`スコープで利用できるAPIは次の3つです。`x-nyaitter-extension-key`ヘッダーにキーを指定します。

- `POST /server/internal/extensions/nyaitter-auth/initiate`
- `POST /server/internal/extensions/nyaitter-auth/token`
- `POST /server/internal/extensions/nyaitter-auth/userinfo`

認可にはユーザーの承認が必要です。利用できるユーザー権限は`profile:read`、`storage:access`、`continuous_access`で、別の拡張に発行されたユーザートークンは受け付けません。

Editorのクラウド保存には「ストレージへのアクセス」の許可が必要です。既に連携している場合は、再ログインして追加の権限を許可してください。
