# IMPLEMENTATION_PLAN

CLAUDE.md の "Implementation Strategy" に定めるマイルストーン順序に従う。各マイルストーンは単独で
レビュー・マージでき、終わった時点で「動くもの」が増える。前のマイルストーンが十分に動くまで次に進まない。

## 0. 進め方の原則

1. **順序**: バックエンド基盤 → 同期 → Desktop → iOS → APNs → Android → FCM → メッセージ機能 →
   添付と検索 → 運用。全機能を 1 タスクで作ろうとしない。
2. 完了条件は「テストが通る」と「手で操作して確認できる」の両方を含む。動くと主張する前に、
   テストできるものは必ずテストする。
3. 各マイルストーンの終わりに必ず実行する:
   - backend: `uv run pytest`、`uv run mypy`、`uv run ruff check`
   - desktop: `tsc --noEmit`、テスト、必要に応じて `tauri build`
   - iOS: `xcodebuild` でビルドが通る
   - Android: `./gradlew build` (lint / test を含む) が通る
   - `openapi/openapi.json` (M2 以降は `ws-events.json` も) を再生成して差分を確認、関連 docs の更新、
     マイグレーションの `downgrade` 確認
   - 既知のビルド失敗を残さない。やむを得ず残す場合は明記する。
4. 先回りしない。Redis 用の抽象は `EventBus` の Protocol 以上に作らない。使わないテーブル・列・
   ディレクトリは作らない。流行っているだけの依存を足さない。
5. `docs/` に書かれた設計判断を黙って変えない。問題があれば説明し、docs と実装を同時に更新する。
6. 1 マイルストーンは目安 1〜2 週間。大きければ a / b / c に分割する (M8、M9)。

## 1. マイルストーン一覧

状況 (2026-09-26): M0〜M10 をすべて実装し、各マイルストーンの検証 (サーバ 124 テスト、Desktop 34、iOS 29、
Android 30、compose 上の通し確認、復元リハーサル) を通した。残りはユーザー側の確認事項 (iOS 実機のプッシュと会話、
Firebase プロジェクトの設定、GitHub への push と CI、本番デプロイ) と「バックログ」の項目。

