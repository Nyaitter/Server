# AutoMod設定ガイド

AutoMod は、ルール違反や不適切な投稿・画像を AI が自動で見分ける機能です。モデレーターの負担を軽減し、コミュニティの安全を保つために使います。

OpenAI 互換 API や Google Gemini が利用できます。

---

## 設定手順

`server/.env` に以下の設定を追加して、サーバーを再起動します。

### 1. OpenAI または OpenAI 互換サービスを使う場合

OpenAI、Groq、OpenRouter、ローカル LLMを使う場合の設定です。

```dotenv
# API キー
AUTOMOD_API_KEY=sk-...

# モデル名
AUTOMOD_MODEL=gpt-4o-mini

# 判定基準
AUTOMOD_PROMPT=基本的には緩めに判断してください。過度に不適切な場合のみ対応するようにしてください。

# 互換エンドポイント
# AUTOMOD_ENDPOINT=https://api.openai.com/v1
```

### 2. Google Gemini を使う場合

Google AI Studio で取得した API キーを使う場合の設定です。

```dotenv
AUTOMOD_API_KEY=あなたのGemini_APIキー
AUTOMOD_MODEL=gemini-2.5-flash-lite
AUTOMOD_PROMPT=基本的には緩めに判断してください。過度に不適切な場合のみ対応するようにしてください。
```

---

## コミュニティルールの自動適用

サーバーのルートまたは `server/` にルールファイルが置かれている場合、AutoMod はそのルール全文を自動で読み込み、コミュニティの規約に沿って判定を行います。

---

## 判定と自動処置

AI の判定結果に応じて、投稿に対して自動で次の対応が行われます。

| 判定レベル | 処置 |
|---|---|
| `<safe>` (安全) | 通常通り公開されます。 |
| `<low>` (軽度) | 投稿に**ワンクッション**が付与されます。 |
| `<middle>` (中度) | 投稿が**限定公開**に変更されます。 |
| `<high>` (高度) | 投稿が**限定公開かつワンクッション**に変更されます。 |

処置が行われた場合、投稿者にその旨の通知が自動送信されます。
