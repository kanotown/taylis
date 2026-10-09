# ARCHITECTURE

ChikuwaChat はセルフホスト型の Slack ライクなチャットシステムである。
本書はシステム全体の構成、モジュール分割、プロセスモデル、主要な設計判断をまとめる。

本書は [CLAUDE.md](../CLAUDE.md) (2026-09-26 時点) に準拠する。CLAUDE.md と矛盾する記述があれば
CLAUDE.md を優先し、本書を更新する。

関連文書:

- [DATA_MODEL.md](./DATA_MODEL.md) — テーブル定義と不変条件
- [SYNC_PROTOCOL.md](./SYNC_PROTOCOL.md) — クライアント同期 (REST + WebSocket)
- [PUSH_NOTIFICATIONS.md](./PUSH_NOTIFICATIONS.md) — APNs / FCM
- [SECURITY.md](./SECURITY.md) — 認証・認可・脅威モデル
- [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) — マイルストーン

## 1. 目的と非目標

### 目的

- 小規模チーム (当初数人、将来数十人) がサーバ 1 台で運用できるチャット。
  最初から数十人で使える設計にし、2 人向けの最適化はしない。
- 優先順位 (CLAUDE.md): 確実なメッセージ保存 > 確実なリアルタイム同期 > 確実なプッシュ通知 >
  長期保存と検索 (日本語 / 英語) > 添付ファイル > Slack ライクな簡潔な UX > 容易なバックアップと復元 >
  将来の AI 検索 / RAG > 不要な複雑さのない保守性。
- Slack の基本体験: パブリック / プライベートチャンネル、DM、グループ DM、スレッド、リアクション、
  メンション、添付ファイル、全文検索、未読管理、プッシュ通知。
- Desktop (Windows / macOS)、iOS、Android の 3 クライアントが、切断・オフラインを挟んでも同じ状態に
  収束する。
- ブラウザ (M12j): Desktop と同じ React バンドルを Caddy が API と同じオリジンで配信する。ローカル永続化は
  持たず (メモリのみ)、起動のたびに bootstrap から作り直す。幅 768px 未満 (スマホ) では 1 列表示になり、
  会話一覧 → 会話 (やスレッド一覧・検索結果などのビュー) → スレッドを 1 画面ずつ重ねて「戻る」で戻る (M16f)。
  会話は表示中だけマウントする (隠れたタイムラインが既読を進めないため)。デスクトップアプリは最小幅 800px なので
  常に複数列。

### 非目標 (現時点で作らないもの)

- 数千人規模、複数ノードへの水平分散、マイクロサービス
- マルチワークスペース (1 デプロイ = 1 ワークスペース)
- E2E 暗号化 (検索・プッシュ本文・将来の AI 機能と両立しない)
- 外部連携のうち Bot API と OAuth アプリ、URL アンファール。受信 Webhook だけは M13a で最小構成にした
  (CI / 監視の通知はチームチャットの主用途のひとつで、bot ユーザーとして投稿するだけなら既存の経路で済む)
- 音声 / ビデオ通話 (M117 の会議リンクは M130 で廃止し、M130〜M136 で LiveKit によるアプリ内の通話を作る。M130 のサーバと infra は完了 (2026-10-07)、クライアントは M132〜。設計は docs/CALLS.md、D26)
- 埋め込みを使う機能 (意味検索、RAG、抽出、QA)。ただし後から足せる構造にする (§10)。メンションに応える AI のボットと要約は M65 で作った (docs/AI.md)

## 2. 規模の前提 (scale envelope)

| 項目 | 想定 |
| --- | --- |
| ユーザー数 | 数十人 |
| 同時 WebSocket 接続 | 数百 (1 人あたり複数端末) |
| メッセージ | 数千件 / 日、累計数十万〜数百万件。無期限保存 |
| 添付ファイル | 合計数十 GB |
| サーバ | 1 台 (2〜4 vCPU、4〜8 GB RAM) |

この範囲では単一プロセスと PostgreSQL のみで十分であり、設計はそれに最適化する。
範囲を超えた場合の拡張経路は §10 に示す。

## 3. 技術スタック

### サーバ

| 用途 | 採用 | 備考 |
| --- | --- | --- |
| 言語 / ランタイム | Python 3.13 | `uv` で管理 |
| Web フレームワーク | FastAPI + uvicorn | REST と WebSocket を同一アプリで提供 |
| DB アクセス | SQLAlchemy 2.x (async) + asyncpg | 複雑なクエリは SQL を直接書く |
| マイグレーション | Alembic | |
| バリデーション | Pydantic v2 | OpenAPI もここから生成 |
| DB | PostgreSQL 17 + PGroonga | 全ドメインデータ、outbox、検索インデックス |
| オブジェクトストレージ | versitygw (S3 API、posix バックエンド) | 添付ファイルのバイト列のみ。オブジェクトは通常のファイルとして保存される |
| リバースプロキシ / TLS | Caddy | 自動 TLS。既存の nginx が 80 / 443 を持つサーバーではその後ろで HTTP だけ (D22) |
| コンテナ | Docker Compose | 開発・本番とも |
| パスワードハッシュ | argon2id (`argon2-cffi`) | |
| トークン | PyJWT (HS256) | access token 用 |
| プッシュ | `httpx[http2]` (APNs、.p8 トークン認証)、FCM HTTP v1 (`google-auth`) | 詳細は PUSH_NOTIFICATIONS.md |

### 導入しないもの

Redis、Kafka、RabbitMQ、Celery、Kubernetes、Elasticsearch、分散 DB、サービスメッシュ。
これらの役割 (キュー、pub/sub、検索) はすべて PostgreSQL と単一プロセス内で代替する。

### クライアント (CLAUDE.md で指定)

| アプリ | スタック | ローカルストア | 備考 |
| --- | --- | --- | --- |
| Desktop (Windows / macOS) | Tauri 2 + React + TypeScript。UI は Tailwind CSS v4 (MIT) + Radix UI プリミティブ `radix-ui` (MIT) + cmdk (MIT) + Lucide アイコン (ISC) | SQLite (tauri-plugin-sql) | OS ネイティブ通知。左: チャンネル / DM、中央: メッセージと入力、右: スレッド / 検索 |
| iOS | Swift / SwiftUI / Swift Concurrency | SQLite (SQLite3 C API の薄いラッパ。第三者依存なし) | Keychain、APNs 直接。Xcode から実機に直接インストール (App Store 配布を前提にしない) |
| Android | Kotlin / Jetpack Compose / Coroutines + Flow | Room | FCM。Jetpack 標準 API を優先し、サードパーティ依存は最小限 |

3 つのクライアントは同じ API 仕様 (`openapi/`) と同じ同期プロトコル (SYNC_PROTOCOL.md) を各言語で
実装する。クライアントごとに API の振る舞いを変えない。共通ロジックをコード共有しない代わりに、
プロトコル仕様と契約テストの共通化で整合性を保つ。