| # | 名前 | 内容 | 完了条件 |
| --- | --- | --- | --- |
| M0 | 設計 | 設計文書、ディレクトリ構造 (完了) | docs が CLAUDE.md と整合している |
| M1 | バックエンド基盤 | PostgreSQL、認証、users、channels、channel membership、メッセージ作成・取得 | **完了 (2026-09-26)**。テストクライアントがログインし、投稿し、PostgreSQL に保存され、取得できる。pytest 57 件、mypy、ruff、compose 上の curl による通し確認 (管理者作成 → メンバー作成 → 仮パスワード変更の強制 → チャンネル作成・参加 → 投稿と冪等再送 → 履歴 → 非メンバー 403 → refresh 回転と再利用検知 → logout) がすべて成功 |
| M2 | 信頼できる同期 | channel sequence と idempotency の保証、outbox、WebSocket、再接続同期、bootstrap | **完了 (2026-09-26)**。outbox + Relay (LISTEN/NOTIFY)、InMemoryEventBus、WebSocket Hub、差分 API、bootstrap、ws-events.json。pytest 75 件 (実 uvicorn + WebSocket の統合テスト、SYNC_PROTOCOL §13 の契約フィクスチャ 1/2/3/5/6/8/9 を参照クライアントで実行) がすべて成功 |
| M3 | Desktop クライアント | login、channel list、message list、send、リアルタイム更新 | **実装済み (2026-09-26)**: Tauri 2 + React + TS、SQLite ストア、Keychain、SYNC_PROTOCOL の同期エンジン、DM 通知、契約フィクスチャ 7 本と実サーバに対するライブテストが通過。macOS で `tauri build` 済み。Windows ビルドは CI (windows runner) で行う |
| M4 | iOS クライアント | login、channel list、messages、send、リアルタイム同期 | **実装済み (2026-09-26)**: SwiftUI、Keychain、SQLite3 ラッパ、Desktop と同じ同期エンジン、契約フィクスチャ 7 本と実サーバに対するライブテスト (シミュレータ) が通過。実機での通し確認は Xcode からのインストール後に行う |
| M5 | APNs | 端末登録、プッシュトークン登録、配送、通知処理、通知後の同期 | **実装済み (2026-09-26)**: `push_deliveries` / `notification_preferences`、PushPlanner (outbox ハンドラ)、PushSender (リース・backoff・期限)、`APNsPushProvider` (.p8)、通知設定 API、端末のトークン登録、`push-test` CLI、iOS の登録と通知処理。実機での受信確認は端末登録後に行う |
| M6 | Android クライアント | login、channel list、messages、send、同期 | **実装済み (2026-09-26)**: Kotlin / Compose、Room (JSON blob 行)、Keystore + DataStore、OkHttp WebSocket、Desktop / iOS と同じ同期エンジン、契約フィクスチャ 7 本と実サーバに対するライブテスト (JVM、実トランスポート) が通過。`assembleDebug` / Lint / JUnit が緑。エミュレータでの会話確認は下記 |
| M7 | FCM | 端末登録、トークン処理、配送 | **実装済み (2026-09-26)**: `FCMPushProvider` (HTTP v1、サービスアカウントの JWT bearer grant、data-only、応答対応表のテスト)、compose の鍵マウント、Android の `FirebaseMessagingService` / `PushCenter` (トークン登録・更新、通知の組み立て、タップで該当チャンネル)。Firebase プロジェクトでの実受信はユーザー側の設定後に確認する (infra/README.md) |
| M8 | メッセージ機能 | threads、reactions、mentions、edit、delete、unread state | **M8a 実装済み (2026-09-26)**: 編集・削除 (トゥームストーン)・リアクション・メンション抽出とプッシュ対象、`PATCH/DELETE /messages/{id}`、`PUT/DELETE /messages/{id}/reactions/{emoji}`、契約フィクスチャ 04 (切断中の変更を差分 1 回で回復) を 4 実装で通過、3 クライアントの UI (アクション・リアクション・メンション補完)。**M8b 実装済み (2026-09-26)**: `read_states` (参加時に初期化、送信者は自分の投稿を既読)、`PUT /channels/{id}/read` (単調・clamp)、`read.updated`、bootstrap の `read_state` (未読数・メンション数を seq 範囲から導出)、PushPlanner の既読チェックとバッジ、PushSender の送信直前の既読チェック、契約フィクスチャ 07 を 4 実装で通過、3 クライアントの未読バッジと既読送信 (1 秒デバウンス、楽観的更新)。**M8c 実装済み (2026-09-26)**: `parent_id` (1 段)、返信で親の `reply_count` / `last_reply_at` / `updated_seq` を同じ seq に更新、`GET /messages/{id}/replies`、履歴は親のみ・差分は返信込み、返信は未読に数えない、通知対象に親の投稿者と返信者 (`parent_thread.participant_ids`)、3 クライアントのスレッド画面 (Desktop は右ペイン、モバイルはスレッド画面 / シート) |
| M9 | 添付と検索 | versitygw、attachments、PGroonga、search UI | **M9a 実装済み (2026-09-26)**: `attachments` (pending → attached → deleted)、`BlobStore` (S3 API / boto3、起動時に `ensure_bucket`)、`POST /attachments` (サイズ上限、MIME sniff、サムネイル、レート制限)、`GET /attachments/{id}[/content|/thumbnail]` (メンバー判定、`inline` は画像のみ、nosniff)、送信時の bind、削除で即時 `deleted`、GC、`verify-attachments` CLI、3 クライアントのアップロード / サムネイル表示 / ダウンロード。compose の versitygw で通し確認済み。**M9b 実装済み (2026-09-26)**: PGroonga 4.0 (`messages.body`、`attachments.filename`)、`GET /search/messages` (メンバー判定、`channel_id` / `from_user_id` / `after` / `before`、`pgroonga_score` 順、offset ページング、構文エラー時のエスケープ再試行、レート制限)、応答の `keywords` を使った 3 クライアントのハイライト付き検索 UI。日本語 / 英語の部分一致と複数語 AND をテスト |
| M10 | 運用 | backup、restore、security review、logging、deployment docs | **実装済み (2026-09-26)**: `infra/backup.sh` / `restore.sh` / `restore-rehearsal.sh` (リハーサル成功)、`audit_logs`、保持期間ジョブ (sessions / devices / outbox / push_deliveries / 未添付アップロード)、`anonymize-user` と `POST /admin/users/{id}/anonymize`、`export-channel` (JSONL)、`/readyz` のスキーマ・outbox 滞留チェック、SECURITY.md §13 のレビュー、infra/README.md のデプロイ手順 |

## 2. 各マイルストーンの詳細

### M1: バックエンド基盤

目的: 「ログイン → 投稿 → 保存 → 取得」を通す土台を作る。以後のすべてのマイルストーンがこの上に乗る。

スコープ:

- `server/` の uv プロジェクト (`pyproject.toml`、Python 3.13、ruff、mypy、pytest)。
- `app/main.py` (app factory、lifespan)、`core/` (settings、db、security、ids、errors、logging、ratelimit)。
  エラー形式と分類 (ARCHITECTURE.md §9)。`GET /healthz`、`GET /readyz`。
- `infra/`: `docker-compose.yml` (`db` = `groonga/pgroonga` イメージ、`objectstore` = `versity/versitygw` (posix バックエンド。起動確認のみ)、`app`)、
  `Dockerfile`、`Caddyfile` の例、`.env.example`。
