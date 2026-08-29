# Nyaitter サーバー設定ガイド

Nyaitter のデータ保存、アカウント管理、通知、投稿配信を行うサーバーです。

## すぐに動かす手順

1. 必要なファイルを準備します。
```bash
npm install
cp server/.env.example server/.env
```

2. サーバーを起動します。
```bash
npm start
```

ブラウザで `http://localhost:3000/` を開くと使えます。

---

## 主な設定 (`server/.env`)

設定を変更したい場合は `server/.env` の文字を書き換えて、サーバーを再起動します。

### 1. Discord や SNS で投稿を見やすく表示する (共有リンク)
Discord などに投稿リンクを貼ったとき、投稿の文章や画像がカード形式で綺麗に表示されるようにします。

```dotenv
# サーバーが動いているポート番号
POST_SHARE_PORT=3000
```

### 2. データをずっと保存する (データベース)
初期状態ではサーバーを止めるとデータが消えます。ずっと残すには PostgreSQL を使います。

```dotenv
DB_ADAPTER=postgres
DATABASE_URL=postgresql://ユーザー名:パスワード@ホスト名:5432/データベース名?sslmode=require
```

設定したら、次のコマンドでデータを保存する準備をします。
```bash
npm run migrate
```

### 3. 画像やファイルの保存先
```dotenv
# サーバー本体に保存する場合
STORAGE_ADAPTER=local

# 1人あたりの画像保存上限
STORAGE_USER_QUOTA_MB=512
```

### 4. ログイン方法の切り替え
使いたいログイン方法を `true`、使わないものを `false` にします。

```dotenv
AUTH_METHOD_SCRATCH_ENABLED=true  # Scratch認証
AUTH_METHOD_PASSKEY_ENABLED=true  # パスキー
AUTH_METHOD_EMAIL_ENABLED=false   # メール認証
```

### 5. AI による不適切な投稿の自動チェック (AutoMod)
AIを使って、ルール違反や不適切な投稿を自動で見分けます。

```dotenv
AUTOMOD_API_KEY=あなたのAPIキー
AUTOMOD_MODEL=gpt-4o-mini
AUTOMOD_PROMPT=基本的には緩めに判断してください。過度に不適切な場合のみ対応するようにしてください。
```

※ コミュニティルールが設定されている場合は、AI が自動でそのルールも読み込んで判定します。詳しい設定は [`server/help/automod.md`](./help/automod.md) を確認してください。

---

## 設定に間違いがないか確認する
次のコマンドを実行すると、設定が正しくできているか自動でチェックできます。

```bash
npm run check:config
```