## 4. 全体構成

```
+-------------+   +-------------+   +-------------+
|  Desktop    |   |    iOS      |   |  Android    |
| Tauri/React |   |  SwiftUI    |   |  Compose    |
+------+------+   +------+------+   +------+------+
       |   HTTPS (REST) + WSS (events)   |
       +----------------+----------------+
                        v
               +--------+---------+
               |   Caddy (TLS)    |
               +--------+---------+
                        v
  +---------------------+-------------------------------------+
  |  app  (単一プロセス: uvicorn --workers 1)                    |
  |                                                           |
  |   FastAPI routers --> module services --(tx)--> PostgreSQL |
  |                                          |  domain rows    |
  |                                          |  + outbox row   |
  |                                          |  + pg_notify    |
  |   RealtimeHub (WS) <-- EventBus <-- OutboxRelay <----------+
  |                                   |                        |
  |                                   +--> PushPlanner         |
  |   PushSender ---------------------------> APNs / FCM       |
  |   周期ジョブ (attachment GC, session cleanup, outbox purge) |
  +------+-------------------------------+--------------------+
         |                               |
         v                               v
  +------+------------+          +-------+------+
  |  PostgreSQL 17    |          |  versitygw   |
  |  + PGroonga       |          |   (S3 API)   |
  +-------------------+          +--------------+
```

- サーバが常に真実 (source of truth)。クライアントは REST で読み書きし、WebSocket でイベントを受信する。
  **WebSocket は受信専用** (例外は typing / ping などの揮発イベント)。メッセージ送信は必ず REST。
- すべての永続的な変更は「ドメイン行 + outbox 行」を同一トランザクションで書く (Transactional Outbox)。
- OutboxRelay が outbox を順に処理し、in-memory の EventBus に流す。RealtimeHub が WS へ配信する。
- プッシュ通知は outbox の永続ハンドラ (PushPlanner) が `push_deliveries` に積み、PushSender が送る。

## 5. Modular monolith の構造

```
server/
  pyproject.toml
  app/
    main.py              # app factory, lifespan (background tasks の起動), 依存の組み立て (composition root)
    cli.py               # create-admin / create-user / export-openapi / push-test / verify-attachments / probe-videos / generate-previews
    core/
      settings.py        # pydantic-settings (環境変数)
      db.py              # engine, session factory, transaction helper
      security.py        # argon2id, JWT
      ids.py             # UUIDv7
      errors.py          # AppError -> HTTP レスポンス変換 (§9 のエラー分類)
      logging.py         # JSON 構造化ログ, request_id
      ratelimit.py       # in-memory token bucket
      time.py            # now() (テストで差し替え可能)
      doctext/           # Markdown 文書の純粋な部品 (3-way マージ・タスクの印・本文の整形・保存の手順・版の整理)。キャンバスとドキュメントが共有 (M120、WIKI.md §2.3)
    events/
      envelope.py        # Event (id, type, ts, channel_id, seq, audience, data)
      bus.py             # EventBus Protocol (publish / subscribe)
      in_memory.py       # InMemoryEventBus
      outbox.py          # write_outbox(session, ...), OutboxRelay, OutboxHandler Protocol
    realtime/
      hub.py             # 接続レジストリ, user_id -> connections, fan-out
      router.py          # GET /api/v1/ws, 認証フレーム, heartbeat
      protocol.py        # フレーム定義
    modules/
      auth/              # login, refresh, logout, sessions, devices (端末とプッシュトークン), パスワード変更
      users/             # プロフィール, 一覧
      admin/             # ユーザー作成 / リセット / ロール / 無効化, 監査ログ
      invites/           # 招待リンク (発行 / 取消 / 公開の確認と受諾) (M12h)
      groups/            # ユーザーグループ (@group メンションの展開先、admin が管理) (M12k)
      lab/               # 研究室の名簿 (身分・学年・指導教員・研究テーマ) と管理グループ (M23)
      webhooks/          # 受信 Webhook (トークン付き URL → bot ユーザーとして投稿) (M13a)
      sidebar/           # サイドバーのセクション (個人の並べ替え、sidebar.updated) (M14f)
      drafts/            # 端末間で共有する下書き (本文のみ、draft.updated) (M15d)
      channel_links/     # 会話の上部のリンク (channel.links_updated) (M15f)
      templates/         # 投稿テンプレート (共通と個人、template.updated。置き換えは端末) (M30)
      canvases/          # キャンバス (会話に属する Markdown 文書、版、サーバ側の 3-way マージ (M120 から core/doctext)、テンプレート templates.py、canvas.*) (M41)
      wiki/              # ドキュメント (ページの木、版、受け継ぐ権限 access.py と実効の表、ゴミ箱、変更のフィード、wiki.*) (M120、WIKI.md、D27)
      calendar/          # カレンダー (自分用とチャンネルの予定、人ごとの通知と fire_due、calendar.*、抜けた人の通知を消す outbox ハンドラ) (M51)
      totp/              # 2 要素認証 (設定 / 有効化 / 無効化、ログイン時の第 2 要素) (M12i)
      channels/          # channels, channel_members, DM 解決
      messages/          # messages, seq 採番, idempotency, edit/delete, reactions, mentions, threads, delta sync
      reads/             # read_states, 未読数
      attachments/       # upload/bind/download, thumbnail, GC, BlobStore (S3 API)
      search/            # PGroonga 検索 (messages / attachments / canvases / wiki の読み取り専用アクセスを許可。canvases は M42、wiki は M120)
      notifications/     # notification_preferences, PushPlanner, PushSender, PushProvider 実装
      sync/              # GET /api/v1/sync/bootstrap (各モジュールの read-only 集約)
      ai/                # AI のボット (メンションへの返事) と要約、LlmProvider (Anthropic / テスト用の Fake)、worker (M65、docs/AI.md)
  migrations/            # Alembic
  tests/
```

各モジュールは次のファイルを持つ: `router.py` (HTTP)、`schemas.py` (Pydantic)、`service.py` (ユースケース)、
`repository.py` (SQL)、`models.py` (SQLAlchemy)、`events.py` (このモジュールが発行するイベント型)。
ディレクトリは必要になったマイルストーンで作る。先に空のモジュールを並べない。

### モジュール間の規約

1. モジュール間の呼び出しは `service.py` の公開関数経由のみ。他モジュールのテーブルを直接クエリしない。
   例外は明示的に許可する: `search` は `messages` / `attachments` / `canvases`（M42） / `wiki`（M120。読める集合は
   `wiki.access` の条件で絞る）を読み取り専用でクエリしてよい。
   `sync` は各モジュールの repository の read-only 関数を呼んでよい。`channels` はメンバー追加 / DM の
   対象ユーザー解決のため `users` を読み取り専用でクエリしてよい (`load_users`)。
   `reads` は未読数・メンション数の集計のため `messages` を読み取り専用でクエリしてよい (DATA_MODEL.md の COUNT)。
   `ai` は送る会話を組み立てるため `messages` を読み取り専用でクエリしてよい (M65、`search` と同じ考え)。