- Alembic 初期化と最初のマイグレーション: `citext`、`users`、`devices`、`sessions`、`channels`、
  `channel_members`、`messages`。`messages` には `seq` / `updated_seq` / `client_msg_id` / `body` を最初から持つ。
- `auth`: login (端末行の作成)、refresh (ローテーション、30 秒猶予、再利用検知)、logout、sessions 一覧・失効、
  `PUT /devices/current` (端末名・バージョンのみ。プッシュ項目は M5)、JWT access token、argon2id、
  ログインのレートリミット、`must_change_password` の強制。
- `users`: 一覧、取得、`me`、プロフィール更新、パスワード変更。
- `admin`: ユーザー作成 (仮パスワード)、一覧、ロール変更、無効化 (全セッション失効)、パスワードリセット。
  CLI `create-admin`、`create-user`、`export-openapi`。
- `channels`: 作成 (4 種)、一覧 (所属 + public)、取得、更新、参加、退出、メンバー追加・除外、アーカイブ、
  `POST /dms` (`dm_key` による冪等な解決)。`require_member`。
- `messages`: 投稿 (seq 採番、`client_msg_id` による冪等性。どちらも「確実な保存」の一部なのでここで入れる)、
  履歴 (`before_seq` カーソル)。編集・削除・リアクション・スレッドは M8。
- テスト: 実 PostgreSQL に対する API テスト (認証フロー、再利用検知、権限、非メンバー拒否、投稿と取得)。
  CI (GitHub Actions): ruff、mypy、pytest (PostgreSQL サービス付き)、OpenAPI の差分チェック。

スコープ外: outbox、WebSocket、差分 API、既読、通知設定、オブジェクトストレージの利用、プッシュ。

完了条件:

1. `docker compose up` で app / db / objectstore が起動し `GET /readyz` が 200。
2. `create-admin` → `POST /admin/users` (member 作成) → member で `POST /auth/login` →
   `PUT /users/me/password` → `POST /channels` → `POST /channels/{id}/messages` → `GET /channels/{id}/messages`
   に投稿が含まれる。`POST /auth/refresh` 後、旧トークンで再度 refresh すると `401 session_revoked` になる。
3. 非メンバーが `GET /channels/{id}/messages` で `403 not_a_member`。
4. `uv run pytest` / `mypy` / `ruff` が緑。`openapi/openapi.json` が生成され CI で一致する。
5. SECURITY.md §12 のチェックリストを満たす。

M2 との切り分け: seq と idempotency の **列と採番** は M1 で入れ、**同期の保証 (連番性・差分・再接続) と
そのテスト** を M2 で行う。M1 で作った投稿処理を M2 で書き直さないため。

### M2: 信頼できる同期

スコープ: `outbox_events` と `write_outbox()`。M1 の全書き込みに outbox 行と `pg_notify` を追加。
`OutboxRelay` (LISTEN + 1 秒 poll、`FOR UPDATE SKIP LOCKED`、audience 解決、永続ハンドラの枠、
poison event のスキップ)。`EventBus` Protocol と `InMemoryEventBus`。`RealtimeHub` と `/ws`
(認証フレーム、hello、ping/pong と `active`、close code、24 時間上限)。イベント:
`message.created`、`channel.*`、`user.*`、`session.revoked`。`GET /channels/{id}/sync`、
`GET /sync/bootstrap` (read_state / notification は無し)。処理済み outbox の purge ジョブ。
`openapi/ws-events.json` の生成。

完了条件: 2 ユーザーが同一チャンネルに並行投稿しても seq が連番になる。同じ `client_msg_id` で 2 回投稿して
1 件。pytest で WS クライアント 2 本を張り、片方の投稿がもう片方に `message.created` として届く。
接続を切って投稿した後、再接続 + `GET /channels/{id}/sync` で全部回復する。Relay を kill して再起動しても
未処理イベントが配信される。契約テストのフィクスチャ (SYNC_PROTOCOL.md §13) の 1、2、3、5、6、8、9 を作る。 (`server/tests/contract/*.json`、参照クライアントは `server/tests/contract_client.py`)

### M3: Desktop クライアント

スタック: Tauri 2 + React + TypeScript (Vite)。ローカルストアは SQLite (tauri-plugin-sql)。
トークンは OS の資格情報ストア (Rust 側の `keyring` クレート経由)。通知は tauri-plugin-notification。

スコープ: ログイン / ログアウト、パスワード変更の強制画面、refresh、WS 接続と再接続、bootstrap、
チャンネル一覧と DM 一覧 (左ペイン)、タイムライン (中央。上スクロールで履歴)、送信 (楽観的 UI、
outbox キュー)、ギャップ検知と差分取得、DM 作成、OS ネイティブ通知 (DM。メンションは M8a 以降)。
右ペインはスレッド (M8c) まで空。本文の表示フォーマット (軽量 markdown の対応範囲) をここで決めて
DATA_MODEL.md に追記する。Windows と macOS でビルドする。

