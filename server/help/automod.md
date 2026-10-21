# AutoMod 設定ガイド

AutoMod は投稿・画像を AI で判定し、不適切な内容に自動で処置を行います。先に [AI プロバイダー設定](./ai-providers.md) でサービスを登録してください。

## 設定する

`server/.env` に使うプロバイダーと判定基準を書き、サーバーを再起動します。

```dotenv
AUTOMOD_AI_PROVIDER=auto
# モデルを指定する場合だけ設定
# AUTOMOD_AI_MODEL=gpt-6-sol
AUTOMOD_PROMPT=基本的には緩めに判断してください。過度に不適切な場合のみ対応するようにしてください。
```

`auto` は登録順にプロバイダーを選びます。特定のサービスを使う場合は `openai`、`gemini`、`codex` など、登録した種類または `id` を指定します。モデルを省略するとプロバイダーの既定モデルが使われます。

`server/config.json` に書く場合は `autoMod.aiProvider`、`autoMod.aiModel`、`autoMod.prompt` を使います。環境変数がある場合はそちらが優先されます。

## コミュニティルールを反映する

ルートまたは `server/` の `rule.nd` を AutoMod が読み込み、規約に沿って判定します。別のファイルを使う場合は `RULES_FILE_PATH` で指定します。

## 判定と自動処置

判定は `<safe>`、`<low>`、`<middle>`、`<high>` の 4 段階です。危険度に応じて投稿の公開範囲やワンクッションが変わり、処置を行った場合は投稿者に通知が届きます。
