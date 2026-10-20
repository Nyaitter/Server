# データ保存先と画像保存先

投稿などのデータと、画像などのファイルは、用途に合わせて保存先を選べます。詳しくは [保存先の選び方](../help/adapters-overview.md) を確認してください。

## 設定例（`server/.env`）

```dotenv
# データベース（推奨: postgres）
DB_ADAPTER=postgres
DATABASE_URL=postgresql://ユーザー名:パスワード@ホスト名:5432/データベース名?sslmode=require

# ファイル保存先（local または r2）
STORAGE_ADAPTER=r2
STORAGE_USER_QUOTA_MB=1024
```