完了条件: 2 つのプロファイルで会話でき、片方をオフラインにして他方が投稿した後、オンラインに戻すと
一致する。契約テストのフィクスチャをクライアントの同期ロジックのテストでも通す。`tsc` とテストが緑、
両 OS で `tauri build` が通る。

### M4: iOS クライアント

スタック: Swift / SwiftUI / Swift Concurrency。SQLite (SQLite3 C API の薄いラッパ)。`URLSessionWebSocketTask`。Keychain。
UIKit は SwiftUI で足りない場合のみ。Xcode から登録済み実機に直接インストールする
(App Store / TestFlight を前提にしない)。

スコープ: M3 と同じ機能セット (ログイン、チャンネル / DM 一覧、タイムライン、送信、リアルタイム同期、
再接続、バックグラウンドからの復帰時の再同期)。

完了条件: 実機で Desktop と会話できる。バックグラウンドに数分置いて戻しても欠落しない。
`xcodebuild` でビルドが通り、契約テストのフィクスチャを XCTest で通す。

### M5: APNs

スコープ (サーバ): `push_deliveries` と `notification_preferences` のマイグレーション、
`PUT /channels/{id}/notification-preference` と `notification_preference.updated`、`PUT /devices/current`
のプッシュ項目 (provider / token / environment)、トークン付け替えと無効化、ログアウト時の端末無効化、
PushPlanner (永続ハンドラ。PUSH_NOTIFICATIONS.md §4 の M5 分のルール)、PushSender (リース、backoff、期限)、
`APNsPushProvider` (.p8、端末ごとの sandbox / production)、`LogPushProvider`、`FakePushProvider`、
`push-test` CLI、purge ジョブ。
スコープ (iOS): 通知許可、トークン登録と更新時の再登録、通知の表示とグループ化、タップで該当チャンネルを
同期後に表示、フォアグラウンド時の抑制、`ping` の `active`。

完了条件: `FakePushProvider` で at-least-once とリース回復のテストが通る。Desktop から送った DM の通知が
実機 (sandbox) に届き、タップすると同期済みのチャンネルが開く。ログアウトした端末に通知が届かない。

### M6: Android クライアント

スタック: Kotlin / Jetpack Compose / Coroutines + Flow。Room。WebSocket は OkHttp
(Jetpack に WebSocket クライアントが無いため、これだけは許容する第三者依存)。トークンは Android Keystore の
鍵で暗号化して DataStore に保存。

スコープ: M3 と同じ機能セット。完了条件: エミュレータで Desktop / iOS と会話できる。`./gradlew build` が通り、
契約テストのフィクスチャを JUnit で通す。

実装メモ (2026-09-26): AGP 9.x の built-in Kotlin + compileSdk 37。同期エンジンの状態変更は 1 本のワークキューで
直列化し、`hello` だけはキューの外 (トランスポートのスレッド) で待機を解除する (キュー内で待つとデッドロックする)。
Room は Persistence の書き込みを単一スレッドの executor に順序どおり流す (UI をブロックしない)。
FCM (M7) までは DM 通知を WS 経由のローカル通知で出す。

### M7: FCM

スコープ: `FCMPushProvider` (HTTP v1、サービスアカウント)、Android の登録と `onNewToken` での更新、
data-only メッセージから通知を組み立て (`tag = channel_id`)、タップで同期後に表示、無効トークンの NULL 化。
1 ユーザーに複数の FCM トークンがある前提のテスト。

完了条件: Play services 入りエミュレータで通知を受け、タップして該当チャンネルが開く。

実装メモ (2026-09-26): サーバ側は `google-auth` を使わず PyJWT (RS256) で JWT bearer grant を組む (依存を増やさない)。
Android 側は `google-services.json` がある場合だけ Google services プラグインを適用する (無くても CI が通る)。
FCM の実受信には Firebase プロジェクトが要るため、infra/README.md の手順でユーザーが設定してから確認する。

### M8: メッセージ機能 (3 分割)

- **M8a 編集・削除・リアクション・メンション**: 編集 (`updated_seq`)、削除 (トゥームストーン、添付の `deleted` 化)、
  リアクション、メンショントークンの抽出と通知ルール、メンション補完 UI。サーバ + 3 クライアント。
  契約テスト 4。差分同期で編集・削除・リアクションが回復することを確認する。
  実装メモ (2026-09-26): 編集は投稿者のみ、削除は投稿者と admin。編集・削除・リアクションの変更は seq を消費するが
  `last_message_at` は動かさない。リアクションは `PUT/DELETE /messages/{id}/reactions/{emoji}` (冪等。変化が無ければ seq を消費しない)。
  クライアントは `@username` を送信時に `<@uuid>` へ、編集時に逆へ変換する。チャンネルのローカル通知はメンション時のみ。
  添付の `deleted` 化は M9 で添付と一緒に入れる。
