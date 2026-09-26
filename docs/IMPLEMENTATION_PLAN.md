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

| # | 名前 | 内容 | 完了条件 |
| --- | --- | --- | --- |
| M0 | 設計 | 設計文書、ディレクトリ構造 (完了) | docs が CLAUDE.md と整合している |
| M1 | バックエンド基盤 | PostgreSQL、認証、users、channels、channel membership、メッセージ作成・取得 | **完了 (2026-09-26)**。テストクライアントがログインし、投稿し、PostgreSQL に保存され、取得できる。pytest 57 件、mypy、ruff、compose 上の curl による通し確認 (管理者作成 → メンバー作成 → 仮パスワード変更の強制 → チャンネル作成・参加 → 投稿と冪等再送 → 履歴 → 非メンバー 403 → refresh 回転と再利用検知 → logout) がすべて成功 |
| M2 | 信頼できる同期 | channel sequence と idempotency の保証、outbox、WebSocket、再接続同期、bootstrap | **完了 (2026-09-26)**。outbox + Relay (LISTEN/NOTIFY)、InMemoryEventBus、WebSocket Hub、差分 API、bootstrap、ws-events.json。pytest 75 件 (実 uvicorn + WebSocket の統合テスト、SYNC_PROTOCOL §13 の契約フィクスチャ 1/2/3/5/6/8/9 を参照クライアントで実行) がすべて成功 |
| M3 | Desktop クライアント | login、channel list、message list、send、リアルタイム更新 | **実装済み (2026-09-26)**: Tauri 2 + React + TS、SQLite ストア、Keychain、SYNC_PROTOCOL の同期エンジン、DM 通知、契約フィクスチャ 7 本と実サーバに対するライブテストが通過。macOS で `tauri build` 済み。Windows ビルドは CI (windows runner) で行う |
| M4 | iOS クライアント | login、channel list、messages、send、リアルタイム同期 | 実機で Desktop と会話できる |
| M5 | APNs | 端末登録、プッシュトークン登録、配送、通知処理、通知後の同期 | 実機で通知を受け、タップして同期済みの画面が開く |
| M6 | Android クライアント | login、channel list、messages、send、同期 | エミュレータで会話できる |
| M7 | FCM | 端末登録、トークン処理、配送 | エミュレータで通知を受ける |
| M8 | メッセージ機能 | threads、reactions、mentions、edit、delete、unread state | 3 クライアントで動作し、差分同期で回復する |
| M9 | 添付と検索 | versitygw、attachments、PGroonga、search UI | 画像を送って相手に表示。日本語 / 英語で検索できる |
| M10 | 運用 | backup、restore、security review、logging、deployment docs | 復元リハーサルが成功する |

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

スタック: Swift / SwiftUI / Swift Concurrency。SQLite (GRDB)。`URLSessionWebSocketTask`。Keychain。
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

### M7: FCM

スコープ: `FCMPushProvider` (HTTP v1、サービスアカウント)、Android の登録と `onNewToken` での更新、
data-only メッセージから通知を組み立て (`tag = channel_id`)、タップで同期後に表示、無効トークンの NULL 化。
1 ユーザーに複数の FCM トークンがある前提のテスト。

完了条件: Play services 入りエミュレータで通知を受け、タップして該当チャンネルが開く。

### M8: メッセージ機能 (3 分割)

- **M8a 編集・削除・リアクション・メンション**: 編集 (`updated_seq`)、削除 (トゥームストーン、添付の `deleted` 化)、
  リアクション、メンショントークンの抽出と通知ルール、メンション補完 UI。サーバ + 3 クライアント。
  契約テスト 4。差分同期で編集・削除・リアクションが回復することを確認する。
- **M8b 未読**: `read_states`、`PUT /channels/{id}/read`、`read.updated`、bootstrap の未読数 / メンション数、
  送信時の自動既読、PushPlanner の既読チェックとバッジ、クライアントの未読バッジと既読送信。契約テスト 7。
  2 端末で既読が収束する。
- **M8c スレッド**: `parent_id`、`GET /messages/{id}/replies`、親の `reply_count` 更新、通知対象の拡張、
  Desktop の右ペイン、モバイルのスレッド画面。参加 / 退出のシステムメッセージはここで入れてもよい。

### M9: 添付と検索 (2 分割)

- **M9a 添付**: `attachments` マイグレーション、`BlobStore` (S3 API。起動時の `ensure_bucket`、put / get / delete)、`POST /attachments` (ストリーミング、
  サイズ上限、MIME sniff)、bind、`GET /attachments/{id}/content` (認可、ヘッダ)、サムネイル生成、
  GC ジョブ、`verify-attachments` CLI、3 クライアントのアップロード / 表示 / ダウンロード。
  完了条件: 画像とファイルを送って相手に表示できる。非メンバーは 403。メッセージ削除後は 404。
- **M9b 検索**: PGroonga インデックス (`messages.body`、`attachments.filename`)、`GET /search/messages`
  (権限フィルタ、`channel_id` / `from_user_id` / 期間、`pgroonga_score` 順、ハイライト)、構文エラー時の
  エスケープ再試行、3 クライアントの検索 UI。tokenizer は既定 (TokenBigram) から始め、MeCab は
  イメージに含まれていれば検討する。将来の pgvector 同居のためイメージ構成をここで確認する。
  完了条件: 日本語 / 英語の部分一致・複数語 AND がヒットする。所属外チャンネルと削除済みが出ない。

### M10: 運用

バックアップスクリプト (`pg_dump` + `mc mirror`) と復元手順書、復元リハーサル、`audit_logs`、
保持期間ジョブ (sessions / devices / outbox / push_deliveries)、ユーザー匿名化コマンド、
チャンネル単位の JSONL エクスポート CLI、SECURITY.md のチェックリストによるレビュー、ログの整理、
`/readyz` の詳細化、`infra/README.md` のデプロイ手順。

### バックログ (未スケジュール)

typing / presence、ピン留め、ブックマーク、カスタム絵文字、quiet hours、招待リンク、OIDC、2FA、
Web クライアント、presigned URL、Redis による複数プロセス化、意味検索 / 要約 / RAG。

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