2. 副作用の連鎖 (「メッセージが作られたらプッシュを計画する」) はイベントで結ぶ。`messages` が
   `notifications` を直接呼ばない。
3. 同期的に必要な判定 (権限、存在確認) は service 呼び出しでよい。例: `messages` → `channels.require_member()`。
   同一トランザクション内での付随更新も service 呼び出しでよい。例: `messages` → `reads.advance_in_tx()`。
4. 依存方向は一方向に保つ:
   `auth → users`、`admin → users, auth`、`invites → admin, auth, channels, users`、`auth → totp` (第 2 要素の確認)、`admin → totp` (一覧の表示)、`messages → groups` (メンションの展開)、`admin → groups` (名前の衝突確認)、`lab → users, groups, channels` (名簿の対象、管理グループのメンバー、指導教員を学生の times に加える M24)、`channels` の `POST /times` は指導教員の一覧を `main.py` が注入した関数で得る (channels は lab に依存しない)、`admin → lab` (匿名化で名簿の行を消す)、`admin → attendance` (M140: 匿名化で在室状況の行・記録・個人の状態・配送を消す)、`moderation → admin, channels, messages, users, audit` (M104: アカウントの削除は管理者の匿名化を使い、報告の知らせはボットの DM。docs/MODERATION.md)、`messages` / `channels` / `notifications` / `activity` / `admin` / `sync` → `moderation.blocks`・`moderation.models` (ブロックの読み取りだけ。moderation の service には依存しない)、`notifications → groups` (通知文の名前)、`webhooks → admin (bot ユーザー), channels, messages`、`drafts → channels, messages` (メンバー確認とスレッドの親)、`channel_links → channels`、`canvases → channels, audit, attachments, messages` (メンバーシップ・権限・DM の相手の名前。M42: 本文の画像の bind と完全削除時の削除、会話への共有メッセージの投稿。整理の周期ジョブは参照されなくなった画像を `attachments` の表から探し、削除の印は `attachments` の service が付ける。M72: `canvases → groups, users` でメンションの展開と宛先)、`tasks → canvases` (M72: チェックリストの行から作るタスクの確認。M80: 同じトランザクションで行に印を書く・チェックを付け外しする `canvases.link_task_in_tx` / `follow_task_in_tx`)、キャンバスの保存でチェックが変わったときのタスクの追従は `main.py` が `canvases.set_task_ticks_handler(tasks.follow_canvas_ticks)` で注入する (canvases は tasks に依存しない、M80、CANVAS.md §22)、`notifications → canvases` と realtime の中継 → `canvases` (M72: メンションのプッシュ、`canvas_presence` の宛先。読み取りだけ)、`sync → canvases` (bootstrap の `canvas_tab_id`)、`notifications → threads` (手動で外したスレッドは通知しない)、`reminders → channels, messages` (元のメッセージと所属から文面を作る)、`threads` / `bookmarks` は `channels` の `ChannelMember` を読み取り専用で参照 (メンバーでなくなった行を外す)、`attendance → audit, users, groups.models（自分用の状態の規則）, link_previews.fetcher（送信先の SSRF の検査）, workspace（Webhook の workspace の id）`（M140、docs/PRESENCE.md。送信の配送は outbox の relay のハンドラ `AttendanceWebhookPlanner` が作り、`main.py` のループが送る。`channels` は宛先の規則のためにイベント名だけを知る）、`sync → attendance`（bootstrap の `attendance`）、`users` の router → `channels.shared_member_ids()` (guest の一覧絞り込みだけ、M13e)、`channels → users, reads`、`messages → channels, users, attachments, reads`、
   `attachments → channels`、`search → channels (+ 読み取り例外)`、
   `notifications → channels, users, auth (端末一覧), reads`、`sync → *`。
   M120（WIKI.md §11.3）：`wiki → users, groups, attachments, audit, core.doctext`、`wiki → canvases`（テンプレートの読み取り
   だけ）、`wiki → activity.canvas_mentions`（メンションの抜粋の純粋な関数）。`wiki` は `channels` に依存しない。`canvases →
   core.doctext`。`search → wiki`、`activity → wiki.access / wiki.models` (読めるページの通知だけを出す)、`notifications → wiki`
   （プッシュの前に読めるかを確かめる）、`admin → wiki`（匿名化で `user` の項目を消す）、`sync → wiki`（bootstrap の
   `change_seq`）。添付の読み出しの判定は `main.py` が `attachments.set_page_access_check(wiki.can_read)` で注入する
   （attachments は wiki に依存しない）。outbox の audience `page` は `main.py` が `wiki.events.audience_resolver(channels の解決)`
   で組み立てる。
   M88: `channels → workspace` (設定の読み取り: プレビューの可否と参加・退出の表示)。参加・退出の一言を書くのは `messages`
   で、`messages` が import 時に `channels.set_membership_writer(post_membership_in_tx)` で登録する (channels は messages に
   依存しない、docs/MEMBERSHIP.md §1)。`workspace → audit` (設定の変更の監査)。
   M90: `workspace.service → channels.models` (既定のチャンネルの検証。service には依存しない)。既定のチャンネルに入れる
   処理は別のファイル `workspace/default_channels.py` (`→ channels, workspace.service, audit`) に置き、`admin`
   (`create_user_in_tx`) と workspace の router が使う (channels → workspace.service と循環しないため、MEMBERSHIP.md §6)。
   M141（閉じた DM、DATA_MODEL.md conversation_closes）：`dm_closes → channels, reads, dm_pins, messages`（メンバーの確認、閉じるときの既読と固定の解除、閉じる位置をメッセージの採番と同じチャンネル行のロックの中で読む `messages.lock_last_seq_in_tx`。Review v0.1.43 #6）。閉じているかの判定のため `messages.models` と `channels.models` の `ChannelMember` を読み取り専用で参照する（`dm_pins` と同じ）。既にある DM を返す `POST /dms` で開くのは `dm_closes` が import 時に `channels.set_dm_resolved_hook` で登録する（channels は dm_closes に依存しない）。
   `audit` も葉: `admin` / `auth` / `channels` が同一トランザクション内で `audit.record_in_tx()` を呼ぶ (M10)。
   `reads` は葉 (どのモジュールにも依存しない): 参加時の既読位置の初期化は `channels` が、送信者の既読は
   `messages` が同一トランザクション内で呼ぶ。`PUT /channels/{id}/read` は `channels` の router に置く
   (メンバー判定が `channels` にあるため。M8b で `reads → channels` から変更)。
   `events/` と `realtime/` は modules に依存しない。配信先 (audience) の解決に必要な関数は
   `main.py` で `OutboxRelay` に注入する。