- **M8b 未読**: `read_states`、`PUT /channels/{id}/read`、`read.updated`、bootstrap の未読数 / メンション数、
  送信時の自動既読、PushPlanner の既読チェックとバッジ、クライアントの未読バッジと既読送信。契約テスト 7。
  2 端末で既読が収束する。
  実装メモ (2026-09-26): `reads` は葉モジュール (ARCHITECTURE.md §5 を更新)。マイグレーション 0005 は既存メンバーを
  全既読で初期化する。クライアントは表示できたメッセージの最大 `seq` を 1 秒デバウンスで送り、ローカルは先に進める。
  他人の `message.created` はローカルで未読 +1 (メンションなら +1)、自分の送信は 0 に戻す。`read.updated` は
  サーバの値で置き換える。iOS はバッジを「DM 未読 + メンション」で更新し、既読になったチャンネルの通知を消す。
  Android は既読になったチャンネルの通知を消す。
- **M8c スレッド**: `parent_id`、`GET /messages/{id}/replies`、親の `reply_count` 更新、通知対象の拡張、
  Desktop の右ペイン、モバイルのスレッド画面。参加 / 退出のシステムメッセージはここで入れてもよい。
  実装メモ (2026-09-26): 返信の削除は `reply_count` を減らし親の `updated_seq` を進める (イベントに `parent_thread`)。
  返信の親を削除しても返信行は残る (親が無いので表示されない)。参加 / 退出のシステムメッセージは入れていない
  (`messages.type = 'system'` の列だけ用意)。

### M9: 添付と検索 (2 分割)

- **M9a 添付**: `attachments` マイグレーション、`BlobStore` (S3 API。起動時の `ensure_bucket`、put / get / delete)、`POST /attachments` (ストリーミング、
  サイズ上限、MIME sniff)、bind、`GET /attachments/{id}/content` (認可、ヘッダ)、サムネイル生成、
  GC ジョブ、`verify-attachments` CLI、3 クライアントのアップロード / 表示 / ダウンロード。
  完了条件: 画像とファイルを送って相手に表示できる。非メンバーは 403。メッセージ削除後は 404。
  実装メモ (2026-09-26): サムネイルのキーは `attachments/{id}.thumb.jpg` (posix バックエンドでは
  `attachments/{id}` と同名のディレクトリを作れないため。ARCHITECTURE.md / DATA_MODEL.md を更新)。
  本文が空でも添付があれば送信できる。アップロードはメモリに読み込んでから S3 に置く (上限 100 MB。
  ストリーミングのままマルチパートアップロードするのは将来の最適化)。Desktop の保存は Tauri の
  dialog / fs プラグイン、iOS は共有シート、Android は FileProvider 経由の ACTION_VIEW。
- **M9b 検索**: PGroonga インデックス (`messages.body`、`attachments.filename`)、`GET /search/messages`
  (権限フィルタ、`channel_id` / `from_user_id` / 期間、`pgroonga_score` 順、ハイライト)、構文エラー時の
  エスケープ再試行、3 クライアントの検索 UI。tokenizer は既定 (TokenBigram) から始め、MeCab は
  イメージに含まれていれば検討する。将来の pgvector 同居のためイメージ構成をここで確認する。
  完了条件: 日本語 / 英語の部分一致・複数語 AND がヒットする。所属外チャンネルと削除済みが出ない。
  実装メモ (2026-09-26): ハイライトはサーバの `pgroonga_highlight_html` (HTML) ではなく、応答の `keywords`
  (`pgroonga_query_extract_keywords`) を使ってクライアントが本文の表示形式のまま行う。tokenizer は既定の
  TokenBigram。返信も検索対象 (結果からスレッドを開く)。添付ファイル名の一致も本文の一致と同列に返す。
  pgvector の同居はイメージ (groonga/pgroonga) に含まれないため、必要になったら別イメージを検討する。

### M10: 運用

バックアップスクリプト (`pg_dump` + `mc mirror`) と復元手順書、復元リハーサル、`audit_logs`、
保持期間ジョブ (sessions / devices / outbox / push_deliveries)、ユーザー匿名化コマンド、
チャンネル単位の JSONL エクスポート CLI、SECURITY.md のチェックリストによるレビュー、ログの整理、
`/readyz` の詳細化、`infra/README.md` のデプロイ手順。

実装メモ (2026-09-26): オブジェクトストアのバックアップは `mc mirror` ではなく、versitygw の posix
バックエンドのディレクトリを tar する (オブジェクトは通常のファイル)。`audit` は葉モジュール
(ARCHITECTURE.md §5)。監査ログの閲覧は当面 psql (UI はバックログ)。

