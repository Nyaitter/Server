# AI プロバイダー設定ガイド

AutoMod など AI を使う機能のために、利用するサービスを登録します。

## 1. 登録する（`server/.env`）

JSON 配列で書きます。

```dotenv
AI_PROVIDERS=[{"type":"openai","apikey":"API_KEY","defmodel":"gpt-6-sol"},{"type":"gemini","apikey":"API_KEY"}]

AI_MODEL_DB_PATH=data/models.json
AI_WORK_DIR=data/ai/requests
```

`AI_MODEL_DB_PATH` はモデル一覧の保存先です。Cloudflare D1 を使っていてもローカルのままで問題ありません。

## 2. 使えるプロバイダー

| type | 内容 | 必要なキー | URL 指定 |
|---|---|---|---|
| `openai` | OpenAI 互換 API | `apikey` | ○ |
| `gemini` | Google Gemini | `apikey` | ○ |
| `antigravity` | CLI ツール | 不要 | × |
| `codex` | CLI ツール | 不要 | × |
| `opencode` | CLI ツール | 不要 | × |

### ID とモデル

- `id`: 省略すると `<type>:<登録順>` が自動で付きます。重複はできません。
- `defmodel`: このプロバイダーの既定モデルです。AutoMod で指定しない場合に使われます。
- `roumodels`: このプロバイダーで使えるモデル名の一覧です（任意）。
- `url`: OpenAI 互換 API や Gemini の接続先です（任意）。CLI ツールでは指定できません。

## 3. 使うプロバイダーを選ぶ

`AUTOMOD_AI_PROVIDER` で指定します。

- `auto`: 登録順に最初のプロバイダーを使います。
- `openai`、`gemini`、`codex` など: 種類で指定します。
- 登録した `id`: 個別に指定します。

```dotenv
AUTOMOD_AI_PROVIDER=openai
```

## 4. 動作を確認する

サーバーを起動するか `npm run model:update` を実行し、`[ai] ModelDB updated: X providers, Y models` と出れば設定は読み込まれています。`npm run check:config` で不足も確認できます。

## `server/config.json` で設定する

`.env` の代わりに `server/config.json` にも書けます。両方ある場合は `.env` が優先されます。

```json
{
  "ai": {
    "providers": [
      { "type": "openai", "apikey": "xxx", "defmodel": "gpt-6-sol" }
    ]
  },
  "autoMod": {
    "aiProvider": "auto",
    "prompt": "緩めに判断してください"
  }
}
```
