# 公開版デプロイ

このアプリはNodeサーバーとして公開できます。家族は発行されたURLを開き、同じ家族コードを設定して使います。

## 必須の環境変数

- `HOST=0.0.0.0`
- `OPENAI_API_KEY`: AI回答を使う場合のみ
- `OPENAI_MODEL=gpt-5-mini`
- `SUPABASE_URL`: Supabaseへ家族共有データを保存する場合
- `SUPABASE_SERVICE_ROLE_KEY`: Supabaseへ家族共有データを保存する場合。ブラウザには出さず、サーバー環境変数にだけ設定します。
- `SUPABASE_TABLE=home_care_shared_data`
- `APP_PASSWORD`: アプリを開くための共有パスワード。家族だけに共有してください。
- `SESSION_SECRET`: ログインセッション署名用。Renderでは自動生成できます。
- `DATA_DIR`: ファイル保存を使う場合の永続保存ディスクのパス

## Supabase無料枠

SupabaseのSQL Editorで次を実行します。

```sql
create table if not exists public.home_care_shared_data (
  family_hash text primary key,
  data jsonb not null default '{"manuals":[],"tasks":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.home_care_shared_data enable row level security;
```

Renderの環境変数に `SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` を設定すると、無料Renderでも家族共有データをSupabaseに永続保存できます。未設定の場合は従来通りファイル保存に戻ります。

## Render

1. このフォルダをGitHubリポジトリへアップロードします。
2. Renderで「New Blueprint」を選び、GitHubリポジトリを接続します。
3. `render.yaml` が読み込まれます。
4. `SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` をRenderの環境変数に設定します。
5. AI回答や写真読み取りを使う場合は `OPENAI_API_KEY` も設定します。
6. アプリをパスワード保護する場合は `APP_PASSWORD` を設定します。
7. Deploy後に発行される `https://...onrender.com` が家族共有URLです。

RenderはDockerfileからWebサービスをビルドできます。Blueprintは `render.yaml` でサービスや環境変数を定義します。

## Railway

1. GitHubリポジトリをRailwayへ接続します。
2. `railway.json` がデプロイ設定として使われます。
3. Variablesで `OPENAI_API_KEY`, `OPENAI_MODEL`, `DATA_DIR` を設定します。
4. 永続保存が必要なので、RailwayのVolumeを追加し、`DATA_DIR` をそのマウント先に合わせます。
5. Deploy後に発行されるRailway URLを家族で共有します。

## Fly.io

1. `flyctl launch --no-deploy` でアプリ名を確保します。
2. `fly.toml` の `app` を確保したアプリ名に合わせます。
3. `fly volumes create home_care_data --size 1 --region nrt` を実行します。
4. `fly secrets set OPENAI_API_KEY=...` を実行します。
5. `fly deploy` で公開します。

Fly.ioはDockerfileと `fly.toml` を使ってデプロイできます。公開URLは `https://<app名>.fly.dev` になります。

## VPS

VPSにNode 20以上を入れて、このフォルダを配置します。

```bash
export HOST=0.0.0.0
export PORT=4173
export DATA_DIR=/var/lib/home-care
export OPENAI_API_KEY=...
node server.js
```

実運用ではNginxやCaddyでHTTPS化し、`https://your-domain.example` から `localhost:4173` へリバースプロキシしてください。