### UI ブラッシュアップ (2026-09-26、M10 後)

3 クライアント共通で使い勝手を揃えた。タイムラインは日付区切り (今日 / 昨日 / M月D日)、同じ送信者の
5 分以内の連続投稿をまとめる表示、ユーザー ID から決まる色のイニシャルアバター、チャンネルを開いた時点の
既読位置に置く「新着メッセージ」区切り、最新へ戻るボタン、空状態の案内。チャンネルヘッダからトピックの
表示 / 編集 (`PATCH /channels/{id}`)、メンバー一覧、通知レベル (all / mentions / none) と 8 時間ミュート
(`PUT /channels/{id}/notification-preference`) を操作できる。設定画面で表示名の変更 (`PATCH /users/me`)、
ログイン中のパスワード変更、ログアウト。ログイン後のエラーはトースト / Snackbar で表示し、WebSocket が
切れている間は接続バナーを出す。Desktop はダークモード (OS 設定に追従) と Ctrl/⌘+K のチャンネル移動、
Ctrl/⌘+F の検索、Esc で右ペインを閉じる操作を追加。

同期側の注意: `channel.updated` の payload には利用者ごとの通知設定が含まれないため、各クライアントの
Store は既知の設定を保持し、`notification_preference.updated` イベントで更新する。

### 日常操作の改善 (2026-09-26、3 端末を同じ優先度で実装)

- チャンネル / DM / スレッド別に本文とアップロード済み添付の下書きを保存する。デスクトップ版は SQLite、
  iOS は SQLite、Android は Room のアカウント別ストアを使い、画面移動や再起動から復元する。
  アップロード中の操作状態は復元しない。Desktop のブラウザ開発プレビューは従来どおりメモリ保存。
- 添付のアップロードが終わるまで送信を止める。アップロード中に画面を切り替えても元の会話の下書きに追加する。
  本文 / 添付の件数上限を送信前に確認し、失敗時は本文を保持する。Desktop はファイルのドロップと貼り付けに対応。
- チャンネルを開くだけでは既読にしない。接続中かつ前面にある通常の会話画面で、表示できたメッセージの `seq`
  まで既読を進める。検索位置を閲覧している間は既読位置を動かさない。
- 検索結果から該当メッセージへ移動し、強調表示する。`GET /messages/{id}/context?limit=25` で親メッセージの
  前後最大 25 件ずつを取得する (上限 100 件ずつ)。返信は親の前後とスレッド内の該当返信を表示する。
  この検索用ウィンドウは通常の履歴 / 同期カーソルと分け、最新の会話に戻る操作を用意する。
- スレッドと通常の会話でメッセージ操作と入力欄を共用する。編集 / 削除 / リアクション / 添付 / 送信再試行を揃える。
- 保存済みの本人情報と refresh token があれば、起動時はキャッシュした会話を先に表示する。認証更新と同期は裏で
  再試行し、通信断だけではログアウトしない。認証が拒否された場合はログイン画面へ戻す。ログアウト後に遅れて届いた
  refresh 応答で資格情報を復活させない。

検証: サーバの範囲取得と認可、3 クライアントの下書き復元 / 非アクティブ時の既読抑止 / 認証復帰を回帰テストに追加。
Desktop はコンポーネント上で入力切替、アップロード中の送信抑止、アップロード後の保存先、IME 確定、表示範囲の既読、
検索位置の移動を検証する。実行結果は server 126 件、Desktop 47 件、iOS 37 件、Android 38 件が成功。
Desktop の型検査 / ビルド、iOS Simulator のビルド、Android の Lint / APK ビルドも通過。各クライアントの
LIVE バックエンドテストは接続資格情報が無いため 1 件ずつスキップ。実機での操作感、3 端末間の実接続、
APNs / FCM の実配信は別途受け入れ確認が必要。

### Slack / Mattermost 流の操作 (2026-09-26、3 端末)

Mattermost の公開コードは「振る舞いの仕様書」として参照した (webapp / mobile / desktop は Apache 2.0、
サーバ本体は AGPLv3。コードの転用はしていない)。

1 回目 (UI のみ):

- ミュート中 (`level=none` または期限付きミュート) の会話は太字・未読件数を出さず、メンションだけバッジにする。
  iOS のアプリバッジ、各端末のローカル通知 (all / mentions / none) も同じ規則。
- サイドバーの未読フィルタ (Desktop はトグル、Android はチップ、iOS はセグメント)。開いている会話は常に残す。
- Desktop のキーボード: Alt+↑↓ でチャンネル移動、Alt+Shift+↑↓ で未読チャンネル移動、Ctrl/⌘+Shift+K で DM、
  Ctrl/⌘+Shift+L で入力欄、Ctrl/⌘+U で添付、Ctrl/⌘+/ で一覧、Esc は何も開いていなければ表示中の会話を既読に
  する。空の入力欄で ↑ は自分の最後の投稿を編集、Shift+↑ は最新の投稿にスレッド返信。
