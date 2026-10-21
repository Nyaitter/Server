# データ保存先と画像保存先

投稿などのデータと画像の保存先は個別に選べます。詳しくは [保存先の選び方](../help/adapters-overview.md) を参照してください。

## 設定例（`server/.env`）

```dotenv
DB_ADAPTER=postgres
DATABASE_URL=postgresql://ユーザー名:パスワード@ホスト名:5432/データベース名?sslmode=require

STORAGE_ADAPTER=r2
STORAGE_USER_QUOTA_MB=1024
```