5. `core/` はどのモジュールにも依存しない（`core/doctext` も。メンションのトークンの正規表現は `messages.mentions` と同じものを
   持ち、テストで一致を確かめる）。

## 6. リクエストとイベントの流れ

```
POST /api/v1/channels/{id}/messages   (client_msg_id 付き)
  |
  v
[BEGIN]
  SELECT ... FROM messages WHERE sender_id = $me AND client_msg_id = $key         -- 冪等: 既にあれば 200 で既存を返して終了
  UPDATE channels SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq   -- seq 採番。行ロックで直列化
  INSERT INTO messages (id=uuid7, seq, updated_seq=seq, client_msg_id, body, ...) -- 一意制約が同時再送の最後の砦 (違反時はロールバックして既存を返す)
  UPDATE read_states SET last_read_seq = GREATEST(last_read_seq, seq) ...        -- 送信者自身は既読 (M8 以降)
  INSERT INTO outbox_events (event_type='message.created', channel_id, seq, audience_type='channel', payload)
  INSERT INTO outbox_events (event_type='read.updated', audience_type='user', audience_id=sender, payload)
  SELECT pg_notify('outbox', '')                                                  -- COMMIT 時に配送される
[COMMIT] --> 201 { message }

OutboxRelay  (専用接続で LISTEN outbox。通知が無くても 1 秒ごとに poll)
  |
  v
[BEGIN]
  SELECT * FROM outbox_events WHERE processed_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED
  for each row:
      audience  = resolve(row)             -- channel: 現在のメンバー / user / session / all
      for handler in durable_handlers:     -- 例: PushPlanner -> INSERT push_deliveries
          handler.handle(row, session)
      UPDATE outbox_events SET processed_at = now() WHERE id = row.id
[COMMIT]
  |
  v
EventBus.publish(envelope)     -- 揮発。in-memory
  |
  +--> RealtimeHub.on_event(): audience の user_id を持つ全 WS 接続に送信

PushSender  (ループ): push_deliveries (pending, next_attempt_at <= now) -> APNs / FCM -> 状態更新
```

ポイント:

- **順序**: 同一チャンネル内の seq 消費は `channels` 行ロックで直列化されるため、コミット順 = seq 順 =
  outbox id 順になる。Relay が id 順に処理する限り、チャンネル内のイベント順序は保たれる。
  異なるチャンネル間の順序は保証しないし、必要もない。
- **at-least-once**: Relay がハンドラ実行後・`processed_at` 更新前にクラッシュすると同じイベントを再処理する。
  永続ハンドラは冪等に作る (`push_deliveries` の `UNIQUE (event_id, device_id)`)。
  メッセージのコミット後にサーバが落ちても、outbox 行が残っているので通知イベントは失われない。
  WS 配信は揮発で、取りこぼしはクライアント側の差分同期で回復する。
- **配信先解決は Relay で行う**。Hub は「user_id → 接続」しか知らない。これにより Redis 導入時も Hub の
  責務は変わらない。
- **outbox を通らないもの**: typing、presence、ping/pong。これらは Hub が直接扱う揮発イベント (M11b で実装)。
  presence は Hub の接続表と `ping` の `active` から導出し (online / away / offline)、変化したときだけ全接続に流す。
  typing は WS ルータがメンバー判定をしてから他のメンバーの接続に中継する。

## 7. プロセスモデル

v1 は **単一プロセス** で動かす: `uvicorn app.main:app --workers 1`。
API、WS Hub、OutboxRelay (CLAUDE.md の "background worker")、PushSender、周期ジョブはすべて lifespan で
起動する asyncio タスク。

理由: in-memory EventBus は 1 プロセス内でしか機能しない。WS 接続を持つプロセスと Relay が同じ
プロセスにいる必要がある。数十人・数百接続なら 1 プロセスで十分に捌ける (I/O バウンド)。

設定 `RUN_BACKGROUND_TASKS` (default: true) で背景タスクの起動を切り替えられるようにし、将来
worker を分離できる余地だけ残す (分離には Redis が必要。§10)。

プロセスローカルな状態 (Redis 導入時に外出しが必要なもの):

- WS 接続レジストリ (user_id / session_id → connections)
- presence / アクティブ判定 (プッシュ抑制に使う)
- レートリミットのカウンタ
- EventBus の購読者

CPU を食う処理 (画像サムネイル生成、argon2) は `run_in_threadpool` で逃がす。
動画の縦横・ポスター (M79) は ffprobe / ffmpeg のサブプロセスで、イベントループは待つだけ (時間切れと同時実行数の
上限付き。SECURITY.md §4 「動画」)。ffmpeg はサーバのイメージに Debian のパッケージで入れる。

## 8. データストアとバックアップ

- **PostgreSQL**: 全ドメインデータ、セッション、outbox、push_deliveries、検索インデックス (PGroonga)。
  スキーマは DATA_MODEL.md。
- **versitygw**: S3 互換のオブジェクトストレージ。posix バックエンドで、バケットはディレクトリ、オブジェクトは
  通常のファイルとして `/data/<bucket>/<key>` に置かれる。添付ファイル本体とサムネイル (動画はポスター、M79) を格納する。キーは
  `attachments/{id}`、`attachments/{id}.thumb.jpg`。バケットは非公開。クライアントはオブジェクトストレージに
  直接アクセスせず、API 経由で読み書きする (§10 の presigned URL は将来の最適化)。大きなファイルを PostgreSQL に
  入れない。アプリは `BlobStore` (S3 API) 経由でしか触らないので、他の S3 互換ストアやクラウドの S3 に
  差し替えられる。オブジェクトのメタデータ (content type 等) は PostgreSQL が正で、ストレージ側の拡張属性に
  依存しない。当初の候補だった MinIO はコミュニティ版が終了した (2026-04 にリポジトリ archive、公式イメージ削除)
  ため採用しない (D19)。

### バックアップと復元 (容易さを設計要件にする)

状態の置き場所を **PostgreSQL 1 つとオブジェクトストレージのディレクトリ 1 つ** に限定する。プロセス内の状態は再起動で
消えてよいものだけにする (§7)。したがってバックアップ対象は次の 3 つだけ:

| 対象 | 方法 | 備考 |
| --- | --- | --- |
| PostgreSQL | `pg_dump -Fc` を毎日 | outbox / push_deliveries を含めてよい (復元後に再処理されても冪等) |
| オブジェクトストレージ | versitygw のデータディレクトリを毎日写す (`infra/backup.sh`)。増分で、前回から変わっていないファイルは前回のバックアップへのハードリンクにする (添付 7 GB でも 14 世代で 7 GB + 日々の増分。2026-09-28 に tar 全体から変更)。全ファイルの sha256 を添える。オブジェクトは通常のファイルなので専用ツールは不要 | DB の後に取る。DB に無い blob は無害、DB にあって blob が無いものは復元後に検出する。拡張属性が失われてもアプリは PostgreSQL のメタデータを使うので影響しない |
| 設定・秘密情報 | `.env` と秘密ファイルを別経路で保管 | リポジトリには置かない |