- 下にスクロールしていないときの「新着 N 件」ボタン。

2 回目 (サーバを含む):

- 「ここから未読にする」: `PUT /channels/{id}/read` の `mode: "set"` (SYNC_PROTOCOL.md §10)。操作した端末は
  その会話を離れるまで表示範囲による既読更新を止め、他端末は `read.updated` の値で位置を下げる。
  Desktop はホバー操作と Alt+クリック、iOS / Android は長押しメニュー。
- 検索の修飾子 `from:@user` `in:#channel` `before:` `after:` `on:` (DATA_MODEL.md 検索)。日付は端末の
  タイムゾーンで解釈し、解決できない条件は `filters.unresolved` として画面に出す。

検証: サーバの pytest / ruff / mypy、Desktop の typecheck / vitest / vite build、iOS の XCTest、
Android の JUnit / Lint / assembleDebug がすべて成功 (契約テストと FakeServer を含む)。

次: フォロー中スレッドの一覧は THREADS.md の設計に沿って実装する (→ M11a)。

### Desktop UI の刷新 (2026-09-26)

Desktop の見た目を、フリーで使える現行のフレームワークに載せ替えた。ロジック (Store / SyncEngine / 契約テスト)
は変えていない。

- Tailwind CSS v4 (`@tailwindcss/vite`、MIT): `src/styles.css` の `@theme inline` でセマンティックな色トークンを
  定義し、ライト / ダークは OS の `prefers-color-scheme` に従う。
- Radix UI (`radix-ui` 単一パッケージ、MIT): Dialog / DropdownMenu / Popover / Tooltip。`src/ui/primitives.tsx` に
  Button / Input / Modal / Menu などの薄いラッパを置き、画面はそれだけを使う。
- cmdk (MIT): Ctrl/⌘+K のチャンネル移動。
- Lucide (`lucide-react`、ISC): 絵文字で代用していたアイコンを置き換えた。Android は Material Icons Extended
  (Apache 2.0)、iOS は SF Symbols で同じ意図のアイコンにそろえる。
- `scripts/preview-shots.mjs`: ブラウザプレビュー (`npm run dev`) をヘッドレス Chrome で操作してログイン後の
  画面を撮る開発用スクリプト。目視確認に使う。

### M11: Slack / Mattermost 相当の機能を順に足す (2026-09-27〜)

方針: 1 機能ずつ「サーバ (テスト・OpenAPI・docs) → Desktop → iOS → Android」の順に実装し、機能ごとにコミットする。
アーキテクチャは変えない (outbox + WS Hub、seq 同期、JSON 行の永続化)。順番は使う頻度の高いものから。

| # | 機能 | 内容 | 状況 |
| --- | --- | --- | --- |
| M11a | フォロー中スレッド | THREADS.md。`thread_follows`、`GET /threads`、`GET/PUT /messages/{id}/thread[/read|/follow]`、`thread.updated`、bootstrap の `threads`、プッシュ対象をフォロワーに置き換え、3 端末の「スレッド」一覧・フォロー切替・スレッド既読・「新しい返信」 | **実装済み (2026-09-27)**: サーバ pytest 133、Desktop vitest 71 + ブラウザプレビューで目視、iOS XCTest 43 + スナップショット、Android JUnit 45 + Lint + assembleDebug |
| M11b | プレゼンスと入力中表示 | WS の揮発イベント (outbox を通さない) で online / away と typing を配る。Hub が接続状態から導出、Redis は不要 | 未着手 |
| M11c | ピン留めとブックマーク | `messages.pinned_at` + `PUT/DELETE /messages/{id}/pin` (`message.updated change=pin` は予約済み)、`bookmarks` (自分だけの保存) | 未着手 |
| M11d | プロフィールとカスタムステータス | ユーザーのポップオーバー / シート、`users.status_text` / `status_emoji` / `status_expires_at`、`user.updated` で配る | 未着手 |
| M11e | Desktop の管理 UI | ユーザー作成・パスワード再設定・無効化・ロール、チャンネルのアーカイブ・改名 (API は M10 までに実装済み) | 未着手 |
| M11f | 絵文字ピッカーと `:shortcode:` | 補完と描画 (3 端末)。カスタム絵文字はその後 | 未着手 |
| M11g | リンクプレビュー | サーバ側で OGP を取得 (SSRF 対策、サイズ・時間の上限、キャッシュ)、`link_previews` | 未着手 |
| M11h | チャンネルまわり | チャンネルブラウザ、退出、チャンネル紹介、最近のメンション一覧、下書き一覧 | 未着手 |
| M11i | ファイル一覧 | チャンネル / ワークスペースの添付一覧 (検索 API の `attachments.filename` を流用) | 未着手 |

