# AI プロバイダー設定ガイド

AutoMod など AI を使う機能のために、利用するサービスを登録します。OpenAI や Google Gemini のほか、CLI ツール（Antigravity / Codex / OpenCode）も使えます。

## 1. 登録する（`server/.env`）

JSON 配列で書きます。

```dotenv
AI_PROVIDERS=[{"type":"openai","apikey":"API_KEY","defmodel":"gpt-6-sol"},{"type":"gemini","apikey":"API_KEY"}]

AI_MODEL_DB_PATH=data/models.json
AI_WORK_DIR=data/ai/requests
```

## 2. 使えるプロバイダー

| type | 内容 | 必要なキー | URL 指定 |
|---|---|---|---|
| `openai` | OpenAI 互換 API | `apikey` | ○ |
| `gemini` | Google Gemini | `apikey` | ○ |
| `antigravity` | CLI ツール | 不要 | × |
| `codex` | CLI ツール | 不要 | × |
| `opencode` | CLI ツール | 不要 | × |

### ID とモデル

- `id`: 省略すると `<type>:1`、`<type>:2` のように自動で付きます。
- `defmodel`: このプロバイダーの既定モデルです。AutoMod で指定しない場合に使われます。
- `roumodels`: このプロバイダーで使えるモデル名の一覧です（任意）。

`AI_MODEL_DB_PATH` はモデル一覧の保存先です。Cloudflare D1 を使っていても、このファイルはローカルのままで問題ありません。

## 3. 使うプロバイダーを選ぶ

`AUTOMOD_AI_PROVIDER` で指定します。

- `auto`: 登録順に最初のプロバイダーを使います。
- `openai`、`gemini`、`codex` など: 種類で指定します。
- 登録した `id`: 個別に指定します。

```dotenv
AUTOMOD_AI_PROVIDER=openai
```

## 4. 動作を確認する

1. `server/.env` にプロバイダーを登録します。
2. サーバーを起動するか、`npm run model:update` を実行します。
3. コンソールに `[ai] ModelDB updated: X providers, Y models` と出れば成功です。
4. 不適切な投稿をテストし、判定が動くことを確認します。

```bash
npm run check:config
```

## `server/config.json` で設定する

`.env` の代わりに `server/config.json` にも書けます。両方ある場合は `.env` が優先されます。

```json
{
  "ai": {
    "providers": [
      { "type": "openai", "apikey": "xxx", "defmodel": "gpt-6-sol" },
      { "type": "gemini", "apikey": "yyy" }
    ]
  },
  "autoMod": {
    "aiProvider": "auto",
    "prompt": "緩めに判断してください"
  }
}
```

## 関連ドキュメント

- [AutoMod 設定ガイド](./automod.md)
