# 家の管理アプリ

紙の取扱説明書、写真、PDF、メモから読み取った情報を保存し、困りごと検索と定期メンテナンス予定を管理するiPhone向けブラウザアプリです。

## 使い方

`index.html` をブラウザで開くと使えます。データはブラウザのローカル保存領域に保存されます。

iPhoneでは「共有」からホーム画面へ追加すると、アプリのように起動できます。

家族共有を使う場合は `server.js` で起動し、家族全員が同じURLと家族コードを使います。公開版ではOpenAI APIキーを端末に保存せず、サーバー環境変数で管理します。

写真やPDFの元ファイルは、家族コードが設定されSupabase Storageが使える場合だけ保存します。AIで読み取った本文、設備名、場所、分類、タグ、手順、メモは取説データとして保存し、困りごと回答の根拠に使います。

## 公開版の起動

ローカルで確認する場合:

```bash
npm start
```

Dockerで公開サーバーへ載せる場合:

```bash
docker build -t home-care-family-app .
docker run -p 4173:4173 -e OPENAI_API_KEY=... -v home-care-data:/app/data -e DATA_DIR=/app/data home-care-family-app
```

外部公開サーバーでは、次の環境変数を設定します。

- `HOST=0.0.0.0`
- `PORT`: ホスティング側が指定するポート
- `OPENAI_API_KEY`: AI回答を使う場合
- `OPENAI_MODEL=gpt-5-mini`
- `DATA_DIR`: 共有データを保存する永続ディスクのパス。無料Render構成では未設定のため、サーバー再起動時に共有データが消える可能性があります。
- `SUPABASE_URL`: SupabaseプロジェクトURL。設定すると家族共有データをSupabaseへ保存します。
- `SUPABASE_SERVICE_ROLE_KEY`: Supabaseのservice_role key。サーバー環境変数にだけ設定します。
- `SUPABASE_TABLE=home_care_shared_data`
- `SUPABASE_BUCKET=home-care-sources`: 写真やPDFの原本を保存するSupabase Storageバケット名
- `APP_PASSWORD`: アプリを開くための共有パスワード。未設定ならログイン画面は出ません。
- `SESSION_SECRET`: ログインセッション署名用のランダム文字列。Renderでは自動生成できます。

家族は同じ公開URLを開き、「データ管理」の家族共有で同じ家族コードを設定します。

## Supabase無料枠で共有データを保存

Supabaseで新規プロジェクトを作り、SQL Editorで次を実行します。

```sql
create table if not exists public.home_care_shared_data (
  family_hash text primary key,
  data jsonb not null default '{"manuals":[],"tasks":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.home_care_shared_data enable row level security;
```

Renderの環境変数に `SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` を設定すると、家族共有の保存先がSupabaseになります。service_role keyはブラウザには送られず、Renderサーバー内だけで使います。

写真やPDFの原本保存にはSupabase Storageを使います。アプリは `SUPABASE_BUCKET` のバケットを自動作成し、家族コードごとのフォルダに保存します。

Render / Railway / Fly.io / VPSへの公開手順は [DEPLOY.md](/Users/yokotatomoaki/Documents/家の管理/DEPLOY.md) にまとめています。

## できること

- 取説データの登録、一覧、削除
- 登録済み取説とメンテ予定の編集、削除
- カメラで紙の取説を複数枚まとめて撮影し、AI設定済みなら要点を抽出
- PDF、テキスト、CSV、JSON、Markdownをソースとして追加
- 場所、分類、タグをAIが仮入力し、後から手動で修正
- 写真やPDFの原本をSupabase Storageへ保存し、AI回答には読み取り本文を利用
- 困りごとを入力して、登録済み取説だけを根拠にした解決方法を表示
- AIが必要と判断した場合は、確認手順を図解フローで表示
- 掃除、点検、交換、連絡の予定登録
- ダッシュボードと月間カレンダーで予定を確認
- 完了した予定は周期に応じて次回日を自動更新
- 今日・期限切れの予定をブラウザ通知
- 家族コードによる共有データの取り込み、保存、自動同期、新しい更新の優先
- パスワードによるアプリ保護
- JSONでバックアップと復元

## 今後の拡張候補

- 家族ごとのログイン機能
- AI APIを使った自然文検索の高精度化