復元は「DB 復元 → バケット復元 → app 起動 → `app.cli verify-attachments` で欠損 blob を報告」の順。
手順書と復元リハーサルは M10 で整備する (`infra/README.md`)。

## 9. API の全体像

すべて `/api/v1` 配下。認証は `Authorization: Bearer <access_token>`。詳細なスキーマは
コードから生成した `openapi/openapi.json` を正とする (CI で差分チェック)。3 クライアントは同じ仕様を使う。
クライアントに影響する API 変更は必ず仕様 (生成物) の更新を伴う。

| 領域 | エンドポイント |
| --- | --- |
| Auth | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/sessions`, `DELETE /auth/sessions/{id}`, `PUT /devices/current` (プッシュトークン等の登録・更新)。M48: `GET /auth/methods`、`GET /auth/sso/google/start`・`callback`、`POST /auth/sso/exchange` (docs/SSO.md) |
| Users | `GET /users`, `GET /users/{id}`, `GET/PATCH /users/me`, `PUT /users/me/password` |
| Admin | `POST/GET /admin/users`, `PATCH /admin/users/{id}` (role / deactivate), `POST /admin/users/{id}/reset-password`, `DELETE /admin/users/{id}/sessions`, `GET /admin/audit-logs` |
| Channels | `GET /channels` (自分の所属 + `?include=public`), `POST /channels`, `GET/PATCH /channels/{id}`, `POST /channels/{id}/archive`, `POST /channels/{id}/join`, `POST /channels/{id}/leave`, `GET/POST /channels/{id}/members`, `DELETE /channels/{id}/members/{user_id}` |
| DM | `POST /dms` (`{user_ids}`; 既存があればそれを返す) |
| Messages | `GET /channels/{id}/messages` (履歴: `before_seq`, `limit`。カーソル方式), `GET /channels/{id}/sync` (差分: `since_seq`, `limit`), `POST /channels/{id}/messages`, `GET/PATCH/DELETE /messages/{id}`, `GET /messages/{id}/replies`, `PUT/DELETE /messages/{id}/reactions/{emoji}` |
| Reads / 通知設定 | `PUT /channels/{id}/read`, `PUT /channels/{id}/notification-preference` |
| Sync | `GET /sync/bootstrap`, `GET /sync/summary` (開いていないワークスペースのバッジ), `WS /ws` |
| Server | `GET /server` (認証不要。ワークスペース名と `workspace_id`。WORKSPACES.md) |
| Attachments | `POST /attachments` (multipart), `GET /attachments/{id}`, `GET /attachments/{id}/content`, `GET /attachments/{id}/thumbnail` |
| Canvases (M41・M42、CANVAS.md §4.5) | `GET/POST /channels/{id}/canvases` (`?trashed=true` でゴミ箱), `GET /canvases` (自分の会話すべて、cursor), `GET/PATCH/DELETE /canvases/{id}` (GET は ETag / If-None-Match), `PUT /canvases/{id}/content` (保存: `base_rev_id` + 冪等キー、サーバ側マージ、409 `canvas_conflict` / `canvas_base_expired`), `POST /canvases/{id}/restore`, `POST /canvases/{id}/share` (M42: 会話へ共有。作成時の `share_to_channel` も), `GET /canvases/{id}/revisions`, `GET/PATCH/DELETE /canvases/{id}/revisions/{rev}`, `POST /canvases/{id}/revisions/{rev}/restore`, `GET /canvas-templates`, `GET/POST/PATCH/DELETE /admin/canvas-templates[/{id}]` |
| Search | `GET /search/messages` (`q`, `channel_id`, `from_user_id`, `after`, `before`, `limit`, `offset`。ランキング結果なので offset。応答は `hits[].message` と `keywords`)、`GET /search/canvases` (M42、CANVAS.md §4.8: 同じ引数と `sort`。自分がメンバーの会話のキャンバスだけ。応答は `hits[].canvas` (本文なし) と `snippet`、`keywords`) |
| Health | `GET /healthz` (プロセス生存), `GET /readyz` (DB / オブジェクトストレージ到達性) |

### エラー形式と分類

```json
{ "error": { "code": "not_a_member", "message": "You are not a member of this channel", "details": {} } }
```

`code` は安定した文字列で、クライアントはこれと HTTP ステータスで分岐する。エラーを握りつぶさない。

| 分類 | HTTP | 代表的な `code` | クライアントの扱い |
| --- | --- | --- | --- |
| 認証エラー | 401 | `token_expired`, `invalid_token`, `session_revoked`, `invalid_credentials` | `token_expired` は refresh して 1 回だけ再試行。それ以外はログアウト |
| 権限エラー | 403 | `forbidden`, `not_a_member`, `admin_required`, `password_change_required` | 再試行しない。ユーザーに表示 |
| 検証エラー | 400 / 422 | `validation_error` (details に項目), `message_too_long` | 再試行しない。入力を直す |
| 見つからない | 404 | `channel_not_found`, `message_not_found` | 再試行しない。ローカルの該当データを見直す |
| 競合 | 409 | `channel_archived`, `idempotency_conflict`, `name_taken` | 再試行しない |
| レート制限 | 429 | `rate_limited` (`Retry-After`) | 指定時間後に再試行 |
| 一時的なサーバエラー | 502 / 503 / 504 (+ 500) | `server_error`, `unavailable` | バックオフ付きで再試行。書き込みは idempotency key があるので重複しない |
| ネットワークエラー | (応答なし) | — | 同上。応答を受け取れなかった書き込みも同じ key で再送する |

画面に出す文言は、サーバの英語の `message` ではなく `apps/shared/errors.json` の日本語 (コード別、無ければ
HTTP ステータス別、通信エラーは専用の文言) を使う。表は `apps/shared/gen_errors.py` で 3 クライアント分を生成し、
サーバのテスト (`tests/test_error_codes.py`) がサーバの使うコードがすべて表にあることを確かめる。
JSON でないエラー応答 (プロキシの HTML の 502 など) はステータスだけで分類する。

## 10. 拡張経路 (今はやらないが塞がない)

| 将来の要求 | 変更箇所 | 影響しないもの |
| --- | --- | --- |
| API プロセスを複数にする / worker 分離 | `EventBus` を `RedisEventBus` (pub/sub) に差し替え (`EVENT_BUS=redis`)。Relay は 1 プロセスだけで動かす。presence / ratelimit を Redis に移す | outbox、ハンドラ、Hub のインタフェース、クライアント |
| 添付の直接アップロード / ダウンロード | `BlobStore` に presigned URL 発行を追加。API は URL を返す | アクセス制御の判定 (API に残る) |
| ~~Web ブラウザクライアント~~ (M12j で実装) | 同一オリジン配信なので CORS 追加は不要。refresh token は HttpOnly cookie + `X-Requested-With`、WS は Origin 検証 (SECURITY.md §2.3 / §2.4) | データモデル、同期プロトコル |
| OIDC ログイン | `auth` に provider を追加。session の仕組みはそのまま | |
| 検索の高度化 | PGroonga の tokenizer / ranking 調整。Elasticsearch は不要 | |
| 通知の細分化 (quiet hours 等) | PushPlanner の判定ルールと `notification_preferences` の列追加 | 配送の仕組み |

EventBus の境界: **outbox に書くのはドメインモジュール、publish するのは OutboxRelay だけ、subscribe するのは
RealtimeHub だけ**。永続的な処理は必ず outbox の永続ハンドラで行い、EventBus には乗せない。
例外（2026-10-06）：AI ボットの「入力中」（docs/AI.md §2.2 の 6）は、保存しない揮発フレーム（`Envelope.volatile`）として
AI のループが publish する。失っても次の 3 秒で送り直すだけなので outbox は通さない。EventBus に乗せるのは、Redis に
替えたときに WS を持つ全プロセスへ届くようにするため（このループは Relay と同じく 1 プロセスだけで動かす）。
この 3 点を守っていれば、`InMemoryEventBus` を `RedisEventBus` に差し替えても動作は変わらない。

### 将来の AI 検索 / RAG への備え

意味検索、会話の要約、決定事項やタスクの抽出、過去の議論への QA は初期実装の範囲外だが、
次の点を守ることで後から足せる形にしておく。

- **本文はプレーンテキストで保存し、文脈が復元できる列を持つ**: `messages.body`、`channel_id`、`sender_id`、
  `parent_id` (スレッド)、`created_at`、`seq`。チャンク化・埋め込み・出典表示に必要な情報がすべて揃う。
  アプリ層での暗号化はしない。
- **増分インデックスの入口がすでにある**: outbox の永続ハンドラを 1 つ追加すれば `message.*` を購読できる。
  バッチ処理なら `(channel_id, updated_seq)` の高水位を保持して差分を取れる。変更フィードを新設しなくてよい。
- **ベクトルは同じ PostgreSQL に置く**: `pgvector` 拡張と `message_embeddings (message_id, model, chunk_index,
  embedding, updated_seq)` テーブル (DATA_MODEL.md §6)。PGroonga (語彙) と pgvector (意味) を同じ SQL で
  組み合わせ、**メンバーシップによる権限フィルタを 1 か所 (`search` モジュール) に保つ**。
  Docker イメージは PGroonga と pgvector の両方を含む形にビルドし直す必要がある (M9 で確認)。
- **一括エクスポート**: チャンネル単位の JSONL エクスポート CLI を M10 で用意する。バックアップ検証と
  オフラインの AI 処理の両方に使える。
- LLM 呼び出しは `ai` モジュールとして追加し、既存モジュールの読み取り専用 service だけを使う。

## 11. クライアント共通アーキテクチャ

各クライアントは次の構造で作る (詳細は SYNC_PROTOCOL.md)。

- **ローカルストア (SQLite)** を唯一の表示ソースにする。画面はストアを購読して描画する
  (単方向データフロー)。ネットワーク応答を直接画面に流さない。
- ストアには `users`、`channels` (+ `synced_seq`、read state、未読数、通知設定)、`messages`、`attachments`
  メタ、`outbox` (未送信メッセージ) を持つ。端末の再起動後もカーソルから再開できる。
- 起動 / 再接続時は WS 接続 (hello) → bootstrap → 開いているチャンネルの差分取得、の順。
  hello 以降のイベントはバッファして bootstrap の後に適用する。
- 送信は楽観的に表示し、`client_msg_id` で応答 / イベントと突き合わせる。再送しても重複しない。
- 受信イベントは「seq が大きければ上書き」の規則で冪等に適用する。
- プッシュ通知は「新しいデータがあるかもしれない」という合図としてのみ扱い、受信後は同期する。
- 認証情報は iOS は Keychain、Android は Android Keystore で保護したストレージ、Desktop は OS の
  資格情報ストア (Keychain / Credential Manager) に保存する。
- 複数のワークスペース (= 複数のサーバー) を登録して切り替えられる。ローカルストアと資格情報は
  ワークスペースごとに分ける (WORKSPACES.md)。

## 12. 横断的関心事

- **ID**: 主キーは UUIDv7 (時刻順、サーバ生成)。`outbox_events` と `push_deliveries` は bigserial。
- **時刻**: サーバの UTC が正。並び順や同期にクライアントの時計を使わない。API は ISO 8601 (UTC, `Z`)。
  クライアントが送る user_id、時刻、ロール、権限は信用しない。送信者は認証情報から決める。
- **設定**: 環境変数 (`pydantic-settings`)。`.env.example` を `infra/` に置く。秘密情報はコミットしない。
- **ログ**: JSON 構造化。`request_id` を全ログに付与。トークン・パスワード・メッセージ本文は出さない。
- **エラー**: `AppError(code, status, message)` を service で raise し、`core/errors.py` で HTTP に変換 (§9)。
- **テスト**: pytest。DB を伴うテストは実 PostgreSQL (Docker Compose の `db`) に対して実行する。
  同期プロトコルは契約テスト (JSON フィクスチャ) で 3 クライアントと共有できる形にする。
- **可観測性**: `/healthz`、`/readyz`、構造化ログ。メトリクス (Prometheus) は必要になったら。
- **OpenAPI**: コードから生成し `openapi/openapi.json` にコミット。クライアントは型を生成して使う。

## 13. 主要な設計判断 (decision log)

| # | 判断 | 理由 | 却下した代替案 |
| --- | --- | --- | --- |
| D1 | 単一プロセス + `InMemoryEventBus` | 数十人・数百接続なら十分。Redis なしで WS 配信を成立させる最小構成 | 最初から Redis pub/sub (運用対象が増える) |
| D2 | Transactional Outbox + `LISTEN/NOTIFY` で起床 | ドメイン変更とイベント発行の原子性。NOTIFY により polling でも遅延は ms 単位 | コミット後に直接 publish (クラッシュで欠落)、1 秒 polling のみ (遅延) |
| D3 | メッセージ ID は UUIDv7、順序はチャンネル内 `seq` | ID は参照用、seq は順序 / カーソル / 既読位置用と役割を分ける。順序をクライアント時刻に依存させない | Snowflake ID を順序にも使う (クロック依存、隙間あり) |
| D4 | 状態ベースの差分同期 (`updated_seq > cursor`) | イベントログの再生より単純。編集・削除・リアクションも同じ経路で回復できる | outbox をログとして保持しクライアントに再生 (ギャップ / 順序問題の処理が増える) |
| D5 | DM / グループ DM は `channels` の一種 | messages、既読、同期、検索のコードを一本化できる (CLAUDE.md の方針) | DM 専用テーブル |
| D6 | 既読位置は `read_states (user_id, channel_id)` の 1 行 | ユーザー × チャンネルの基数。メッセージごとの既読行は作らない (CLAUDE.md)。未読数は seq 範囲の COUNT で導出 | `channel_members` に畳む (初稿の案。エンティティ分離の指定に合わせ変更)、メッセージごとの既読行 |
| D7 | WS は受信専用、書き込みは REST | 冪等性・認可・エラー処理を HTTP に一本化 | WS 双方向 (再送・ack の独自設計が必要) |
| D8 | 添付は API 経由でオブジェクトストレージに読み書き | アクセス制御を API に集約。ストレージを外部公開しなくてよい | presigned URL (ホスト名 / 公開範囲の問題が増える) |
| D9 | 全文検索は PGroonga | 日本語 / 英語対応、追加ミドルウェア不要、権限フィルタを SQL で書ける。将来 pgvector と同居できる | Elasticsearch、`pg_trgm`、`tsvector` (日本語が弱い) |
| D10 | access token は JWT 15 分、refresh は不透明トークンをローテーション + 再利用検知 | 標準的な構成。リクエストごとに session 行を確認し即時失効を可能にする | 長寿命 JWT のみ (失効できない) |
| D11 | プッシュは「起床のヒント」。真実は同期 | プッシュは欠落 / 遅延 / 重複 / 順序入れ替わりが前提 (CLAUDE.md) | プッシュを配信経路として信頼する |
| D12 | 1 デプロイ = 1 ワークスペース | テナント分離のコストを払わない | `workspace_id` を全テーブルに持つ |
| D13 | 削除はトゥームストーン (soft delete) | 差分同期で削除を伝搬できる。参照整合性が保てる | 物理削除 |
| D14 | クライアントはプラットフォームごとにネイティブ実装、ロジック共有はプロトコル仕様と契約テスト | CLAUDE.md の指定 (Tauri/React、SwiftUI、Compose) | Flutter / KMP でコード共有 |
| D15 | OpenAPI はコードファースト | FastAPI の生成物を正とし、ドリフトを防ぐ | 仕様ファースト (二重管理) |
| D16 | ユーザーは管理者が作成し、初回ログインでパスワード変更を強制 | 自由登録なし (CLAUDE.md)。招待リンクより単純 | 招待リンクによる自己登録 (初稿の案) |
| D17 | Device と Session を分け、ログインごとに Device 行を作る | 端末 (プッシュトークン、名前、バージョン) と資格情報 (refresh token) のライフサイクルが違う。1 ユーザー複数端末・複数トークンを自然に表せる | sessions に端末情報を持たせる (初稿の案) |
| D18 | AI / RAG は範囲外だが、本文プレーンテキスト保存・増分入口・同一 DB のベクトル拡張で備える | CLAUDE.md の将来要件。専用基盤を今は作らない | 埋め込みパイプラインの先行実装 |
| D19 | オブジェクトストレージは versitygw (posix バックエンド) | MinIO コミュニティ版の終了 (2026-04 archive、イメージ削除) を受けて 2026-09-26 に決定。S3 API をディレクトリの上に載せるだけなので 1 台構成で最も単純、バックアップはファイルコピー、Apache-2.0 | RustFS (MinIO 互換だが 1.0 直後)、Garage (AGPL、分散前提)、アプリ内ローカル FS 実装 (S3 互換の要件から外れる) |
| D20 | ワークスペースの追加・切り替えはクライアント側で複数サーバーを登録して行う | D12 を保ったまま Slack / Mattermost と同じ操作を提供できる。サーバーの変更は `GET /server`、`GET /sync/summary`、プッシュの `workspace_id` だけ (2026-09-27) | 1 サーバー内に複数ワークスペース (テナント列、権限、検索の分離が全体に及ぶ) |
| D21 | 本番への自動デプロイはタグ → GitHub Actions → GHCR → SSH の強制コマンド → `docker compose` の入れ替え | 1 台の VPS に数十人規模なら compose のままで足りる。イメージをレジストリに置くとサーバでビルドせずに済み、タグで戻せる。デプロイ前のバックアップと /readyz による確認・自動ロールバックを `infra/deploy.sh` に持たせる (2026-09-27) | Kubernetes / Argo CD (過剰)、サーバ上で git pull してビルド (サーバに Git の権限とビルド環境が要る)、Watchtower (イメージの自動更新が DB バックアップやマイグレーションと連携しない) |
| D22 | 他のサイトの nginx が 80 / 443 と証明書 (certbot) を持つ共用サーバーでは、nginx が TLS を終端し、Caddy は `127.0.0.1:18080` の HTTP だけを受ける (`docker-compose.behind-proxy.yml`) | 既存のサイトに手を入れずに同居できる。Caddyfile (配信するもの、本文サイズ、CSP) は両方の構成で同じものを使う。利用者のアドレスと https は nginx が上書きした `X-Forwarded-For` / `-Proto` を、この構成でだけ Caddy が信用して (`trusted_proxies`) アプリに渡す (2026-09-27) | nginx から app へ直接 (Web クライアントの配信と CSP を nginx 側に二重に持つ)、Caddy に 443 を譲る (既存のサイトが止まる) |
| D23 | iOS の会話 (チャンネル・スレッド) は上下を反転した一覧 (スクロールビューを反転し、各行を元の向きに戻す。`UpsideDownList.swift`) | 最新の行がスクロールの原点に来るので、スクロールビューが原点を保つだけで「最新は入力欄のすぐ上」が成り立つ。キーボード・候補バー・入力欄の伸び縮み、送信・受信 (行の移動をアニメーションで)、短い会話が下に寄ること、古いページ (遠い端に入る) が、位置を補正するコードなしで正しくなる。途中を読んでいるときの受信は SwiftUI の `scrollPosition(id:)` が見ている行を保つ（チャンネルの行は LazyVStack。スレッドは返信 200 件まで VStack で、上を読んでいる間は来た行をアニメーションなしで入れる。LazyVStack では推定の高さと実際の高さの差で位置が組み直され、開くときやキーボードで行が数百 pt 跳ねた、2026-10-07。保つ行は、最新の端（原点から 40 pt 以内）では新しい行が来るときに端の目印にし、自分の送信は途中をくぐらず最新の端へ飛ぶ。`UpsideDown.arrival`、2026-10-07、MOBILE_UI.md 6.6）。上から並べて下端に合わせ続ける方式では、アンカー・キーボード追従・スライド・補正が 700 行を超え、補正どうしがぶつかって送信のたびにガクついた (ビルド 21〜30、2026-09-30) | 下端合わせの補正を続ける (場合ごとにずれが残る)、UICollectionView に書き直す (反転で足りた。行は SwiftUI のまま) |
| D24 | キャンバスは Markdown 全体 + 版 (`base_rev_id`) + サーバ側の 3-way マージ (行 → 語句)。CRDT は保留 (M41、CANVAS.md §3) | 3 端末ともネイティブのエディタのまま作れ、マージのコードはサーバ (Python、標準の difflib) の 1 か所で済む。数人がときどき同時に書く規模なら、自動保存 (約 2 秒) とマージで十分。保存は行ロックで直列化し、重なりは黙って消さず競合として本人に見せる | ブロック型 (エディタを 3 つ作る費用)、Yjs / Automerge (バインディングが 1.0 前、モバイルが WebView になる、WS 受信専用 D7 の例外が要る) |
| D25 | 製品の表示名は「Taylis」(先頭だけ大文字。ドメイン `chat.example.com` は小文字)。ID は「chikuwachat」のまま変えない: バンドル ID / applicationId / パッケージ名 / Tauri の `identifier`、URL スキーム `chikuwachat://`、Keychain・App Group・プッシュの topic、`GET /server` の `product`、リポジトリ・Docker イメージ・compose・ディレクトリ・環境変数・DB・OpenAPI の operation id とスキーマ名・モジュール名・Xcode のプロジェクト / ターゲット名 (2026-10-03) | 表示だけを変えれば、入れ直しやデータ移行なしで今の端末・サーバーがそのまま続く (ID を変えると別アプリ扱いになり、ログイン情報・ローカルの保存・プッシュの登録が失われる) | ID も含めて全部を改名する (端末ごとの入れ直しと再ログイン、プッシュの再設定、イメージ名・デプロイの切り替えが要る) |
| D26 | 音声・ビデオの通話は自前の LiveKit (SFU、組み込みの TURN) を同じ compose の 1 コンテナとして置き、認可 (トークンの発行)・部屋の作成・参加者の記録はアプリのサーバが持つ。共用の VPS では、シグナリングは既存の nginx の後ろの専用のホスト名 (`livekit.<domain>`)、メディアは 7882/udp の 1 ポートと 7881/tcp、TURN は 3478/udp と 5349/tcp (443 は nginx のまま)。会議リンクの通話 (M117) は置き換えて廃止する (docs/CALLS.md、2026-10-07 利用者の決定)。M130 (2026-10-07) でサーバと infra (compose の `calls` プロファイル) を作った | WebRTC の SFU・ICE・simulcast は自分で書くものではなく、LiveKit は Apache-2.0 で 3 端末の公式 SDK がある。1 ノードなら Redis が要らない。トークンをアプリが出せば、メンバー・ブロック・アーカイブの規則が 1 か所に残る。1 ポートの UDP はファイアウォールの穴とブリッジ網の負担が小さい。nginx の SNI 振り分けで 443 を分けるとほかのサイトの設定が全部変わる | 会議リンクのまま (M117。アプリの外に出る・主催者のサインイン・通話の状態が分からない)、Jitsi を自前で立てる (Prosody・Jicofo・JVB の 3 つを運用し、モバイルは SDK が大きい)、P2P の WebRTC だけ (3 人以上で上りが人数分になる、TURN は結局要る)、mediasoup / Janus (SDK を自分で揃える) |
| D27 | ドキュメント（Notion の置き換え）は会話のキャンバスを広げずに別の実体 `wiki_pages` として作り、本文の部品（Markdown の方言・3-way マージ・保存の手順・版の整理）は `core/doctext` でキャンバスと共有する。権限は Notion と同じ「親から受け継ぐ + ページごとに足す / 絞る」（相手はワークスペース・グループ・人、段階は閲覧・編集・フル。ゲストは名前を挙げたときだけ）で、受け継いだ結果を実効の表 `wiki_effective_grants` に持ち、木の形と権限の変更のたびに 1 つの advisory lock の下で同じトランザクションのうちに部分木を計算し直す。読めないページはどの経路でも 404（存在ごと隠す）。管理者も黙っては読めず、題名の一覧と監査ログに残る引き取りだけ（M120、docs/WIKI.md §2・§4、2026-10-07 利用者の決定） | 権限の判定がページの 1 か所（`wiki/access.py`）に閉じ、会話のメンバーシップの分岐をキャンバスのコードに入れずに済む。キャンバス（M41〜M83、3 端末）を作り直さない。実効の表なら 1 ページの判定は索引 1 回、読める集合は 1 回の問い合わせで、深さに依存しない（1 万ページで判定 0.7 ms、読める集合 5 ms、1,000 ページの移動 80 ms）。全部の計算し直し（`cli wiki-acl --verify`）と比べてずれを検出できる | キャンバスに「持ち主 = 会話 | ウィキ」を足す一般化（全関数に権限の分岐、1 か所の見落としが漏れになる）、判定のたびに祖先を再帰でたどる（深さと件数に比例、検索の絞り込みが重い）、会話のメンバーで共有を決める（研究室の「教員だけ」「M2 だけ」を表せない） |
| D28 | スマホ（iOS / Android）の見たまま編集は、Desktop / Web と同じ TipTap のページエディタを 1 つの HTML + JS + CSS に束ねてアプリに同梱し（`apps/shared/mobile-editor/dist`、`npm run build:mobile-editor`。ネットから読まない）、編集のときだけ WKWebView / Android WebView で出す。読む画面・木・一覧・保存の状態機械・保存待ち・オフラインはネイティブのまま。エディタはサーバと話さず（CSP `connect-src 'none'`、アクセストークンを JS に渡さない）、本文・人・ページ・絵文字・画像・リンクはすべて JSON のメッセージの橋（`apps/shared/mobile-editor/src/bridge.ts`、docs/WIKI.md §30.3）を通る。試作で IME・選択・キーボード・大きなページを OS ごとに確かめ、基準に届かない OS は Markdown の編集のまま（M153a、2026-10-10。設計は WIKI.md §22.7、利用者の希望 2026-10-08） | 往復の正しさ（開いて閉じただけなら 1 バイトも変わらない）を守る変換（`pageMarkdown.ts`）とそのコーパスのテストが 1 つで済み、3 端末で 3 つの変換がずれる事故を避けられる。M150〜M155 のブロック・`/`・`[[`・`@`・選択・ツールバーがそのままスマホに乗り、方言を足す作業も 1 か所。WKWebView / WebView は OS の標準で依存が増えない。エディタの周り（PageEditorEnv）を小さな境界にしたので、Desktop の controller とスマホの橋を同じエディタが使う | 端末ごとのネイティブのエディタ（TextKit 2 / Compose：変換を Swift と Kotlin でもう 2 つ作り、表・数式・囲みをまたぐ選択と IME の落とし穴を 2 度詰める。各 OS 4〜8 週）、サーバから読む Web のエディタ（オフラインで編集できず、版がアプリとずれる）、アプリ全体を WebView にする（方針に反する） |