### バックログ (未スケジュール)

カスタム絵文字、quiet hours、招待リンク、OIDC、2FA、Web クライアント、presigned URL、Redis による複数プロセス化、
Mattermost からのインポート (`mmctl export` の bulk-import JSONL を読む `import-mattermost` CLI。設計メモは
このセッションの会話に残しており、必要になった時点で docs に起こす)、意味検索 / 要約 / RAG。

## 3. 設計ポイントとマイルストーンの対応

| 設計ポイント | 文書 | 実装 |
| --- | --- | --- |
| Message ID と channel seq | DATA_MODEL.md §2 | M1 (列と採番)、M2 (保証とテスト) |
| client-generated idempotency key | DATA_MODEL.md §2、SYNC_PROTOCOL.md §4.4 / §9 | M1 (サーバ)、M2 (テスト)、M3 / M4 / M6 (クライアント) |
| WS 切断後の差分同期 | SYNC_PROTOCOL.md §4.3 / §7 | M2 (サーバ)、M3 / M4 / M6 (クライアント) |
| 複数端末の既読同期 | SYNC_PROTOCOL.md §10、DATA_MODEL.md `read_states` | M8b |
| DM と通常チャンネルのモデル | DATA_MODEL.md §3 `channels` | M1 |
| Transactional Outbox | ARCHITECTURE.md §6、DATA_MODEL.md `outbox_events` | M2 |
| APNs / FCM の抽象化 | PUSH_NOTIFICATIONS.md §8 | M5 (APNs)、M7 (FCM) |
| プッシュの重複・欠落・遅延 | PUSH_NOTIFICATIONS.md §6 / §7 | M5、M7、M8b (既読チェック) |
| refresh token 管理 | SECURITY.md §2.3 | M1 |
| 添付ファイルのアクセス制御 | SECURITY.md §4 | M9a |
| PostgreSQL + PGroonga 検索 | ARCHITECTURE.md D9、DATA_MODEL.md §4 | M9b |
| EventBus の Redis 化の境界 | ARCHITECTURE.md §7 / §10 | M2 (Protocol のみ) |
| バックアップと復元 | ARCHITECTURE.md §8 | M10 |
| AI 検索 / RAG への備え | ARCHITECTURE.md §10、DATA_MODEL.md §6 | M1 (本文のプレーンテキスト保存)、M9b (イメージ構成)、M10 (エクスポート) |

## 4. 前提とリスク

| 項目 | 状況 | 対応 |
| --- | --- | --- |
| Docker | 解決済み: Docker Desktop 導入済み (2026-09-26 確認。Compose v5、`docker` は `~/.docker/bin`) | なし |
| Python | 開発機の既定は 3.11。`uv` で 3.13 を取得する | `uv python install 3.13` |
| PGroonga のイメージ | PostgreSQL 17 対応イメージ (`groonga/pgroonga:latest-alpine-17` / `latest-debian-17`) の取得可を確認済み。MeCab の有無と pgvector 同居は未確認 | M1 の compose 作成時に MeCab を確認 (pgvector は M9b) |
| オブジェクトストレージ | 決定済み (2026-09-26): MinIO のコミュニティ版終了 (GitHub リポジトリは 2026-04 に archive、公式イメージ削除、最終リリース 2025-10-15) を受け、versitygw v1.8.0 (posix バックエンド) を採用。実物で S3 API のバケット作成 / put / get / list / delete、未認証拒否、8 MiB の往復一致を確認済み。CLAUDE.md と docs は更新済み | M1 の compose に `versity/versitygw:v1.8.0` を組み込む (構成は `infra/README.md`) |
| APNs | Apple Developer Program 加入済み。認証キー (.p8) は発行済み (2026-09-26。`infra/secrets/` に保管、Key ID / Team ID は `infra/.env`)。残りは App ID の登録 (Push Notifications capability) と実機の登録。Xcode 直接インストールは sandbox 環境 | M5 までに用意する。端末ごとの `push_environment` で吸収 |
| Windows ビルド | Tauri の Windows 向けビルドには Windows 機または CI が必要 | M3 で GitHub Actions の Windows runner を使う |
| 単一プロセス | CPU 負荷の高い処理 (サムネイル、argon2) がイベントループを塞ぐ | threadpool に逃がす。負荷が問題になったら Redis 導入 (ARCHITECTURE.md §10) |
| 本文フォーマット | 軽量 markdown の範囲が未定 | M3 で決めて 3 クライアントで共有 |
| Android の WebSocket | Jetpack に WS クライアントが無い | OkHttp を唯一の許容する第三者依存として明記 |
