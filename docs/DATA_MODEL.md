# DATA_MODEL

PostgreSQL 17 上のデータモデル。DDL は設計上のスケッチであり、実際のマイグレーションは
Alembic で段階的に作る (IMPLEMENTATION_PLAN.md の各マイルストーン参照)。

CLAUDE.md が挙げるエンティティとの対応:
User → `users`、Session → `sessions`、Device → `devices`、Channel → `channels`、ChannelMember → `channel_members`、
Message → `messages`、MessageReaction → `reactions`、ReadState → `read_states`、
NotificationPreference → `notification_preferences`、OutboxEvent → `outbox_events`、Attachment → `attachments`。

前提拡張: `citext` (大文字小文字を無視する一意制約)、`pgroonga` (全文検索、M9)。

## 1. ER 概要

```
users 1---* devices 1---* sessions
users 1---* user_identities   (M48 Google でログイン。sso_requests / sso_tickets は短命)
users 1---* channel_members *---1 channels
users 1---* read_states *---1 channels
users 1---* notification_preferences *---1 channels
channels 1---* messages 1---* reactions
                        1---* attachments
                        1---* messages (parent_id: スレッド返信)
channels 1---* canvases 1---* canvas_revisions   (M41。canvas_templates は独立)
channels 0..1---* calendar_events 1---* calendar_event_alarms *---1 users   (M51。channel_id NULL = 自分用)
channels 0..1---* tasks 1---* task_assignees / task_due_alarms *---1 users   (M55。channel_id NULL = 自分用)
outbox_events (独立。channel_id / audience で配信先を持つ)
push_deliveries *---1 devices   (event_id は outbox_events.id を参照するが FK は張らない)
audit_logs *---1 users (actor)
```

## 2. ID とシーケンスの役割

このシステムには 3 種類の識別子がある。役割を混ぜないこと。

| | `messages.id` (UUIDv7) | `seq` (チャンネル内シーケンス) | `client_msg_id` (UUIDv4) |
| --- | --- | --- | --- |
| 生成者 | サーバ (作成時) | サーバ (`channels.last_seq` を +1) | クライアント (送信前) |
| 一意性 | グローバル | チャンネル内 | 送信者内 (`UNIQUE (sender_id, client_msg_id)`) |
| 性質 | 時刻順だが順序保証なし。隙間だらけ | 隙間なし、厳密単調 (1, 2, 3, ...) | 意味なし |
| 用途 | 参照 (URL、リアクション / 添付の FK、編集・削除の対象指定) | 並び順、履歴ページング (カーソル)、差分同期カーソル、既読位置、未読数 | 再送の重複排除、楽観的 UI の突き合わせ |
| クライアントの扱い | 主キー | ソートキー・カーソル | 送信キューのキー |

メッセージの順序はクライアントの時刻に依存しない。`created_at` は表示専用。

### seq の採番

```sql
UPDATE channels SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq;
```

- この UPDATE がチャンネル行をロックするので、同一チャンネルへの書き込みはコミットまで直列化される。
  → コミット順 = seq 順。差分取得時に「後から小さい seq が現れる」ことがない。
- トランザクションがロールバックすればカウンタも戻るので、seq は隙間なく連続する。
- seq を消費する操作 = チャンネルのタイムラインに影響する操作:
  メッセージ作成・編集・削除、リアクション追加・削除、スレッド返信の作成 (返信自身の seq)。
- seq を消費しない操作: 既読更新、通知設定、チャンネル名変更、メンバー追加・削除、ユーザー情報変更。

### 不変条件

1. `channels.last_seq` = そのチャンネルで採番した最大の seq。`1..last_seq` はすべて使われている。
2. **seq を 1 つ消費するたびに、その seq を持つ outbox イベントがちょうど 1 つ作られる**。
   クライアントはこれを使って WS イベントの欠落を検知する (SYNC_PROTOCOL.md §7)。
3. `messages.updated_seq >= messages.seq`。`updated_seq` は単調増加。
4. `read_states.last_read_seq <= channels.last_seq` (サーバ側で clamp)。
5. `messages` の `(channel_id, seq)` は一意。`updated_seq` は一意でない
   (スレッド返信作成時に親の `updated_seq` も同じ値に更新する)。

## 3. テーブル定義

### users

```sql
CREATE TABLE users (
  id                    uuid PRIMARY KEY,                 -- UUIDv7
  username              citext NOT NULL UNIQUE,           -- 3..32 文字, [a-z0-9._-]
  display_name          text NOT NULL,
  email                 citext UNIQUE,                    -- 任意
  password_hash         text,                             -- argon2id。NULL = Google でログインする人 (M48、パスワードでは入れない)
  must_change_password  boolean NOT NULL DEFAULT true,    -- 管理者が設定した仮パスワードの間は true
  role                  text NOT NULL DEFAULT 'member',   -- 'admin' | 'member'
  timezone              text,
  title                 text,                             -- M11d: 肩書 (プロフィールカード)
  status_text           text,                             -- M11d: カスタムステータス。期限切れは無いものとして返す
  status_emoji          text,
  status_expires_at     timestamptz,
  dnd_until             timestamptz,            -- M12c 通知を一時停止 (過ぎたら無いものとして返す)
  quiet_hours_start     smallint,               -- M12c 分 (0-1439)、start > end なら日をまたぐ
  quiet_hours_end       smallint,
  quiet_hours_days      smallint[],             -- 0 = 月 … 6 = 日 (NULL = 毎日)
  quiet_hours_tz        text,                   -- IANA タイムゾーン。API では quiet_hours {start, end, days, tz}
  notify_keywords       text[],                 -- M12g 通知キーワード (本文に含まれればメンション扱い、20 個まで)
  presence_hidden       boolean NOT NULL DEFAULT false,  -- L4 (M31) 在席を隠す: 他の人には常に offline に見える
  notification_default  text NOT NULL DEFAULT 'mentions', -- M35 通知の全体設定 'all' | 'mentions' | 'none' (UserMe と PATCH /users/me)
  activity_read_at      timestamptz NOT NULL DEFAULT now(), -- M39 アクティビティの既読位置 (項目ごとの既読行は作らない。進むだけ)
  notify_reactions      boolean NOT NULL DEFAULT false,   -- M39 自分の投稿へのリアクションをプッシュする (アクティビティには常に出る)
  notify_tasks          boolean NOT NULL DEFAULT true,    -- M55 タスクの割り当てと期限をプッシュする (TASKS.md §5)
  quick_reactions       text[],                 -- M50 長押しの「リアクションの候補」1〜6 個 (重複なし・普通の絵文字だけ)。NULL = クライアントの規則 (最近使った順、足りなければ既定)
  nav_items             jsonb,                  -- M111 サイドバーの項目 / ホームのタイルの順と表示 [{key, visible}] (64 個まで、key は ^[a-z][a-z0-9-]{0,31}$ で重複なし、知らない key もそのまま保存)。NULL = 既定 (apps/shared/nav-items.json、MOBILE_UI.md §14)
  avatar_key         text,                          -- プロフィール画像のオブジェクトキー (avatars/<user_id>/<uuid>、M14a)
  avatar_updated_at  timestamptz,                   -- 画像の版。UserPublic に載り、クライアントはこれでキャッシュする
  bot_kind              varchar(16),            -- M98 bot の用途。'feed' = チャンネルのフィードのボット (UserPublic.bot_kind、リンクプレビューを自動で取る。SECURITY.md §14)、'reservation' = チャンネルの予約のボット (M99、RESERVATIONS.md)。それ以外の bot と人は NULL
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deactivated_at        timestamptz                       -- 無効化 (ログイン不可、表示は残す)
);
```

自由登録は無い。管理者が CLI または `POST /admin/users` で作成し、仮パスワードを本人に渡す。
削除は無効化のみ。メッセージの `sender_id` 参照を保つ。「削除」(本人の「アカウントを削除」M104、管理者の匿名化 M10) は
行を消さずに匿名化する: `username = deleted-<id の先頭 12 桁>`、`display_name = 退会したユーザー`、個人情報の列を NULL、
`deactivated_at` を付ける (docs/MODERATION.md §2)。

**ユーザー名の変更 (M96)**: ユーザー名は作った後も変えられる (移行なし、`server/app/modules/users/username.py`)。

- 誰が: 本人は `PATCH /users/me {username}` (ゲストも。ほかの欄と同じトランザクションで、どれかが拒まれれば何も変わらない)、
  管理者は `PATCH /admin/users/{id} {username}` (人もボットも、自分も。AI のボットの名前もここで変える)。ボットはログイン
  しないので本人の変更は無い。
- 検証: `^[a-z0-9._-]{3,32}$` (422)、大文字小文字を無視して一意 (citext、`409 username_taken`。2 人が同じ空いた名前を同時に
  取ると、後の方は一意制約で待ってから違反し、トランザクションごと戻して同じ `409 username_taken`: REVIEW-v0.1.30 #7)、グループ名と同じ名前空間
  (`409 username_taken`)、予約語 `here` / `channel` / `everyone` / `all` / `group` (groups の `RESERVED_NAMES`) と
  `deleted-` で始まる名前 (匿名化した人の形) は `409 username_reserved`。今と同じ名前は変更なし (数えない)。
- 本人の変更は 24 時間に 3 回まで (`429 username_change_limited`、`Retry-After`・`details.retry_after_seconds` / `limit` /
  `window_hours`)。数えるのは監査ログの `user.username_changed` で本人が actor の行 (管理者による変更は数えない)。
  管理者は制限なし。
- 同じトランザクションで: `user.updated` (全員へ。クライアントはディレクトリ・`@` の補完・自分の表示を更新)、監査
  `user.username_changed` (`from`・`to`・`by: self | admin`、actor)。管理者の変更は `admin.user_updated` にも残る。
- times: 本人の times の名前が古い名前から作った形 (`times-{古い名前}`、または `-2` … `-20`) のままなら
  `times-{新しい名前}` (使われていれば `-2` …) に変え、`channel.updated` をメンバーへ。手で付けた名前は変えない。
  空きが無ければ名前はそのまま (確かめた後に同時に作られたチャンネルに取られたときも。改名そのものは成功する)。監査の `times_channel {from, to}`。
- 変わらないもの: セッションと refresh token (トークンは user id)、保存されたメンション (`<@id>`、メッセージ・キャンバス・
  タスクの本文)、Google でログイン (アドレスで結び付け)、取り込み (import_refs)、名簿 (並べ替えに今の名前を使うだけ)。
- **古い名前はすぐに解放する** (SECURITY.md §2.9 のなりすましの注意と監査)。古い名前が残る場所 (直さない): 本文に手で打った
  `@古い名前` (補完を使わずに送った字そのもの)、TOTP の認証アプリのラベル (`otpauth://` は設定時の名前)、以前の
  `cli export-channel` の書き出し、取り込みの結果の表、監査の過去の行、端末の資格情報ストアと端末の DB の名前
  (`server|username`。サインインし直すまで古い名前のまま。表示とログイン画面の初期値は今の名前、WORKSPACES.md §4)。

### devices (端末)

```sql
CREATE TABLE devices (
  id                       uuid PRIMARY KEY,
  user_id                  uuid NOT NULL REFERENCES users(id),
  platform                 text NOT NULL,                     -- 'ios' | 'android' | 'desktop'
  push_provider            text NOT NULL DEFAULT 'none',      -- 'apns' | 'fcm' | 'none'
  push_token               text,                              -- 無効になったら NULL に戻す
  push_environment         text,                              -- apns: 'sandbox' | 'production'
  push_token_invalid_reason text,                             -- 'unregistered' | 'invalid_token' (再登録で消す)
  device_name              text,
  app_version              text,
  enabled                  boolean NOT NULL DEFAULT true,     -- ログアウト / セッション失効 / 管理者操作で false
  disabled_reason          text,
  last_seen_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX devices_push_token_uniq ON devices (push_provider, push_token) WHERE push_token IS NOT NULL;
CREATE INDEX devices_user_enabled_idx ON devices (user_id) WHERE enabled;
```

- ログインのたびに 1 行作る (クライアントが `platform` / `device_name` / `app_version` を送る)。
  ログアウトやセッション失効で `enabled = false`。セッションは静かに期限切れになるので、有効な (失効も期限切れも
  していない) セッションが 1 つも無い端末は 1 時間ごとの掃除 (app.main の purge ループ) が
  `disabled_reason = 'session_expired'` で無効にし、プッシュの送信直前にも有効なセッションを確かめる
  (`skipped / session_expired`)。以前は期限切れの端末が有効なままで、本文入りのプッシュを受け取り続けていた (M28a)。
- プッシュトークンは後から `PUT /devices/current` で登録・更新する。同じ `(push_provider, push_token)` が
  別の行にあれば、その行のトークンを NULL にしてから付け替える (端末を別ユーザーが使い始めた場合)。
- 1 ユーザーが複数端末・複数トークンを持つ前提。Desktop は `push_provider = 'none'`。

### sessions (refresh token)

```sql
CREATE TABLE sessions (
  id                  uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES users(id),
  device_id           uuid NOT NULL REFERENCES devices(id),
  refresh_token_hash  bytea NOT NULL UNIQUE,   -- sha256(現在の refresh token)
  prev_token_hash     bytea UNIQUE,            -- 直前のトークン。ローテーション直後の再送を許容するため
  rotated_at          timestamptz,
  last_ip             text,                    -- 文字列で保持 (最大 45 文字)
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,    -- sliding: 最終ローテーション + 30 日。絶対上限は created_at + 180 日
  revoked_at          timestamptz,
  revoke_reason       text                     -- 'logout' | 'reuse_detected' | 'admin' | 'password_changed' | 'expired'
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;
```

1 行 = 1 端末のログイン。access token (JWT) は `sid` にこの id を持つ。ローテーションと再利用検知の
手順は SECURITY.md §2。

### channels

```sql
CREATE TABLE channels (
  id               uuid PRIMARY KEY,
  type             text NOT NULL,              -- 'public' | 'private' | 'dm' | 'group_dm'
  name             citext,                     -- public / private のみ。1..80 文字
  topic            text,
  purpose          text,
  dm_key           text,                       -- dm / group_dm のみ。ソート済み user_id を ',' で結合し sha256 hex
  created_by       uuid REFERENCES users(id),
  last_seq         bigint NOT NULL DEFAULT 0,  -- チャンネル内シーケンスの現在値
  last_message_at  timestamptz,                -- 一覧の並び替え用
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz,
  posting_policy   varchar(16) NOT NULL DEFAULT 'everyone', -- M15a: 'everyone' | 'owners' (アナウンス)
  times_owner_id   uuid REFERENCES users(id),  -- M24: この人の times (1 人 1 つ、DM には付けない)
  CHECK ((type IN ('public', 'private')) = (name IS NOT NULL)),
  CHECK ((type IN ('dm', 'group_dm')) = (dm_key IS NOT NULL)),
  CHECK (posting_policy IN ('everyone', 'owners'))
);
CREATE UNIQUE INDEX channels_name_uniq   ON channels (name)   WHERE name IS NOT NULL;
CREATE UNIQUE INDEX channels_dm_key_uniq ON channels (dm_key) WHERE dm_key IS NOT NULL;
CREATE UNIQUE INDEX channels_times_owner_uniq ON channels (times_owner_id) WHERE times_owner_id IS NOT NULL;
```

**times (M24)**: 一人ひとりの作業ログ用のチャンネル (Slack の times 文化)。研究室以外でも使える汎用機能。

- `POST /times` で自分の times を作る (冪等: あればそれを返す 200、作れば 201)。公開チャンネル `times-{username}`
  (名前が使われていれば `-2`, `-3` …)。ユーザー名を変えると、その形のままの名前は新しい名前に付いていく (M96、users
  「ユーザー名の変更」)。作った本人が owner。名簿 (M23) の指導教員は自動でメンバーになる。
  後から指導教員が付いたときも、その学生の times に加える。
- admin は既存のチャンネル (Mattermost から取り込んだ times など) を誰かの times に指定・解除できる
  (`PATCH /channels/{id}` の `times_owner_id`。DM は不可、1 人 1 つで重なれば 409 `times_exists`、guest は不可)。
- 誰でも書き込める。owner は「他の人はスレッドだけ」(`posting_policy = owners`、M15a と同じ) に切り替えられる。
- **静かな未読** (SYNC_PROTOCOL.md §10.5): 他人の times は、その人が通知レベルを `all` にしていない限り、
  未読があっても太字にせず「未読あり」にも数えない (メンションのときだけ未読・バッジ・プッシュ)。自分の times と、
  `all` にした他人の times は普通のチャンネルと同じ。

**最後のメッセージ (M49、MOBILE_UI.md §7.1)**: 列は足さない。会員への応答の `ChannelOut.last_message`
(`{id, sender_id, type, seq, excerpt, has_attachments, created_at}`) は、その都度 messages から求める:
会話ごとに `uq_messages_channel_seq` を逆順にたどり、削除済みでなくタイムラインに出る行 (トップレベルか
`also_in_channel`) の最初の 1 件 (LATERAL、1 クエリ)。編集は seq を変えないので、編集された最後の行は最後のまま。
数十会話で 1 ms 前後 (chikuwa_perf、103 会話・47 万件、温まった状態)。重くなったら `channels.last_message_id` を
`last_message_at` と同じトランザクションで持つ (削除時の付け替えが要る)。

### DM と通常チャンネルの違い

| | public | private | dm | group_dm |
| --- | --- | --- | --- | --- |
| 名前 | あり (一意) | あり (一意) | なし (相手の名前を表示) | なし (メンバー名を列挙) |
| 作成 | 誰でも | 誰でも | `POST /dms {user_ids:[u]}`。`dm_key` で既存を返す (冪等) | `POST /dms {user_ids:[...]}` 3..9 人 |
| メンバー変更 | join / leave / 招待 / 除外 | 招待 / 除外 / leave | 不可 (固定 2 人。自分宛ては 1 人) | 不可 (別の組み合わせは別チャンネル) |
| 一覧 | ブラウズ可 | メンバーのみ | メンバーのみ | メンバーのみ |
| アーカイブ | 可 | 可 | 不可 | 不可 |
| 投稿制限 (M15a) | 可 | 可 | 不可 | 不可 |
| 種類の変換 (M15b) | → private (owner / admin) | → public (admin) | 不可 | 不可 |
| 通知の既定 | mentions | mentions | all | all |
| times (M24) | 可 | 可 | 不可 | 不可 |
| メッセージ / 既読 / 同期 / 検索 | すべて共通 | | | |

`dm_key` は `sha256(",".join(sorted(user_ids)))` の hex。作成は `INSERT ... ON CONFLICT (dm_key) DO NOTHING`
の後に `SELECT` で解決し、同時作成でも 1 つに収束させる。

### channel_members (メンバーシップ)

```sql
CREATE TABLE channel_members (
  channel_id  uuid NOT NULL REFERENCES channels(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL DEFAULT 'member',   -- 'owner' | 'member'
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX channel_members_user_idx ON channel_members (user_id);
```

メンバーシップはチャンネルから独立した行で表す。すべての閲覧・投稿・添付・検索の権限判定はこの表で行う。
ロールは後から追加できるよう text にしておく (複雑な RBAC は作らない)。

### read_states (既読位置)

```sql
CREATE TABLE read_states (
  user_id        uuid NOT NULL REFERENCES users(id),
  channel_id     uuid NOT NULL REFERENCES channels(id),
  last_read_seq  bigint NOT NULL DEFAULT 0,        -- 「seq <= この値は既読」
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_id)
);
```

- メッセージごとの既読行は作らない。ユーザー × チャンネルで 1 行。
- 参加時に `last_read_seq = channels.last_seq` で作る (参加前のメッセージは未読にしない)。退出しても残す。
  再参加 (join / メンバー追加) でも残った行を同じ値まで進める (`ON CONFLICT DO UPDATE` で `GREATEST`)。
  以前は残った行がそのまま使われ、離れていた間の投稿が全部未読になっていた (M28a)。
- 更新は常に `GREATEST(last_read_seq, $new)` で、後退しない。複数端末は `read.updated` イベントで揃える
  (SYNC_PROTOCOL.md §10)。行がまだ無いときの最初の書き込みは `INSERT ... ON CONFLICT DO UPDATE` (thread_follows の
  既読位置も同じ): 2 端末が同時に最初の 1 行を作っても主キーで衝突しない (M28a)。
- 一覧・要約・プッシュのバッジは、チャンネルごとではなく利用者のチャンネル全部を 1 つのクエリ
  (`VALUES` の位置表と messages の結合を channel_id で集計) で数える (`reads.counts_for_user`、M28a)。
- 未読数はカウンタを持たず、seq の範囲から導出する (数十チャンネル × 数十人なら十分速い)。
  `channels.last_seq - last_read_seq` の引き算ではなく COUNT を使うのは、編集・リアクション・スレッド返信も
  seq を消費するため引き算では過大になるから。

```sql
SELECT count(*)                                                              AS unread_count,
       count(*) FILTER (WHERE $me = ANY (mentioned_user_ids) OR $me = ANY (keyword_user_ids) OR mention_all)  AS mention_count
FROM messages m
WHERE m.channel_id = $channel AND m.seq > $last_read_seq
  AND m.sender_id <> $me
  AND (m.parent_id IS NULL OR m.also_in_channel) AND m.deleted_at IS NULL AND m.type = 'user';
```

スレッドの返信は数えない。ただし「チャンネルにも送信」した返信 (`also_in_channel`、M15c) はチャンネルの
タイムラインに並ぶので数える。
自分の投稿は数えない (スレッドの返信を送ってもチャンネルの既読位置は進まないため、位置より後に自分の投稿が残りうる)。

自分の送信は同一トランザクションで `last_read_seq` を進めるので、自分のメッセージは未読にならない。

### thread_follows (フォロー中スレッドと、その既読位置)

```sql
CREATE TABLE thread_follows (
  parent_id      uuid NOT NULL REFERENCES messages(id),   -- parent_id IS NULL の行
  user_id        uuid NOT NULL REFERENCES users(id),
  following      boolean NOT NULL DEFAULT true,           -- false = フォローしていない (読んだだけ、または手動で外した)
  unfollowed_at  timestamptz,                             -- 手動で外した時刻。これがある行は自動フォローで戻さない
  last_read_seq  bigint NOT NULL DEFAULT 0,               -- このスレッドで読んだ最後の返信の seq
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_id, user_id)
);
CREATE INDEX thread_follows_user_idx ON thread_follows (user_id, following);
```

- 親メッセージ × ユーザーで 1 行。返信の作成時に親の投稿者・返信者・スレッド内でメンションされた人のうち
  **チャンネルのメンバー**を自動でフォローする (`ON CONFLICT DO UPDATE … WHERE unfollowed_at IS NULL`: 読んだだけの行は
  フォローに変わり、手動で外した行は戻さない)。スレッドを既読にしただけではフォローしない (`following=false` の行を作る)。
- フォロワー・一覧・件数は、そのチャンネルのメンバーである行だけを数える (メンションされた部外者や、抜けた人には
  スレッドの本文や状態を見せない)。
- 返信もチャンネルの `seq` を消費するので、スレッド内の位置も `seq` で表せる。未読数は `read_states` と同じく
  導出する (THREADS.md §2 のクエリ)。チャンネルの未読 (`read_states`) とは独立で、返信はそちらに数えない。
- `message.created` の `parent_thread.participant_ids` と `thread.updated` の宛先はこの表の `following=true`。

### bookmarks (保存したメッセージ、M11c)

```sql
CREATE TABLE bookmarks (
  user_id     uuid NOT NULL REFERENCES users(id),
  message_id  uuid NOT NULL REFERENCES messages(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX bookmarks_user_idx ON bookmarks (user_id, created_at);
```

- 個人データなのでチャンネルの `seq` を消費しない。端末間は `bookmark.updated` (audience=user) で揃え、
  bootstrap には id の一覧 (`bookmarks`) だけを入れる。一覧は `GET /bookmarks` (保存した順、カーソル)。
- ピン留め (`messages.pinned_at`) はチャンネル全員に見えるので `seq` を消費し、`message.updated (change=pin)`
  で配る。両方ともメッセージの削除で消える (一覧から外れる)。

### scheduled_messages (予約送信、M12d)

```sql
CREATE TABLE scheduled_messages (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id),
  channel_id       uuid NOT NULL REFERENCES channels(id),
  parent_id        uuid REFERENCES messages(id),        -- スレッドへの返信なら親
  client_msg_id    uuid NOT NULL UNIQUE,                 -- 投稿時の冪等キーになる
  body             text NOT NULL,
  attachment_ids   uuid[],
  send_at          timestamptz NOT NULL,
  status           varchar(16) NOT NULL DEFAULT 'pending', -- pending | sent | failed | cancelled
  error            text,                                 -- failed の理由 (エラーコード)
  sent_message_id  uuid REFERENCES messages(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_messages_due_idx  ON scheduled_messages (status, send_at);
CREATE INDEX scheduled_messages_user_idx ON scheduled_messages (user_id, send_at);
```

- ワーカー (`scheduled_send_interval_seconds`、既定 15 秒) が `status = pending AND send_at <= now()` を
  `FOR UPDATE SKIP LOCKED` で取り、通常のメッセージ作成 (`client_msg_id` が冪等キー) で投稿してから `sent` にする。
  投稿と `sent` の間で落ちても、次回は同じ `client_msg_id` で既存メッセージが返るので二重投稿にならない。
- 投稿できない (退出済み、アーカイブ、添付が無効) ときは `failed` + `error`。本人の各端末には `scheduled.updated`
  (audience=user) で pending / sent / failed / cancelled の変化が届く。一覧は `GET /scheduled` (pending のみ)。
- 本文は投稿と同じ検証 (制御文字を除いて空なら `422`)。ワーカーは行ごとにあらゆる例外を捕まえ、送れない行を
  `failed` (`error` は `invalid_body` / `send_failed` など) にして次の行へ進む。以前は予約時にだけ通る本文
  (制御文字だけ) が送信時に例外になり、時刻順に取るワーカーがその行で毎回止まって以降の全員の予約が送られなかった (M28a)。
  同じ `client_msg_id` の同時再送は一意制約で片方が負け、先に入った行を返す。
- 1 人あたり pending + failed は 100 件まで (`409 too_many_scheduled`)。
- 添付は予約時に `attachments.status = 'scheduled'` に予約し、未送信アップロードの GC から外す。取消 / 失敗で
  `deleted` に戻し、GC が実体を消す。

### custom_emoji (カスタム絵文字、M12f)

```sql
CREATE TABLE custom_emoji (
  id            uuid PRIMARY KEY,
  name          varchar(32) NOT NULL UNIQUE,   -- a-z 0-9 _ + - の 2〜32 文字、本文では :name:
  created_by    uuid NOT NULL REFERENCES users(id),
  kind          varchar(8) NOT NULL DEFAULT 'image' CHECK (kind IN ('image', 'text')),  -- M100
  content_type  text NOT NULL,                 -- png / gif / jpeg / webp、512px 以下、256 KB 以下 (text は '')
  size_bytes    integer NOT NULL,
  width         integer NOT NULL,              -- 縦横比はここから (M100、横長は 3:1 まで広く描く。text は 0)
  height        integer NOT NULL,
  storage_key   text NOT NULL,                 -- versitygw の emoji/<id> (text は '')
  label         varchar(32),                   -- M100: 表示名 (ピッカーの名前)、text ではピルの文字 (12 文字まで)
  color         varchar(16),                   -- M100: text の色 (パレットのキー、NULL = gray)
  keywords      text[] NOT NULL DEFAULT '{}',  -- M100: 検索語 (日本語も)、20 個・32 文字まで
  pack_id       uuid REFERENCES emoji_packs(id) ON DELETE SET NULL,  -- M100: セット (NULL = なし)
  position      integer NOT NULL DEFAULT 0,    -- M100: セットの中の順
  preset_key    varchar(255),                  -- M102: 取り込んだプリセットのフォルダ名 (NULL = 手で追加)
  preset_hash   varchar(64),                   -- M102: 最後に取り込んだ画像ファイルの SHA-256
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- M100: ピッカーのタブ 1 つになる絵文字のセット (docs/EMOJI.md §3)
CREATE TABLE emoji_packs (
  id                uuid PRIMARY KEY,
  name              varchar(64) NOT NULL UNIQUE,
  position          integer NOT NULL DEFAULT 0,      -- タブの順
  tab_content_type  text,                            -- タブのアイコン (なければ最初の絵文字)
  tab_storage_key   text,                            -- emoji-packs/<id>/tab-<uuid> (差し替えで変わる)
  preset_key        varchar(255) UNIQUE,             -- M102: プリセットのフォルダ名 (NULL = 手で作った)
  preset_tab_hash   varchar(64),                     -- M102: 最後に取り込んだタブのアイコンの SHA-256
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- M102: 管理者が消したプリセット (docs/EMOJI.md §8)。次の起動で戻さない
CREATE TABLE emoji_preset_removals (
  preset_key  varchar(255) NOT NULL,
  shortcode   varchar(32) NOT NULL DEFAULT '',   -- '' = セットごと、ほかは消した絵文字 1 つ
  removed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  removed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (preset_key, shortcode)
);
```

- 画像は添付と同じオブジェクトストアに置き、`GET /emoji/{id}/image` (要ログイン、1 日キャッシュ) で配る。
- 誰でも追加でき、作成者か admin が削除できる。削除しても本文の `:name:` は文字のまま残る (クライアントは
  未知の名前を文字で表示する)。一覧は bootstrap の `custom_emoji` と `emoji.updated` (audience=all) で揃える。
- リアクションの `emoji` 列は `:name:` 形式も受け付ける (DATA_MODEL.md `message_reactions` の注記どおり)。
- M100 (docs/EMOJI.md、移行 0079): 文字の絵文字 (`kind = 'text'`、`POST /emoji/text`)、表示名・キーワード・セット
  (`PATCH /emoji/{id}`)、`emoji_packs` (管理者が作成・変更・削除・取り込み、監査ログ)。セットを消しても絵文字は
  残る (`pack_id` が NULL になる)。一覧は bootstrap の `emoji_packs` と `emoji_pack.updated` (audience=all)。
- M102 (docs/EMOJI.md §8、移行 0080): サーバのフォルダ (`EMOJI_PRESETS_DIR`) のセットを起動時に取り込む。
  `preset_key` / `preset_hash` / `preset_tab_hash` は API には出さない。管理者がプリセットのセットや絵文字を消すと
  `emoji_preset_removals` に残り、次の起動で戻らない (戻すのは CLI の `--restore`)。

### reminders (リマインダー、M12e)

```sql
CREATE TABLE reminders (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  message_id  uuid NOT NULL REFERENCES messages(id),
  channel_id  uuid NOT NULL REFERENCES channels(id),
  note        varchar(200),
  preview     text,                                   -- 使わない (空)。表示・通知の文面は元のメッセージから毎回作る
  remind_at   timestamptz NOT NULL,
  status      varchar(16) NOT NULL DEFAULT 'pending', -- pending | fired | done | cancelled
  fired_at    timestamptz,
  kind        varchar(16) NOT NULL DEFAULT 'personal', -- personal (本人が設定) | ack (確認のお願い、L4) | collect (提出のお願い、L6)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reminders_due_idx  ON reminders (status, remind_at);
CREATE INDEX reminders_user_idx ON reminders (user_id, status, remind_at);
CREATE INDEX reminders_message_kind_idx ON reminders (message_id, kind, created_at);
```

- 個人データ。時刻になるとワーカー (予約送信と同じループ) が `fired` にして `reminder.updated` (audience=user)
  を書き、PushPlanner がその行から本人の端末へ `kind = reminder` のプッシュを作る (DND 中は出さない)。
- 一覧 `GET /reminders` は fired (新しい順) → pending (時刻順)。`DELETE /reminders/{id}` は pending なら
  `cancelled`、fired なら `done`。fired の件数はアプリのバッジに足す。
- 1 人あたり pending + fired は 200 件まで (`409 too_many_reminders`、M28a)。一覧はこの上限で抑えられるので
  ページングは持たない (done / cancelled は一覧にも上限にも数えない)。
- **確認のお願い (`kind = ack`、L4、LAB.md H)**: 確認を求めた投稿 (M15e) の投稿者か admin が
  `POST /messages/{id}/ack/remind` すると、未確認の人それぞれに本人だけのリマインダーを `fired` で作る
  (`reminders.create_system_in_tx`。一覧・プッシュ・バッジは本人が設定したものと同じ経路。プッシュの題は「確認のお願い」、
  note は「(投稿者名) さんから確認のお願い」)。同じ投稿へのお願いは 1 時間に 1 回まで (`429 ack_remind_too_soon`、
  `details.retry_after_seconds`)。前のお願いが開いたままの人には重ねない。応答は `{ reminded: 人数 }`。確認した後の
  お願いは `GET /reminders` に出さない (端末は `done` にしてよい)。
- **未確認の人**: `GET /messages/{id}/ack/pending` → `{ user_ids }` (表示名順)。チャンネルのメンバーから、投稿者・bot・
  無効化された人・確認済みの人を除いたもの。メンバーなら誰でも見られる (確認した人の一覧が見えるのと同じ)。
  確認を求めていない投稿は `409 ack_not_requested`。

- **提出のお願い (`kind = collect`、L6、M59)**: 回収のある定期投稿 (recurring_posts) の締切を過ぎると、worker が未提出の対象者
  それぞれに `fired` で作る (`create_system_in_tx`。プッシュの題は「提出のお願い」、note は「(定期投稿の名前) の提出をお願いします
  (締切 10/9 (金) 18:00)」)。そのスレッドに返信した後は `GET /reminders` に出さない。

### recurring_posts / collections (定期投稿と提出の回収、M59、RECURRING.md)

```sql
CREATE TABLE recurring_posts (
  id           uuid PRIMARY KEY,                       -- UUIDv7
  channel_id   uuid NOT NULL REFERENCES channels(id),  -- 公開・非公開チャンネル (DM は不可)
  created_by   uuid NOT NULL REFERENCES users(id),
  bot_user_id  uuid NOT NULL REFERENCES users(id),     -- role = bot。この定期投稿専用 (表示名 = name)。チャンネルのメンバー
  name         varchar(40) NOT NULL,                   -- 1〜40 文字 (空白は 1 つにまとめる)
  body         text NOT NULL,                          -- 1〜4000 文字。{date} {weekday} {week} を投稿日で置き換える
  schedule     jsonb NOT NULL,                         -- {"kind":"weekly","weekdays":[0,3],"time":"09:00"} | {"kind":"monthly","day":31,"time":"09:00"}
  tz           varchar(64) NOT NULL,                   -- schedule と締切を読むゾーン (作った端末の)
  collect      jsonb,                                  -- NULL | {"targets":{"group_ids":[],"user_ids":[],"all_members":false},"due":{"after_days":3,"time":"18:00"}}
  enabled      boolean NOT NULL DEFAULT true,          -- false = 停止中 (アーカイブで自動的にも)
  next_run_at  timestamptz NOT NULL,                   -- schedule と tz から計算 (作成・予定の変更・再開のとき今から)
  last_run_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,                            -- 論理削除 (ボットは抜けて無効化。投稿と回収は残る)
  CHECK (char_length(name) BETWEEN 1 AND 40),
  CHECK (char_length(body) BETWEEN 1 AND 4000)
);
CREATE INDEX recurring_posts_due_idx     ON recurring_posts (next_run_at) WHERE enabled AND deleted_at IS NULL;
CREATE INDEX recurring_posts_channel_idx ON recurring_posts (channel_id) WHERE deleted_at IS NULL;

CREATE TABLE collections (
  message_id         uuid PRIMARY KEY REFERENCES messages(id),   -- 定期投稿が立てたメッセージ (スレッドの親)
  recurring_post_id  uuid NOT NULL REFERENCES recurring_posts(id),
  channel_id         uuid NOT NULL REFERENCES channels(id),
  target_user_ids    uuid[] NOT NULL DEFAULT '{}',               -- 投稿の時点で固定した対象者 (表示名順)
  due_at             timestamptz NOT NULL,                       -- 投稿日 + after_days の time (tz)
  reminded_at        timestamptz,                                -- 催促を作った時 (1 回だけ)
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collections_due_idx ON collections (due_at) WHERE reminded_at IS NULL;
```

- **予定**: 毎週 (曜日は複数可、0 = 月曜) か毎月 (1〜31 日。その日のない月は末日)、時刻は tz の壁時計。次の予定は「今より厳密に後の
  最初の該当時刻」。夏時間で飛ばされる時刻 (02:30) は切り替え後の同じ間隔 (03:30)、2 回ある時刻は 1 回目。
- **投稿** (worker、リマインダーと同じ周期): `next_run_at <= now` の有効な行ごとに 1 件。止まっていた間の分はまとめて 1 件にし、
  `next_run_at` を今より後の予定へ進める (投稿と同じトランザクション)。`client_msg_id` は行と予定時刻から作る (UUIDv5)。
  ボットがチャンネルから外されていたら入り直す。チャンネルがアーカイブ (か消滅) なら投稿せず `enabled = false`。投稿に失敗した行は
  ログに残し、次の予定へ進める (同じ行が数秒ごとに失敗し続けないように)。今すぐ投稿 (`POST /recurring-posts/{id}/run`) は
  停止中でも投稿し、`next_run_at` を変えない。投稿者の既読位置は動かさない。
- **回収**: `collect` のある投稿は `collections` の行を作る。対象 = (グループのメンバー ∪ 指定した人、または `all_members` なら全員)
  ∩ 投稿の時点のチャンネルのメンバー (bot・無効化された人を除く)。締切 = 投稿日 (tz) + after_days の time。それが投稿の時刻以前
  (今すぐ投稿や遅れた投稿で、当日の締切が過ぎている) なら 1 日ずつ後ろへ。投稿の `message.created` には載らないので、同じ
  トランザクションで親が別の seq を取って `message.updated (change = collection)` を出す。
- **提出**: 対象者のうち、そのスレッドに消されていない返信 (チャンネルにも送信した返信を含む) がある人。表には持たず読むときに数える
  (`MessageOut.collection` は履歴・差分などのページごとに 2 クエリ)。対象者の最初の返信・最後の返信の削除で提出状況が変わると、親が
  別の seq を取って `message.updated (change = collection)` (返信の `message.created` / `message.deleted` の後)。
- **催促**: `due_at <= now` で `reminded_at` が空の行に、未提出でまだメンバーの対象者それぞれの `reminders (kind = collect)` を作り、
  `reminded_at` を入れて親の `message.updated (change = collection)`。投稿が消されている、チャンネルがアーカイブされている場合は
  作らずに `reminded_at` だけ入れる。定期投稿を消しても、それまでの投稿の回収と催促は続く。
- チャンネルの seq は投稿 (と上の親の更新) でだけ使う。定期投稿の一覧の変更はイベントを出さない (開くたびに読む)。

### channel_feeds (チャンネルのフィード、RSS / Atom、M97、FEEDS.md)

```sql
CREATE TABLE channel_feeds (
  id                    uuid PRIMARY KEY,                       -- UUIDv7
  channel_id            uuid NOT NULL REFERENCES channels(id),  -- 公開・非公開チャンネル (DM は不可)
  owner_id              uuid NOT NULL REFERENCES users(id),     -- 追加したメンバー (投稿の本文に名前が出る)
  bot_user_id           uuid NOT NULL REFERENCES users(id),     -- role = bot。チャンネルに 1 つ「RSS」、そのチャンネルのフィードが共有
  url                   varchar(2048) NOT NULL,
  title                 varchar(200),                           -- フィードの題名 (取るたびに更新)
  site_url              varchar(2048),
  enabled               boolean NOT NULL DEFAULT true,
  needs_baseline        boolean NOT NULL DEFAULT false,         -- 次の取得は記録だけ (再開・アーカイブや登録者不在の後)
  etag                  varchar(512),                           -- 条件付き GET
  last_modified         varchar(128),
  seen_keys             varchar(32)[] NOT NULL DEFAULT '{}',    -- 見た記事の印 (guid / id / link の SHA-256 の先頭 32 桁)、最大 500
  next_fetch_at         timestamptz NOT NULL,
  last_fetched_at       timestamptz,
  last_success_at       timestamptz,
  last_error_code       varchar(32),                            -- not_a_feed / unsafe_xml / http_error / timeout / …
  last_error            varchar(300),
  consecutive_failures  integer NOT NULL DEFAULT 0,
  failure_notified_at   timestamptz,                            -- 続けて失敗した DM を送った時 (成功で NULL に戻る)
  post_count            integer NOT NULL DEFAULT 0,
  last_post_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_feeds_channel_url_uniq UNIQUE (channel_id, url)
);
CREATE INDEX channel_feeds_due_idx   ON channel_feeds (next_fetch_at) WHERE enabled;
CREATE INDEX channel_feeds_owner_idx ON channel_feeds (owner_id);
```

- 見た記事は別の表にせず配列 1 つに持つ (今のフィードに載っている印を先頭に、古いものから捨てて 500 個まで)。1 回の取得で
  1 行を書き換えるだけで、載っている記事は必ず覚えている。
- 削除は行ごと (投稿は残る)。チャンネルの最後のフィードを消すとボットは抜けて無効化 (M98: 管理者が既存のボットを選んだもの
  (`adopted`) はそのまま)。ボットの投稿は誰の既読位置も動かさない。
- 一覧の変更はイベントを出さない (開くたびに読む)。取得と投稿の規則は FEEDS.md §4。

### channel_feed_bots (チャンネルのフィードのボット、M98、FEEDS.md §1)

```sql
CREATE TABLE channel_feed_bots (
  channel_id   uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  bot_user_id  uuid NOT NULL UNIQUE REFERENCES users(id),   -- role = bot、bot_kind = 'feed'
  adopted      boolean NOT NULL DEFAULT false,              -- 管理者が既存のボット (Slack から移行した RSS のボットなど) を選んだ
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

- チャンネルのフィードが投稿するボット。最後のフィードを消しても行は残り、次のフィードで同じボット (付けた名前のまま) が
  有効に戻ってチャンネルに入る。`channel_feeds.bot_user_id` はこのボットと同じ (選び直すと全部書き換える)。
- 移行 0077 で今あるフィードのボットから作り、それらの `users.bot_kind` を `'feed'` にした (`updated_at` も進める)。

### reservation_pools / reservation_bots / reservations (共有枠の予約、M99、RESERVATIONS.md)

```sql
CREATE TABLE reservation_pools (
  id             uuid PRIMARY KEY,
  channel_id     uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name           varchar(80) NOT NULL,                 -- 例「Claude Premium シート」
  capacity       integer NOT NULL CHECK (capacity >= 1),  -- 枠の数 (1〜100)
  min_hours      integer NOT NULL,                     -- 割り当てからの最低保証 (0〜720 時間、既定 6)
  grace_minutes  integer NOT NULL,                     -- 保証を過ぎた人への猶予 (0〜1440 分、既定 15)
  tz             varchar(64) NOT NULL,                 -- ボットの投稿と DM の時刻の書き方 (作った端末のゾーン)
  operator_ids   uuid[] NOT NULL DEFAULT '{}',         -- 担当者 (チャンネルのメンバー、20 人まで)
  enabled        boolean NOT NULL DEFAULT true,        -- false: 新しい予約を受け付けない (今の人はそのまま)
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservation_pools_channel_idx ON reservation_pools (channel_id);

CREATE TABLE reservation_bots (
  channel_id   uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  bot_user_id  uuid NOT NULL UNIQUE REFERENCES users(id),   -- role = bot、bot_kind = 'reservation'、名前「予約」
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reservations (
  id                 uuid PRIMARY KEY,
  pool_id            uuid NOT NULL REFERENCES reservation_pools(id) ON DELETE CASCADE,
  channel_id         uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id),
  status             varchar(16) NOT NULL,   -- waiting / holding / returning / done / cancelled
  requested_at       timestamptz NOT NULL,   -- 順番はこの順 (同じなら id)
  assigned_at        timestamptz,            -- 「割り当てた」
  assigned_by        uuid REFERENCES users(id),
  guarantee_until    timestamptz,            -- assigned_at + その時の min_hours (固定)
  returned_at        timestamptz,            -- 「返却する」
  evict_notice_at    timestamptz,            -- 保証を過ぎ、待つ人のために「外す」と知らせた時刻
  evict_at           timestamptz,            -- その猶予の終わり
  ready_notified_at  timestamptz,            -- 担当者に「割り当てて / 入れ替えて / 外して」と知らせた (1 回)
  ended_at           timestamptz,
  ended_by           uuid REFERENCES users(id),
  end_reason         varchar(16),            -- cancelled / returned / removed
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('waiting', 'holding', 'returning', 'done', 'cancelled'))
);
CREATE UNIQUE INDEX reservations_active_uniq ON reservations (pool_id, user_id)
  WHERE status IN ('waiting', 'holding', 'returning');          -- 1 人 1 枠
CREATE INDEX reservations_pool_active_idx ON reservations (pool_id, status)
  WHERE status IN ('waiting', 'holding', 'returning');
CREATE INDEX reservations_user_idx ON reservations (user_id);
```

- 枠は 1 チャンネルに 5 個まで。ボットはチャンネルに 1 つで、最初の枠と一緒に作り、枠を消しても残る。
- 終わった行 (done / cancelled) は履歴として残す。枠を消すと行も消える (ボットの投稿は残る)。
- 変更はすべて枠の行を `FOR UPDATE` でロックしてから行う (担当者の同時の操作、worker)。順番の決め方は RESERVATIONS.md §4。
- 変更は `reservation.updated` (channel) で知らせ、端末は読み直す (カードは人ごとに違う)。

### channel_favorites (お気に入りチャンネル、M12a)

```sql
CREATE TABLE channel_favorites (
  user_id     uuid NOT NULL REFERENCES users(id),
  channel_id  uuid NOT NULL REFERENCES channels(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_id)
);
CREATE INDEX channel_favorites_user_idx ON channel_favorites (user_id, created_at);
```

- サイドバーの「お気に入り」節。個人データなので `seq` を消費せず、端末間は `favorite.updated` (audience=user)
  で揃え、bootstrap には id の一覧 (`favorites`) を入れる。星を付けられるのはメンバーだけ。
- 退出しても行は残すが、bootstrap は現在のメンバーシップと結合して返すので表示からは消える (再参加で戻る)。

### user_blocks (ブロック、M104、MODERATION.md §4)

```sql
CREATE TABLE user_blocks (
  blocker_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX user_blocks_blocked_idx ON user_blocks (blocked_id);  -- 「この送信者をブロックしたのは誰か」(プッシュ、DM の拒否)
```

- 本人だけのもの。`seq` を消費せず、端末間は `block.updated` (audience=user、ブロックした本人だけ) で揃え、bootstrap に
  `blocked_user_ids` を入れる。ブロックされた人には何も配らない。
- 読むのは `moderation/blocks.py` だけ (messages・channels の 1 対 1 の DM の拒否、notifications のプッシュの除外、
  activity の一覧の除外)。本人のアカウントを削除 (匿名化) すると、本人がブロックした行は消える (された側の行は残す)。

### message_reports (メッセージの報告、M104、MODERATION.md §3)

```sql
CREATE TABLE message_reports (
  id                uuid PRIMARY KEY,                        -- UUIDv7
  message_id        uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel_id        uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  reporter_id       uuid NOT NULL REFERENCES users(id),
  reported_user_id  uuid NOT NULL REFERENCES users(id),      -- 報告した時のメッセージの送信者
  reason            varchar(16) NOT NULL CHECK (reason IN ('spam', 'harassment', 'inappropriate', 'other')),
  note              text,                                    -- 補足 (1,000 文字まで)
  body_snapshot     text NOT NULL DEFAULT '',                -- 報告した時の本文 (4,000 文字まで)
  status            varchar(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  resolved_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT message_reports_once UNIQUE (message_id, reporter_id)
);
CREATE INDEX message_reports_status_idx ON message_reports (status, created_at);
```

- 同じ人が同じメッセージを報告できるのは 1 回 (2 回目は最初の行を返す)。読むのは管理者だけ (`GET /admin/reports`)。
- 本文の写しは、投稿者が後で編集・削除しても何が報告されたかを確かめるため (メッセージ本体はソフト削除なので行は残る)。
  イベントは無い (管理者にはモデレーションのボットの DM で知らせる)。

### invites (招待リンク、M12h)

```sql
CREATE TABLE invites (
  id           uuid PRIMARY KEY,
  token_hash   bytea NOT NULL UNIQUE,          -- SHA-256(token)。トークン自体は発行応答に 1 回だけ載せる
  created_by   uuid NOT NULL REFERENCES users(id),
  role         varchar(16) NOT NULL DEFAULT 'member',  -- 参加した人のシステムロール
  channel_ids  uuid[] NOT NULL,                -- 参加時に加わるチャンネル (public か、発行者が入っている private)
  note         varchar(80),                    -- 誰向けか (管理画面の表示用)
  max_uses     integer,                        -- NULL = 期限内なら何度でも
  use_count    integer NOT NULL DEFAULT 0,
  used_by      uuid[] NOT NULL,                -- このリンクで作られたアカウント
  expires_at   timestamptz NOT NULL,           -- 発行から 1 時間〜30 日
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invites_created_idx ON invites (created_at);
```

- 状態は行から導く: `revoked_at` あり → revoked、`expires_at` 経過 → expired、`use_count >= max_uses` → exhausted、
  それ以外が active。active でないトークンは公開エンドポイントで `410 invite_<状態>`、未知のトークンは 404。
- 受諾は 1 トランザクション: 行を `FOR UPDATE` で取り、`users` を挿入 (`must_change_password = false`、
  監査行に `invite_id`)、`channel_ids` のうち残っている (アーカイブされていない) チャンネルに参加、
  `use_count` / `used_by` を更新。その後は通常の login と同じ経路でセッションを作る。
- イベントは出さない (管理画面は都度取得)。新しいアカウントは既存の `user.created` で全端末に届く。
- **研究室のプリセット (`lab_preset jsonb`、L7 / M32)**: `{affiliation, rank, grade, supervisor_id, times}` (名簿の行と同じ
  規則。times はゲストには付けられない `400 guest_restricted`、指導教員は名簿の教員 `422 invalid_supervisor`)。受諾の
  トランザクションで、times を作り (指導教員が参加)、名簿の行を入れ、管理グループを揃える。受諾までに指導教員が教員で
  なくなっていたら、指導教員なしで入れる (受諾は失敗させない)。`GET /invites/{token}` の `lab` (身分・職位・学年・
  指導教員の名前・times) を受諾画面に出す。例: 「2027 年度 B4」、10 回まで、7 日。

### user_totp (2 要素認証、M12i)

```sql
CREATE TABLE user_totp (
  user_id          uuid PRIMARY KEY REFERENCES users(id),
  secret           bytea NOT NULL,          -- 20 バイトの乱数 (RFC 6238、SHA-1 / 6 桁 / 30 秒)
  enabled_at       timestamptz,             -- NULL の間は設定途中 (コードで確認するまでログインには効かない)
  recovery_hashes  bytea[] NOT NULL,        -- 未使用の回復コードの SHA-256。使うと取り除く
  last_used_step   bigint,                  -- 受け付けた最後の 30 秒ステップ (同じコードは 2 度使えない)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
```

- 秘密は平文で置く (DB を読める人はパスワードハッシュも読める前提。SECURITY.md §2.7)。
- `users` には列を足さない。有効かどうかは `GET /auth/totp` と admin のユーザー一覧 (`totp_enabled`) で見る。
- 無効化 / admin のリセットは行を消す。

### user_identities / sso_requests / sso_tickets (Google でログイン、M48)

仕様は docs/SSO.md。

```sql
CREATE TABLE user_identities (          -- 外部のアカウント (Google の sub) → ユーザー
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       varchar(16) NOT NULL,  -- 'google'
  subject        varchar(255) NOT NULL, -- ID トークンの sub (メールアドレスが変わっても同じ)
  email          citext,                -- 結び付けたときのアドレス (記録用)
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);
CREATE UNIQUE INDEX user_identities_provider_subject_uniq ON user_identities (provider, subject);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

CREATE TABLE sso_requests (             -- 始めたサインイン (10 分、1 回だけ)
  state          text PRIMARY KEY,      -- Cookie chikuwa_sso と同じ値
  nonce          text NOT NULL,
  code_verifier  text NOT NULL,         -- Google との PKCE
  challenge      text NOT NULL,         -- アプリの base64url(SHA-256(verifier))。チケットに写す
  platform       varchar(16) NOT NULL,  -- web | desktop | ios | android (戻り先を決める)
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);

CREATE TABLE sso_tickets (              -- アプリがトークンに交換するチケット (2 分、1 回だけ)
  ticket_hash    bytea PRIMARY KEY,     -- SHA-256 だけ。チケットそのものは戻りの URL にしか無い
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge      text NOT NULL,
  platform       varchar(16) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);
```

- `sso_requests` と `sso_tickets` は、使った時点 (失敗でも) で `used_at` を入れて commit してから検査する。
  期限から 1 時間過ぎた行は 1 時間ごとの掃除が消す。
- 匿名化 (admin) は `user_identities` と未使用のチケットを消す (Google でその人として入れなくなる)。

### user_groups / user_group_members (ユーザーグループ、M12k)

```sql
CREATE TABLE user_groups (
  id           uuid PRIMARY KEY,
  name         citext NOT NULL UNIQUE,   -- [a-z0-9][a-z0-9._-]{1,31}。ユーザー名と同じ名前空間 (@name が一意になるよう互いに衝突を拒否)
  description  varchar(200),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_group_members (
  group_id  uuid NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id),
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX user_group_members_user_idx ON user_group_members (user_id);
```

- admin が作成・編集・削除する (`/admin/groups`)。全員が一覧を見る (bootstrap の `groups`、`group.updated` は
  audience=all)。本文の `<@group:{group_id}>` は投稿 / 編集時に (無効化されていない) メンバー全員 (送信者を除く) に
  展開して `messages.mentioned_user_ids` に足すので、未読のメンション数・`GET /mentions`・プッシュはそのまま効く。
  グループの id は本文に残るだけで messages には列を足さない。削除されたグループのトークンは誰にも展開されない。
- **管理グループ** (M23): `managed_key text UNIQUE` (null = 手で作るグループ) を持つグループは名簿 (`lab_profiles`) から
  メンバーを自動で保つ。admin が編集・削除・メンバー変更をしようとすると 409 `group_managed`。`GroupOut.managed` で
  クライアントは読み取り専用に表示する。作成者 (`created_by`) は最初に名簿を変えた admin。

### lab_profiles (名簿、M23)

研究室の名簿: 身分・学年・指導教員・研究テーマ。表示とグループ分けにだけ使い、**権限には使わない** (ロールは
admin / member / guest のまま)。学籍番号・成績・出欠は保存しない。研究室専用のものは `lab` モジュールに閉じ込め、
`users` には列を足さない。

```sql
CREATE TABLE lab_profiles (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  affiliation    text NOT NULL,        -- faculty | student | alumni | other (身分)
  rank           text,                 -- 教員だけ: professor | associate_professor | lecturer | assistant_professor
  grade          text,                 -- 学生だけ: B3 | B4 | M1 | M2 | D1 | D2 | D3
  supervisor_id  uuid REFERENCES users(id) ON DELETE SET NULL,   -- 指導教員 (教員の名簿にいる人)
  research_topic varchar(200),         -- 研究テーマ (本人も編集できる)
  reading        varchar(80),          -- よみ (名簿の並び順。本人も編集できる)
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (rank IS NULL OR affiliation = 'faculty'),
  CHECK (grade IS NULL OR affiliation = 'student')
);
```

- 名簿に載せる・身分・職位・学年・指導教員を変えるのは admin (`PUT /lab/roster/{user_id}`、`DELETE` で外す)。本人は
  自分の行の研究テーマとよみだけ変えられる (`PATCH /lab/roster/me`、名簿にいなければ 404 `roster_entry_not_found`)。
- 全員が一覧を持つ (bootstrap の `roster`、`GET /lab/roster`、変化は `roster.updated`)。guest には見える人の行だけ
  (bootstrap / GET)、`roster.updated` は届けない (group.updated と同じ)。
- **名簿順** (3 端末と `GET /lab/roster` で同じ): 教員 (教授 → 准教授 → 講師 → 助教 → 職位なし) → 学生 (D3 → D2 →
  D1 → M2 → M1 → B4 → B3 → 学年なし) → その他 → 卒業生。同じ段の中はよみ (無ければ表示名)、次にユーザー名。
  名簿にいない人はその後ろ。
- **管理グループ** (`user_groups.managed_key`): `faculty` (教員)、`students` (学生)、`alumni` (卒業生)、`b4`、`m1`、
  `m2` (その学年の学生)、`d` (D1〜D3)。名簿が変わるたびに同じトランザクションでメンバーを計算し直し、変わった
  グループだけ `group.updated` を出す。まだ無いグループはメンバーが 1 人以上になったときに作る。同じ名前の手作りの
  グループがあれば管理グループにする (メンバーは名簿で置き換わる。監査ログに残す)。同じ名前のユーザーがいれば
  作らない (`@name` が一意でなくなるため)。無効化されたユーザーは名簿に残るが、メンションの展開は従来どおり
  有効なユーザーだけ。
- 匿名化 (admin) は名簿の行も消す。

### lab_rollovers (年度更新、L7 / M32、LAB.md I)

```sql
CREATE TABLE lab_rollovers (
  academic_year smallint PRIMARY KEY,
  applied_by    uuid NOT NULL REFERENCES users(id),
  applied_at    timestamptz NOT NULL DEFAULT now(),
  before        jsonb NOT NULL,   -- 人ごとの適用前: 名簿の行、ロール、外したチャンネルとそのロール、加えたチャンネル、アーカイブした times
  undone_at     timestamptz       -- 取り消した時刻 (取り消した年度は適用し直せる)
);
```

- `POST /lab/rollover/preview {academic_year}` (admin): 名簿の学生全員について、今の学年、既定の案 (B3・B4・M1・D1・D2 は
  進級、M2・D3 は卒業)、進級後の学年、times、卒業したら外れるチャンネル (自分の times 以外の公開・非公開) を返す。
  その年度が適用中なら `applied_at`。
- `POST /lab/rollovers {academic_year, items: [{user_id, action: advance | stay | graduate, guest, keep_channel_ids}],
  stay_channel_ids, alumni_channel_id}` (admin)。`stay_channel_ids` (20 個まで) は卒業生全員が入って残るチャンネル
  (OB・OG 用、全体連絡など。`alumni_channel_id` は 1 つだけの古い書き方で、同じ扱い)。研究室の既定の運用は「ゲストにする」を
  オンにし、卒業生にはこれらのチャンネルと DM だけが見えるようにする (2026-09-29 の利用者の決定): 1 トランザクションで適用する。適用中の年度は `409 rollover_applied`、学生でない人は
  `422 rollover_not_student`、D3 の進級は `422 rollover_cannot_advance`。
  - advance は学年を 1 つ上げる、stay は何もしない (記録だけ)。
  - graduate: 名簿を alumni に (学年と職位を外す。指導教員は残す)、自分の times をアーカイブ (本人はオーナーのまま)、
    `keep_channel_ids` と `stay_channel_ids` 以外の公開・非公開チャンネルから外す (DM は残す)、`stay_channel_ids` に加える、
    `guest` ならロールを guest にする (その人の接続は張り直させ、見える範囲がすぐ狭まる)。自分自身はゲストにできない。
  - 名簿の変化は人ごとに `roster.updated`、管理グループは最後に 1 回揃える。監査ログ `lab.rollover_applied`。
- `GET /lab/rollovers`: 年度の新しい順 (進級・据え置き・卒業の人数、取り消し済みか)。
- `POST /lab/rollovers/{year}/undo`: `before` から名簿の行・ロール・外したチャンネル (元のロールで)・times のアーカイブを
  戻し、加えた卒業生のチャンネルから外す。取り消し済みは `409 rollover_undone`。監査ログ `lab.rollover_undone`。

### webhooks (受信 Webhook、M13a)

```sql
CREATE TABLE webhooks (
  id            uuid PRIMARY KEY,
  name          varchar(80) NOT NULL,           -- bot ユーザーの表示名にもなる
  channel_id    uuid NOT NULL REFERENCES channels(id),   -- 投稿先 (public / private。DM は不可)
  bot_user_id   uuid NOT NULL REFERENCES users(id),      -- role = bot。この Webhook 専用
  token_hash    bytea NOT NULL UNIQUE,          -- SHA-256(URL のトークン)。トークンは発行応答に 1 回だけ
  created_by    uuid NOT NULL REFERENCES users(id),
  enabled       boolean NOT NULL DEFAULT true,
  post_count    integer NOT NULL DEFAULT 0,
  last_post_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

- `POST /hooks/{token}` (認証なし、トークンごとに 60 回 / 分) が `{"text": "..."}` (JSON、または Slack 互換の
  `payload=` フォーム) を受け、bot ユーザーとして通常の投稿経路 (seq、outbox、メンション、プッシュ、検索) で
  メッセージを作る。任意の `id` (UUID) は `client_msg_id` になり、再送しても二重投稿にならない。
- bot は作成時に投稿先チャンネルのメンバーになり、投稿先を変えると移る。`users.role = 'bot'` はログインできず、
  管理画面のロール変更の対象にもならない。Webhook を削除すると bot は無効化され、投稿は bot 名義のまま残る。
- 無効化 (`enabled = false`) と未知のトークンはどちらも 404 (存在を漏らさない)。

### sidebar_sections / sidebar_section_channels (サイドバーのセクション、M14f)

```sql
CREATE TABLE sidebar_sections (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  name        varchar(40) NOT NULL,
  emoji       varchar(64),                   -- M26: アイコン。絵文字 1 つかカスタム絵文字 `:name:` (null = なし)。M114: 文字のバッジ `letter:M:blue`
  collapsed   boolean NOT NULL DEFAULT false, -- M26: 折りたたみ (自分の全端末で同じ)
  position    integer NOT NULL,              -- 0 から。並べ替えで詰め直す
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sidebar_sections_user_idx ON sidebar_sections (user_id, position);

CREATE TABLE sidebar_section_channels (
  user_id     uuid NOT NULL REFERENCES users(id),
  channel_id  uuid NOT NULL REFERENCES channels(id),
  section_id  uuid NOT NULL REFERENCES sidebar_sections(id) ON DELETE CASCADE,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_id)          -- 1 つの会話は自分のセクションのどれか 1 つにだけ入る
);
```

- 個人データ (channel seq なし)。1 人 20 セクションまで。参加中の会話 (チャンネルと DM) だけを入れられる。
- お気に入りはセクションより優先して表示する。抜けた会話の行は残すが、クライアントは参加中のものだけ出す。
- 変更はすべて `sidebar.updated` (audience=user) で自分の全端末へ、ペイロードはセクションの一覧全体。
- **M26 (Slack のようなセクション)**: 作るときに名前・アイコン・入れる会話をまとめて決められる
  (`POST /sidebar/sections {name, emoji, channel_ids}`、ほかのセクションにあった会話はこちらへ移る)。名前とアイコンは
  あとから変えられる (`PATCH` の `emoji: null` で外す)。折りたたんだセクションも、未読のある会話と開いている会話は
  出す (Slack と同じ)。組み込みの節 (お気に入り、チャンネル、Times、ダイレクトメッセージ) の折りたたみは端末ごと。
  Desktop は会話をセクションの見出しへドラッグして移せる (「チャンネル」「ダイレクトメッセージ」の見出しへ落とすと
  セクションから外す)。
- **M114 (文字のアイコン)**: 研究室の要望 (修論指導 / 卒論指導に「M」「B」のような分かりやすい印)。`emoji` は
  `letter:<文字>:<色>` も取る。文字は ASCII の英数字 1〜2 文字 (大文字・小文字はそのまま) か、日本語 1 文字
  (ひらがな U+3041–309F、カタカナ U+30A0–30FF、漢字 U+3400–4DBF / U+4E00–9FFF、々)。色はテキスト絵文字の
  パレットのキー (`gray` `red` `orange` `yellow` `green` `blue` `purple` `pink`、apps/shared/text-emoji.json)。
  サーバは `letter:` で始まる値をこの規則で確かめ、外れれば 422 (列と API の型は変えない、移行なし)。クライアントは
  角の丸い正方形に、そのパレットの背景色と文字色 (ライト / ダーク) で描く (サイドバー・ホーム・iPad / タブレットの
  一覧、セクションの操作)。アイコンの選択は「絵文字」「文字」の切り替え: 入力欄 (全角英数字と半角カナは NFKC で
  直す)・8 色の見本・その場のプレビュー。規則のケースは `apps/shared/section-icons.json` (サーバと 3 クライアントの
  テストが通す)。M114 より前のクライアントは `letter:M:blue` を文字のまま出す。カスタム絵文字のテキスト絵文字
  (M100) もアイコンにでき、ラベルの幅のピルで描く。

### channel_links (会話の上部に並べるリンク、M15f)

```sql
CREATE TABLE channel_links (
  id          uuid PRIMARY KEY,
  channel_id  uuid NOT NULL REFERENCES channels(id),
  title       varchar(80) NOT NULL,
  url         text NOT NULL,                 -- http / https のみ、2000 文字まで
  position    integer NOT NULL,              -- 0 から。並べ替えで詰め直す
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_links_channel_idx ON channel_links (channel_id, position);
```

- 会話ごとに 30 件まで。メッセージではないので channel seq は消費しない。
- 変更はすべて `channel.links_updated` (audience=channel) でメンバーへ、ペイロードはリンク全体。
  クライアントは会話を開いたとき (と再接続後に開いている会話) に `GET /channels/{id}/links` で読み直す。

### message_templates (投稿テンプレート、M30、LAB.md C / G)

```sql
CREATE TABLE message_templates (
  id          uuid PRIMARY KEY,
  scope       text NOT NULL,              -- 'workspace' (admin が編集) | 'user' (本人だけが見て編集)
  owner_id    uuid REFERENCES users(id) ON DELETE CASCADE,  -- scope='user' の持ち主。workspace は NULL
  name        varchar(20) NOT NULL,       -- `/name` の name。1〜20 文字の文字 (どの文字でも)・数字・_・-
  body        text NOT NULL,              -- 1〜4,000 文字。空白だけは不可
  suggest_in  varchar(8) NOT NULL DEFAULT 'any',  -- 'times' | 'any'
  position    int NOT NULL DEFAULT 0,     -- 選ぶ画面での並び
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'workspace' AND owner_id IS NULL) OR (scope = 'user' AND owner_id IS NOT NULL))
);
CREATE UNIQUE INDEX message_templates_workspace_name ON message_templates (lower(name)) WHERE scope = 'workspace';
CREATE UNIQUE INDEX message_templates_user_name ON message_templates (owner_id, lower(name)) WHERE scope = 'user';
```

- 入力欄に本文を挿入するための雛形。サーバは保存と配布だけで、投稿はしない (置き換えも挿入も端末が行う)。
- **名前**: 大文字と小文字を区別せずに一意 (ワークスペース共通の中で、個人の中では本人の分の中で)。共通と個人は同じ名前でもよい
  (`/name` では個人が優先)。端末の組み込みコマンド (status dnd topic invite leave join dm mute unmute me shrug poll help
  日程) の名前は付けられない (400 `template_name_reserved`)。数の上限は共通 100、個人 1 人 50 (409 `template_limit`)。
- **権限**: 共通は admin だけが作成・変更・削除 (403 `admin_required`)。個人は本人だけ。他人の個人テンプレートは見えず、
  操作は 404。ゲストも個人テンプレートは作れる。
- **API**: `GET /templates` (共通 → 自分の、それぞれ position → 名前の順)、`POST /templates` (`scope` の既定は user、
  position を省くと末尾)、`PATCH /templates/{id}` (name / body / suggest_in / position。scope は変えられない)、
  `DELETE /templates/{id}`。bootstrap の `templates` と `template.updated` で揃える (共通は audience all、個人は本人)。
- **初期データ**: マイグレーション 0041 が共通の「日報」(`suggest_in` = times) と「週報」を入れる (admin が変更・削除してよい)。

**端末の規則** (3 端末で同じ。検証ベクタは `apps/shared/templates.json`。日付は端末のローカルの日付):

- **置き換え** (挿入する時に 1 回だけ。置き換えた結果は再び置き換えない):
  `{date}` → `2026/09/28 (月)` (年は 4 桁、月日は 2 桁)、`{weekday}` → `月`、`{week}` → ISO 8601 の週 `2026-W40`
  (年は ISO 週の年: 2027/01/01 は `2026-W53`)。ほかの `{…}` (大文字違いを含む) はそのまま残す。
- **挿入**: 入力欄の「テンプレート」ボタンで一覧から選ぶか、`/name` (大文字と小文字は区別しない) を入れて送信の操作をすると、
  送らずに入力欄へ本文を入れる。入力欄が空 (または `/name` だけ) なら本文にする。`/name 文` なら本文の後に改行を挟んで
  「文」を続ける。ボタンからの挿入で入力欄に何か書いてあれば、その後ろに空行を挟んで足す。`/` の候補の一覧にも、組み込み
  コマンドの後にテンプレートを出す (選ぶとすぐ挿入)。`/help` の一覧にも名前を出す。
- **並び**: 共通 → 個人、それぞれ position → 名前。times のチャンネル (M24) では `suggest_in = times` のものを先に出す。
- **`/日程`** (LAB.md G。サーバの変更なし、既存の投票 (M14b、`POST /channels/{id}/messages` の `poll`) を複数選択で作る。
  **M53 から Web は日程調整 (SCHEDULING.md) のフォームを開き、下の書き方の日付を候補として入れる**。iOS / Android は M54 まで下のまま):
  - `/日程 ゼミ 10/3 10/4 10/6` → 質問「ゼミ」、選択肢「10/3 (土)」「10/4 (日)」「10/6 (火)」。空白で区切り、先頭から
    日付でない語を質問にする (無ければ「日程調整」)。最初の日付より後ろは日付の書き方だけ。
  - 日付: `M/D` または `YYYY/M/D`。範囲 `A-B` / `A〜B` / `A~B` (B は日付か、同じ月の日 `D`。14 日まで)。日付の直後の
    `H:MM` または `H:MM-H:MM` (〜 でも可) はその日付 (範囲なら毎日) の時刻。
  - 年を省いた日付は今年。それが今日より 30 日より前なら来年。範囲の終わりが始まりより前の月日なら翌年。
  - ラベル: `M/D (曜)`、今年でなければ `YYYY/M/D (曜)`、時刻は ` 13:00` / ` 13:00〜14:30`。同じラベルは 1 つにする。
  - 選択肢が 2〜10 個にならない、日付として読めない (2/30、13/1)、日付の後に日付でない語がある、範囲が逆・長すぎる、
    時刻が読めない・終わりが先、のどれかなら何も作らずに使い方を出す。
  - `/日程` だけなら投票の作成画面を開き、質問「日程調整」、複数選択、今日の翌日からの平日 5 日を選択肢に入れておく。

### workflows (ワークフロー、M94、WORKFLOWS.md §3)

```sql
CREATE TABLE workflows (
  id                   uuid PRIMARY KEY,
  name                 varchar(40) NOT NULL,              -- 1〜40。/名前 で開く
  emoji                varchar(32),                       -- NULL なら ⚡
  description          text NOT NULL DEFAULT '',          -- 200 文字まで
  channel_id           uuid NOT NULL REFERENCES channels(id),  -- 送り先 (公開・非公開)
  offered_channel_ids  uuid[] NOT NULL DEFAULT '{}',      -- メニューに出すチャンネル (送り先を含む、最大 10)
  fields               jsonb NOT NULL DEFAULT '[]',       -- [{key, label, type, required, help, options, multiple, default}]、最大 20
  template             text NOT NULL,                     -- 1〜4000。{{key}} を値で置き換える
  enabled              boolean NOT NULL DEFAULT true,
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at, updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz                        -- 論理削除 (投稿の workflow_id が残る)
);
CREATE UNIQUE INDEX workflows_name_uniq ON workflows (lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX workflows_offered_idx ON workflows USING gin (offered_channel_ids) WHERE deleted_at IS NULL;
```

送信 (`POST /workflows/{id}/submit`) は値を確かめて雛形を描き、出した人のふつうのメッセージとして投稿する
(`messages.workflow_id` / `workflow_name`)。提出の表は無い (メッセージが記録)。描き方と値の規則の検証ベクタは
`apps/shared/workflows.json`。

### canvases / canvas_revisions / canvas_templates (キャンバス、M41・M42、CANVAS.md §4)

```sql
CREATE TABLE canvases (
  id               uuid PRIMARY KEY,                        -- UUIDv7
  channel_id       uuid NOT NULL REFERENCES channels(id),   -- 所属する会話。権限はすべてここから
  title            varchar(200) NOT NULL,
  body             text NOT NULL DEFAULT '',                -- キャンバス用 markdown。100,000 文字まで。改行は \n に揃える
  version          bigint NOT NULL DEFAULT 1,               -- 本文・題名・設定・ゴミ箱の出し入れごとに +1 (大きい方が勝つ)
  head_rev_id      uuid NOT NULL,                           -- 現在の本文の版 (次の保存の base_rev_id)
  is_channel_tab   boolean NOT NULL DEFAULT false,          -- 会話の「キャンバス」タブ (1 会話 1 つ)
  edit_policy      varchar(16) NOT NULL DEFAULT 'members',  -- 'members' | 'owners' (DM では無視)
  template_key     varchar(40),                             -- 作成に使ったテンプレート
  share_message_id uuid REFERENCES messages(id),            -- 会話に共有したメッセージ (そのスレッドがコメント、M42)
  task_total       integer NOT NULL DEFAULT 0,              -- 保存時に数える (一覧の「3/8」)
  task_done        integer NOT NULL DEFAULT 0,
  created_by       uuid NOT NULL REFERENCES users(id),
  updated_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,                             -- ゴミ箱 (30 日後に完全削除、M42)
  deleted_by       uuid REFERENCES users(id),
  CHECK (edit_policy IN ('members', 'owners'))
);
CREATE INDEX canvases_channel_idx ON canvases (channel_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX canvases_tab_uniq ON canvases (channel_id) WHERE is_channel_tab AND deleted_at IS NULL;
-- M42 (0047): 題名と本文を 1 つの式で。`title &@~ q OR body &@~ q` の形は索引を使わない (CANVAS.md §7、§4.8)
-- M80 (0068): 本文からタスクの印 (` <!--task:<id>-->`、CANVAS.md §22) を除いた式に作り直した (検索が印に当たらないように)
CREATE INDEX canvases_search_idx ON canvases USING pgroonga
  ((ARRAY[title::text, regexp_replace(body, ' ?<!--task:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-->', '', 'g')]));

CREATE TABLE canvas_revisions (
  id              uuid PRIMARY KEY,                         -- UUIDv7
  canvas_id       uuid NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  version         bigint,                                   -- この版で canvases.version がいくつになったか。side は NULL
  kind            varchar(16) NOT NULL,                     -- create | save | merge | side | restore | erased | task (M80: タスクに合わせてサーバが作った版、CANVAS.md §22)
  parent_rev_id   uuid,                                     -- save / side: 元にした版。merge / restore: その時点の head
  author_id       uuid NOT NULL REFERENCES users(id),
  title           varchar(200) NOT NULL,                    -- その時点の題名
  body            text NOT NULL,                            -- erased は ''
  client_save_id  uuid,                                     -- 冪等キー (create・直接の save・side・restore)
  label           varchar(80),                              -- 名前付きの版 (「提出版」)
  lines_added     integer NOT NULL DEFAULT 0,               -- 親との差 (行の多重集合の差)。履歴の一覧に本文なしで出す
  lines_removed   integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (kind IN ('create', 'save', 'merge', 'side', 'restore', 'erased', 'task'))  -- 'task' は 0068
);
CREATE INDEX canvas_revisions_canvas_idx ON canvas_revisions (canvas_id, created_at);
CREATE UNIQUE INDEX canvas_revisions_save_uniq ON canvas_revisions (author_id, client_save_id) WHERE client_save_id IS NOT NULL;

-- M76 (CANVAS.md §20、移行 0066): キャンバスでメンションされた人のアクティビティの項目。未読の間は 1 キャンバス 1 行 (動かす)
CREATE TABLE canvas_mentions (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canvas_id   uuid NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,  -- 完全削除で消える。ゴミ箱の間は返さない
  rev_id      uuid NOT NULL,                 -- メンションを足した版 (外部キーなし: 版は間引かれる)
  actor_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  excerpt     text NOT NULL DEFAULT '',      -- メンションの前後の 1 行 (名前に置き換え、200 文字)
  at          timestamptz NOT NULL DEFAULT now(),  -- activity_read_at と比べる
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canvas_mentions_user_idx ON canvas_mentions (user_id, at DESC);
CREATE INDEX canvas_mentions_canvas_idx ON canvas_mentions (canvas_id, user_id);

CREATE TABLE canvas_templates (
  id          uuid PRIMARY KEY,
  key         varchar(40) NOT NULL UNIQUE,  -- 組み込み: weekly_report | minutes | research_plan | conference_checklist | thesis_schedule。admin が足したものは custom_…
  name        varchar(80) NOT NULL,
  description varchar(200),
  title       varchar(200) NOT NULL,        -- 例: '週報 {{week}} {{me_name}}'
  body        text NOT NULL,
  position    integer NOT NULL,
  builtin     boolean NOT NULL DEFAULT false,   -- 組み込みは編集・非表示はできるが削除できない
  hidden      boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

- **会話に属する**: チャンネル / DM / グループ DM / 自分との DM。権限は `channel_members` から (SECURITY.md §3.2)。
  会話あたり 200 件まで (ゴミ箱を除く、`409 too_many_canvases`)。編集は channel の seq を消費しない (未読を増やさない)。
- **版**: 本文が変わるたびに 1 行 (create / save / merge / restore)。マージした保存では、送られた本文そのものを side 版として
  残す。これがその端末の次の保存の base になる (CANVAS.md §4.4、SYNC_PROTOCOL.md §14)。履歴の一覧 (`GET
  /canvases/{id}/revisions`) は side を出さない。消去 (`DELETE …/revisions/{rev}`) は本文を '' にして kind を erased にする。
  現在の版は消去できない (`409 canvas_revision_is_head`)。erased の版は base にも復元元にもならない。
- **版の整理** (M42、1 時間ごとの `_purge_loop`、CANVAS.md §4.9): 24 時間以内の版はすべて残す。24 時間を過ぎたら side を消し、
  同じ作者の連続した save / merge は 10 分ごと (`date_bin('10 minutes', created_at)`) の最後の 1 つだけ残す。create・restore・
  erased・ラベル付き・現在の版は常に残し、連続を区切る (別の作者の版も区切る)。読み直すのは 24 時間〜8 日前の版だけ
  (整理は版が 24 時間を過ぎた直後の 1 回で済む。サーバが 7 日以上止まっていたら、その間の版が少し多く残るだけ)。
- **ゴミ箱の完全削除** (M42、同じ周期ジョブ): ゴミ箱に 30 日 (`canvas_trash_retention_days`) あったキャンバスは、画像を deleted に
  してから行ごと消す (版は ON DELETE CASCADE)。1 件ごとに監査 `canvas.purge` (actor なし。会話・題名・削除者・版の数)。
  共有メッセージは会話に残る (リンクは「表示できないキャンバス」になる)。
- **画像** (M42、CANVAS.md §4.10): 本文の `attachment:<uuid>` (大文字・小文字どちらも) が指す、保存した本人の pending の
  アップロードを、作成・保存・版の復元のたびに bind する (`attachments.canvas_id`、下記)。他人の添付・別のキャンバスの添付・
  メッセージの添付は bind しない (本文には残り、端末は「表示できない画像」)。1 キャンバス 100 件まで (`400 too_many_canvas_images`)。
  本文から消しても版が参照しているあいだは残す。bind から 24 時間を過ぎ、本文にも残っている版のどれにも id が無くなった
  画像 (整理された版・消去された版にだけあったもの) は、同じ周期ジョブが deleted にする。バイト列は添付の GC が消す。
- **共有** (M42、CANVAS.md §4.13): `share_to_channel` (作成時) と `POST /canvases/{id}/share` は、題名とパーマリンク
  `<server>/c/<id>` だけの**普通のメッセージ** (`📄 題名\n<URL>`) を同じトランザクションで投稿し、`share_message_id` に入れる。
  URL の `<server>` は要求の届いた先 (Host と X-Forwarded-Proto)。題名の `<` は全角の `＜` に替える (題名で `<!channel>` などの
  メンションが起きないように)。共有メッセージが残っていれば何もしない (冪等)。消されていれば新しく投稿する。
- **検索** (M42、CANVAS.md §4.8): 下の「代表的なクエリ」。
- **タスク**: `- [ ] 項目` / `- [x] 項目` (`*` も、先頭の空白による入れ子も) を保存時に数える。``` の囲みの中は数えない。
- **テンプレート**: 組み込みの 5 つはマイグレーション 0046 が入れ、起動時に欠けていれば入れ直す (削除はできないので、通常は何も
  しない)。作成 API の中でサーバが `tz` の日付で `{{date}}` (`2026-10-01 (木)`)、`{{week}}` (ISO 週 `2026-W40`、投稿テンプレート
  と同じ)、`{{me}}` (本文では `<@id>`、題名では表示名)、`{{me_name}}`、`{{channel}}` (チャンネル名。DM は相手の表示名を「、」で
  つないだもの、自分との DM は自分の表示名) を 1 回だけ置き換える。ほかの `{{…}}` はそのまま。
- **エクスポート**: `cli export-channel` の JSONL は、メッセージの後にキャンバスを 1 行ずつ `{"type": "canvas", …}` で出す
  (ゴミ箱を除く)。

### calendar_events / calendar_event_alarms (カレンダー、M51、CALENDAR.md §2)

```sql
CREATE TABLE calendar_events (
  id              uuid PRIMARY KEY,                          -- UUIDv7
  channel_id      uuid REFERENCES channels(id),              -- NULL = 自分用 (owner_id の人だけ)。公開・非公開チャンネルだけ (DM は不可)
  owner_id        uuid NOT NULL REFERENCES users(id),        -- 作った人
  title           text NOT NULL,                             -- 1〜200 文字
  all_day         boolean NOT NULL,
  starts_at       timestamptz,                               -- 時刻の予定: [starts_at, ends_at)、最長 14 日
  ends_at         timestamptz,
  start_date      date,                                      -- 終日の予定: start_date..end_date (end を含む)、最長 60 日
  end_date        date,
  location        text,                                      -- ≤ 200
  description     text,                                      -- ≤ 4000 (Markdown)
  client_event_id uuid,                                      -- POST の冪等キー (再送は同じ予定を返す)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,                               -- 論理削除 (calendar.event.deleted で端末に伝える)
  CHECK (char_length(title) BETWEEN 1 AND 200),
  CHECK (location IS NULL OR char_length(location) <= 200),
  CHECK (description IS NULL OR char_length(description) <= 4000),
  CHECK ((all_day AND starts_at IS NULL AND ends_at IS NULL AND start_date IS NOT NULL AND end_date IS NOT NULL
          AND end_date >= start_date AND end_date - start_date < 60)
      OR (NOT all_day AND start_date IS NULL AND end_date IS NULL AND starts_at IS NOT NULL AND ends_at IS NOT NULL
          AND ends_at > starts_at AND ends_at - starts_at <= interval '14 days'))
);
CREATE INDEX calendar_events_channel_idx      ON calendar_events (channel_id, starts_at)  WHERE channel_id IS NOT NULL AND NOT all_day AND deleted_at IS NULL;
CREATE INDEX calendar_events_personal_idx     ON calendar_events (owner_id, starts_at)    WHERE channel_id IS NULL AND NOT all_day AND deleted_at IS NULL;
CREATE INDEX calendar_events_channel_day_idx  ON calendar_events (channel_id, start_date) WHERE channel_id IS NOT NULL AND all_day AND deleted_at IS NULL;
CREATE INDEX calendar_events_personal_day_idx ON calendar_events (owner_id, start_date)   WHERE channel_id IS NULL AND all_day AND deleted_at IS NULL;
CREATE UNIQUE INDEX calendar_events_client_uniq ON calendar_events (owner_id, client_event_id) WHERE client_event_id IS NOT NULL;

CREATE TABLE calendar_event_alarms (
  event_id        uuid NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),        -- 通知を受ける人 (共有の予定でも、付けた人だけ)
  minutes_before  integer NOT NULL,                          -- 0/5/10/15/30/60/1440。終日は 1440 (前日 8:00) か -480 (当日 8:00)
  tz              varchar(64) NOT NULL,                      -- 付けた端末の IANA ゾーン (終日の 8:00 と、通知文の時刻を読む)
  fire_at         timestamptz NOT NULL,                      -- 計算した送る時刻
  status          varchar(16) NOT NULL DEFAULT 'pending',    -- pending → fired、または cancelled
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id),
  CHECK (minutes_before IN (0, 5, 10, 15, 30, 60, 1440, -480)),
  CHECK (status IN ('pending', 'fired', 'cancelled'))
);
CREATE INDEX calendar_event_alarms_due_idx  ON calendar_event_alarms (fire_at) WHERE status = 'pending';
CREATE INDEX calendar_event_alarms_user_idx ON calendar_event_alarms (user_id) WHERE status = 'pending';

-- M68 (移行 0063、CALENDAR.md §10): 繰り返し、この予定だけの変更、iCal の購読 URL
ALTER TABLE calendar_events
  ADD COLUMN rrule      text,                                -- 正規化した RRULE の一部 (NULL = 単発)
  ADD COLUMN tz         varchar(64),                         -- 繰り返しの壁時計のゾーン
  ADD COLUMN series_end timestamptz,                         -- 最後の回の終わりの上限 (NULL = 終わりなし)。期間の検索で親を絞る
  ADD CONSTRAINT rrule_tz CHECK (rrule IS NULL OR tz IS NOT NULL);
CREATE INDEX calendar_events_recurring_idx ON calendar_events (owner_id, channel_id) WHERE rrule IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE calendar_event_overrides (
  series_id        uuid NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  occurrence_start varchar(32) NOT NULL,                     -- 回の元の開始: '2030-01-10T05:00:00Z' / 終日 '2030-01-10'
  cancelled        boolean NOT NULL DEFAULT false,           -- この回は無い (iCal の EXDATE)
  changed          varchar(16)[] NOT NULL DEFAULT '{}',      -- title / time / location / description
  title text, location text, description text,               -- changed にあるときの値
  all_day boolean, starts_at timestamptz, ends_at timestamptz, start_date date, end_date date,  -- time のときの日時
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, occurrence_start)
  -- CHECK: 長さは calendar_events と同じ。日時は全部 NULL か calendar_events と同じ形
);

ALTER TABLE calendar_event_alarms ADD COLUMN occurrence_start varchar(32);  -- 繰り返しでどの回の fire_at か (NULL: 単発か目覚まし)

CREATE TABLE calendar_feeds (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,                        -- トークン (32 バイトの乱数) の SHA-256。トークンは保存しない
  scope        varchar(16) NOT NULL CHECK (scope IN ('all', 'personal')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz                                   -- 1 時間に 1 回だけ書く
);
CREATE INDEX calendar_feeds_user_idx ON calendar_feeds (user_id);
```

- **繰り返し** (M68): 単発の索引と検索は `rrule IS NULL` の行だけ。繰り返しの親は、期間に始まりが来ていて `series_end` が期間の前に
  終わっていないものと、動かした回 (`calendar_event_overrides` の日時) が期間に重なるものを読み、サーバが期間の中で展開する。

- **期間の読み出し** (`GET /calendar/events`): 時刻の予定は `starts_at < to AND ends_at > from`、終日は `from` の日付と `to` の
  直前の日付 (どちらも渡された offset で読む) に重なるもの。予定の長さに上限があるので、開始の下限 (`from - 14 日` / `first - 59 日`)
  を付けて索引の範囲で読む。1 回 1000 件まで。
- **通知の時刻**: 時刻の予定は `starts_at - minutes_before`。終日は `tz` の 8:00 (1440 は前日、-480 は当日)。予定の時刻が変わると
  全員の分を計算し直し (終日 ↔ 時刻の切り替えでは 1440 はそのまま、ほかは -480 / 60 に置き換える)、時刻が過ぎていれば cancelled
  (送らない)。予定を消すと pending は cancelled。チャンネルから抜けると、その人の通知の行を消す (outbox の channel.member_removed を
  受ける CalendarLeaveHandler)。worker は送る直前にも、予定が残っているか・まだ見られるか・終わっていないかを確かめる。
- 予定はチャンネルの seq を使わない (メッセージの同期規則に影響しない)。

### tasks / task_assignees / task_due_alarms (タスクとカンバン、M55、TASKS.md §1)

```sql
CREATE TABLE tasks (
  id                 uuid PRIMARY KEY,                       -- UUIDv7
  channel_id         uuid REFERENCES channels(id),           -- NULL = 自分用 (owner_id の人だけ)。公開・非公開チャンネルだけ (DM は不可)
  owner_id           uuid NOT NULL REFERENCES users(id),     -- 作った人
  title              text NOT NULL,                          -- 1〜200 文字 (空白は 1 つにまとめる)
  notes              text,                                   -- ≤ 4000 (Markdown)
  status             varchar(8) NOT NULL DEFAULT 'todo',     -- 列: todo / doing / done
  kind               varchar(8) NOT NULL DEFAULT 'task',     -- task / review (L9、0056) / deadline (M85 締切、0070。DEADLINES.md)
  position           double precision NOT NULL,              -- 列の中の並び (小さいほど上)
  due_on             date,                                   -- 期限の日。時刻付きなら due_at の due_tz での日付
  due_at             timestamptz,                            -- M81: 時刻付きの期限 (分まで)。NULL = 日付だけ (0069)
  due_tz             varchar(64),                            -- M81: due_at の壁時計のゾーン (due_at と一緒)
  subtasks           jsonb NOT NULL DEFAULT '[]',            -- M81: サブタスク [{id, title, done}] の並び (50 個まで)
  rrule              text,                                   -- M81: 繰り返し (CALENDAR.md §10.1 の RRULE の一部、正規化)。due_on が要る
  next_task_id       uuid,                                   -- M81: 完了で作った次の回 (冪等の印)
  column_id          uuid REFERENCES task_columns(id) ON DELETE SET NULL,  -- M81: 足した列。NULL = status の組み込みの列
  notice_days        smallint[],                             -- M85: 締切の事前の通知 (何日前、大きい順、0〜60 を 6 個まで)。締切だけ
  notice_tz          varchar(64),                            -- M85: 通知の 9:00 を読むゾーン (時刻付きなら due_tz)。締切だけ
  source_message_id  uuid REFERENCES messages(id) ON DELETE SET NULL,  -- メッセージから作ったとき
  source_channel_id  uuid,                                   -- そのメッセージのチャンネル
  source_excerpt     text,                                   -- 作った時の 1 行の抜粋 (DM の一覧・通知と同じ規則、140 文字)
  source_canvas_id   uuid REFERENCES canvases(id) ON DELETE SET NULL,  -- M72: キャンバスのチェックリストの行から作ったとき (0065)
  source_canvas_excerpt text,                                -- M72: その行の文 (1 行、200 文字)。作った時の写し (一方向のリンク)
  completed_at       timestamptz,                            -- done の間だけ入る
  completed_by       uuid REFERENCES users(id),
  client_task_id     varchar(64),                            -- POST の冪等キー (作った人ごとに一意)
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,                            -- 論理削除 (task.deleted で端末に伝える)
  CHECK (char_length(title) BETWEEN 1 AND 200),
  CHECK (notes IS NULL OR char_length(notes) <= 4000),
  CHECK (status IN ('todo', 'doing', 'done')),
  CHECK ((status = 'done') = (completed_at IS NOT NULL)),
  CHECK ((due_at IS NULL) = (due_tz IS NULL)),               -- M81
  CHECK (due_at IS NULL OR due_on IS NOT NULL),
  CHECK (rrule IS NULL OR due_on IS NOT NULL),
  CHECK (kind IN ('task', 'review', 'deadline')),
  CHECK ((kind = 'deadline') = (notice_days IS NOT NULL)),  -- M85
  CHECK ((notice_days IS NULL) = (notice_tz IS NULL)),
  CHECK (kind <> 'deadline' OR (channel_id IS NOT NULL AND due_on IS NOT NULL))
);
CREATE INDEX tasks_column_idx ON tasks (column_id) WHERE column_id IS NOT NULL;  -- M81
CREATE INDEX tasks_deadline_idx ON tasks (channel_id, due_on) WHERE kind = 'deadline' AND deleted_at IS NULL;  -- M85 「締切」

-- M85 (DEADLINES.md §3): a deadline's advance notices, one row per planned time. The key holds the time: moving the
-- deadline plans new rows (posted again for the new date), a time already posted is never posted twice.
CREATE TABLE task_deadline_notices (
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  days_before  smallint NOT NULL,                           -- 7 / 3 / 1 / 0 …
  fire_at      timestamptz NOT NULL,                        -- その日の 9:00 (notice_tz)
  status       varchar(16) NOT NULL DEFAULT 'pending',      -- pending → fired (投稿した)、または cancelled
  message_id   uuid REFERENCES messages(id) ON DELETE SET NULL,  -- ボットが投稿したメッセージ
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, days_before, fire_at),
  CHECK (status IN ('pending', 'fired', 'cancelled'))
);
CREATE INDEX task_deadline_notices_due_idx ON task_deadline_notices (fire_at) WHERE status = 'pending';

-- M85: bot accounts the server posts as by itself (key "deadlines": 「締切」, made the first time it is needed).
CREATE TABLE system_bots (
  key         varchar(32) PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- M81 (TASKS.md §11.2): a channel board's columns. The three built-in ones (builtin, one per status) have ids
-- uuid5(namespace, "<channel_id>:<status>") and get rows the first time the layout changes.
CREATE TABLE task_columns (
  id          uuid PRIMARY KEY,
  channel_id  uuid NOT NULL REFERENCES channels(id),
  name        text NOT NULL,                                -- 1〜50
  status      varchar(8) NOT NULL,                          -- その列のカードの状態 (done = 完了)
  builtin     boolean NOT NULL DEFAULT false,
  position    double precision NOT NULL,                    -- 左からの並び
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(name) BETWEEN 1 AND 50),
  CHECK (status IN ('todo', 'doing', 'done'))
);
CREATE INDEX task_columns_board_idx ON task_columns (channel_id, position);
CREATE UNIQUE INDEX task_columns_builtin_uniq ON task_columns (channel_id, status) WHERE builtin;
CREATE INDEX tasks_board_idx    ON tasks (channel_id, status, position) WHERE channel_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX tasks_personal_idx ON tasks (owner_id, status, position)   WHERE channel_id IS NULL AND deleted_at IS NULL;
CREATE INDEX tasks_source_canvas_idx ON tasks (source_canvas_id) WHERE source_canvas_id IS NOT NULL;  -- M72: 完全削除の SET NULL 用
CREATE INDEX tasks_due_idx      ON tasks (due_on) WHERE due_on IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX tasks_client_uniq ON tasks (owner_id, client_task_id) WHERE client_task_id IS NOT NULL;

CREATE TABLE task_assignees (
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),           -- そのチャンネルのメンバーだけ。自分用のタスクには付けない
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX task_assignees_user_idx ON task_assignees (user_id);

CREATE TABLE task_due_alarms (
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),           -- 知らせる人 (担当者。自分用は持ち主)
  tz          varchar(64) NOT NULL,                         -- 8:00 を読むゾーン
  fire_at     timestamptz NOT NULL,                         -- due_on の 8:00 (tz)。M81: 時刻付きなら due_at
  status      varchar(16) NOT NULL DEFAULT 'pending',       -- pending → fired、または cancelled
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id),
  CHECK (status IN ('pending', 'fired', 'cancelled'))
);
CREATE INDEX task_due_alarms_due_idx ON task_due_alarms (fire_at) WHERE status = 'pending';
```

- **並び**: 新しいカードと、位置を指定しない移動は todo / doing の一番下、done の一番上 (端から 1024 離す)。位置を指定した移動は
  前後のカードの真ん中。間が 1e-6 より狭いときは、その列を 1024 おきに振り直してから入れる (振り直したカードにも task.updated)。
  同じ位置になったら id 順。
- **期限の通知**: 知らせる人 (未完了で期限のあるタスクの担当者、自分用は持ち主) ごとに 1 行。期限・担当・状態・削除のたびに行を
  合わせる: 外れた人と done は cancelled、時刻 (`due_on` の 8:00) が変わった行は計算し直し (過ぎていれば cancelled)、done から
  戻せば pending に戻す。時刻の変わらない fired の行はそのまま (同じ通知を 2 度送らない)。tz は、変更した本人の行なら端末の
  `tz`、ほかの人はおやすみ時間のゾーン、無ければ Asia/Tokyo (作った後は行に残す)。チャンネルから抜けた人は担当から外し、通知を
  cancelled にする (outbox の channel.member_removed を受ける TaskLeaveHandler)。
- タスクはチャンネルの seq を使わない。

### ai_agents / ai_runs (AI のボットと要約、M65、docs/AI.md)

```sql
CREATE TABLE ai_agents (
  id            uuid PRIMARY KEY,
  bot_user_id   uuid NOT NULL UNIQUE REFERENCES users(id),   -- role = bot
  name          varchar(80) NOT NULL,                        -- users.display_name と同じ
  character     text NOT NULL DEFAULT '',                    -- ≤ 4000 字。システムプロンプトに入れる
  model         varchar(32) NOT NULL,                        -- claude-opus-5-5 / claude-sonnet-5-5 / claude-haiku-4-5
  effort        varchar(8) NOT NULL DEFAULT 'medium',        -- low / medium / high
  allow_private boolean NOT NULL DEFAULT false,              -- 非公開チャンネルと DM に入れるか
  enabled       boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users(id),
  created_at, updated_at timestamptz NOT NULL, deleted_at timestamptz
);

CREATE TABLE ai_runs (
  id uuid PRIMARY KEY, kind varchar(16) NOT NULL,            -- mention / summary
  status varchar(16) NOT NULL DEFAULT 'pending',             -- pending / running / done / failed
  agent_id uuid REFERENCES ai_agents(id), requester_id uuid NOT NULL REFERENCES users(id),
  channel_id uuid NOT NULL REFERENCES channels(id),
  thread_id uuid REFERENCES messages(id),                    -- 返事を書くスレッド / 要約したスレッド
  source_message_id uuid REFERENCES messages(id),            -- メンションのメッセージ
  scope varchar(16), days smallint,                          -- 要約の範囲
  input text,                                                -- 送った本文。90 日で NULL
  output text, error text, omitted_count int NOT NULL DEFAULT 0,
  attempts smallint NOT NULL DEFAULT 0, next_attempt_at timestamptz, locked_until timestamptz,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens int NOT NULL DEFAULT 0,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0, model varchar(64),
  created_at timestamptz NOT NULL, started_at timestamptz, finished_at timestamptz
);
CREATE UNIQUE INDEX ai_runs_source_uniq ON ai_runs (kind, source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX ai_runs_open_idx      ON ai_runs (created_at) WHERE status IN ('pending', 'running');
CREATE INDEX ai_runs_created_idx   ON ai_runs (created_at);                      -- 月の合計
CREATE INDEX ai_runs_requester_idx ON ai_runs (requester_id, created_at DESC);   -- 人ごとの回数・一覧
CREATE INDEX ai_runs_input_idx     ON ai_runs (created_at) WHERE input IS NOT NULL;
```

- run は送る本文 (`input`) を作ってから入れる (要約は頼んだ時点で本人が読めるメッセージ、メンションはその時点の会話)。worker は
  `pending` (と `next_attempt_at` を過ぎたもの) と、リースの切れた `running` を拾う。
- ボットの削除は論理削除 (ボットのユーザーは無効化、投稿はそのまま)。ai_runs はチャンネルの seq を使わない。

### drafts (端末間で共有する下書き、M15d)

```sql
CREATE TABLE drafts (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  channel_id  uuid NOT NULL REFERENCES channels(id),
  parent_id   uuid REFERENCES messages(id) ON DELETE CASCADE,  -- スレッドの入力欄なら親。会話の入力欄は NULL
  body        text NOT NULL,                                   -- 空にはしない (空になったら行を消す)
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX drafts_user_composer_uniq ON drafts (user_id, channel_id, parent_id) NULLS NOT DISTINCT;
```

- 個人データ (channel seq なし)。入力欄 1 つにつき 1 行、1 人 500 件まで。本文だけを共有し、添付は端末に残す。
- 抜けた会話の行は残るが、一覧 (`GET /drafts` と bootstrap) には参加中の会話の分だけを出す。
- 保存 / 削除は `draft.updated` (audience=user) で自分の全端末へ。競合の扱いはクライアント側 (SYNC_PROTOCOL.md §8)。

### notification_preferences (チャンネルごとの通知設定)

```sql
CREATE TABLE notification_preferences (
  user_id      uuid NOT NULL REFERENCES users(id),
  channel_id   uuid NOT NULL REFERENCES channels(id),
  level        text,                             -- 'all' | 'mentions' | 'none'。NULL = 本人の全体設定 (M35)
  muted_until  timestamptz,                      -- 一時ミュート
  muted        boolean NOT NULL DEFAULT false,   -- M35 解除するまでミュート
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_id)
);
```

行が無い、または `level` が NULL なら本人の全体設定 `users.notification_default` に従う (M35。解決の規則は
PUSH_NOTIFICATIONS.md §4)。M35 の移行で、種別の旧既定と同じ `level` (dm / group_dm の `all`、public / private の
`mentions`) は NULL にした (全体設定の初期値 `mentions` と結果は同じ)。API の `level` は解決後の値を返し、
`follows_default` が全体設定に従っているかを、`muted` が解除するまでのミュートかを表す。

### messages

```sql
CREATE TABLE messages (
  id                  uuid PRIMARY KEY,                    -- UUIDv7 (サーバ生成)
  channel_id          uuid NOT NULL REFERENCES channels(id),
  sender_id           uuid REFERENCES users(id),           -- system メッセージ (M88) は操作した人
  parent_id           uuid REFERENCES messages(id),        -- スレッド返信。1 段のみ (返信の返信は不可)
  also_in_channel     boolean NOT NULL DEFAULT false,      -- M15c: 返信をチャンネルのタイムラインにも出す。parent_id 必須 (CHECK)
  seq                 bigint NOT NULL,                     -- 作成時に採番 (チャンネル内シーケンス)
  updated_seq         bigint NOT NULL,                     -- 最終変更時の seq。作成時は seq と同じ
  client_msg_id       uuid,                                -- クライアント生成 idempotency key
  type                text NOT NULL DEFAULT 'user',        -- 'user' | 'system'
  body                text NOT NULL DEFAULT '',            -- 最大 20,000 文字。削除時は ''
  mentioned_user_ids  uuid[] NOT NULL DEFAULT '{}',        -- 本文の <@uuid> とグループ (<@group:…>) のメンバー
  keyword_user_ids    uuid[] NOT NULL DEFAULT '{}',        -- 通知キーワード (M12g) が本文に含まれるメンバー。クライアントに送らない (0035)
  mention_all         boolean NOT NULL DEFAULT false,      -- <!channel> / <!here>
  reply_count         integer NOT NULL DEFAULT 0,          -- スレッド親のみ
  last_reply_at       timestamptz,
  reply_user_ids      uuid[] NOT NULL DEFAULT '{}',        -- スレッド親のみ。返信した人 (削除されていない返信の送信者、最近の返信順、重複なし、最大 5)。C3 (0049)
  created_at          timestamptz NOT NULL DEFAULT now(),  -- サーバ時刻
  edited_at           timestamptz,
  deleted_at          timestamptz,                         -- トゥームストーン
  pinned_at           timestamptz,                         -- M11c: ピン留め (メンバーなら誰でも)。外すと NULL
  pinned_by           uuid REFERENCES users(id),
  system_event        jsonb,                               -- M88: type = 'system' の中身 {kind, actor_id, user_ids} (0071)。人の投稿は NULL
  workflow_id         uuid REFERENCES workflows(id),       -- M94: ワークフローのフォームから投稿した (0075)。ほかは NULL
  workflow_name       varchar(40),                         -- M94: その時のワークフローの名前 (MessageOut.workflow = {id, name})
  UNIQUE (channel_id, seq)
);
CREATE UNIQUE INDEX messages_client_msg_id_uniq ON messages (sender_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX messages_channel_updated_seq_idx  ON messages (channel_id, updated_seq);
CREATE INDEX messages_parent_idx               ON messages (parent_id, seq) WHERE parent_id IS NOT NULL;
CREATE INDEX messages_pinned_idx               ON messages (channel_id, pinned_at) WHERE pinned_at IS NOT NULL;
-- M9: CREATE INDEX messages_body_pgroonga_idx ON messages USING pgroonga (body);
-- M19 (検索と一覧): 語の無い検索 (on: / after: / before: / from:) と /mentions
CREATE INDEX messages_created_idx         ON messages (created_at) WHERE deleted_at IS NULL;
CREATE INDEX messages_sender_created_idx  ON messages (sender_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX messages_mentioned_gin       ON messages USING gin (mentioned_user_ids);
CREATE INDEX messages_keyword_hits_gin    ON messages USING gin (keyword_user_ids);
CREATE INDEX messages_mention_all_idx     ON messages (created_at) WHERE mention_all AND deleted_at IS NULL;
-- attachments: CREATE INDEX attachments_listing_idx ON attachments (attached_at DESC, id)
--              WHERE status = 'attached' AND deleted_at IS NULL;   -- GET /files の並び
```

本文の形式: プレーンテキスト。メンションは `<@{user_id}>`、グループは `<@group:{group_id}>` (M12k)、全体メンションは `<!channel>` / `<!here>` の
トークンで埋め込む (表示名の変更に追従するため)。軽量 markdown の解釈はクライアント側で行い、サーバは
解釈しない。
絵文字の `:shortcode:` (例 `:tada:`) も本文にはそのまま入り、表示時にクライアントが `apps/shared/emoji.json` の表で
絵文字に置き換える (M11f。表に無いものはそのまま表示、コードの中は置き換えない)。表は 2026-10-04 から Unicode の絵文字
(17.0) の全部 (肌の色の違いと数字の囲み・ℹ️ など、リアクションにできないものを除く 1,901 個)。shortcode は以前の表の
ものを保ち、無ければ Slack の名前、キーワードは英語と日本語の CLDR の注釈 (`gen_emoji.py --update`)。対応範囲 (M3 で確定、2026-09-26 に拡張。3 クライアントで同じ字句解析):

- インライン: `**太字**` と `*太字*`、`_斜体_`、`~~取り消し~~`、`` `code` ``、`[表示名](https://…)`、
  `https?://` のリンク自動検出。
- `_` の強調と文字どおりの記号 (M107、2026-10-05): `_斜体_` は CommonMark と同じく単語の境目だけ。開きの `_` の
  前と閉じの `_` の後が文字 (日本語・中国語の文字も文字)・数字・`_` なら強調にしない。中身の両端は空白 (全角空白も)
  でないこと。よって `snake_case_name`・`first_middle_last@example.com`・`__init__` は文字どおり、`これは _強調_ です`
  (空白)・`「_強調_」` (記号) は斜体、`これは_強調_です` は斜体にしない (Slack も同じ)。中に単語の途中の `_` を含めて
  よい (`_use snake_case here_`)。リンク自動検出の URL とメールアドレス (`英数字._%+-@ドメイン`、リンクにはしない)
  の中の `_` `*` `~` は読まない。`\_` `\*` `\~` `` \` `` はその記号の文字 (強調の中でも。コードの中とそれ以外の
  `\` はそのまま。`¯\_(ツ)_/¯` は `\` を残す)。`*` / `**` / `~~` の規則は変えない (単語の途中でも効く)。強調は
  入れ子にしない (`*_x_*` は太字の「_x_」)。通知・プレビューの 1 行 (サーバの `notification_text`、クライアントの
  `plainText`) も同じ字句解析で記号を落とす。4 か所のケースは `apps/shared/inline-format.json`。
- ブロック (行頭で判定): `# ` 〜 `### ` の見出し (3 段階。`####` 以上と `#` 直後に空白が無いものは文字どおり)、
  ```` ``` ```` 〜 ```` ``` ```` のコードブロック (開始行に言語名を書ける。閉じない場合は文字どおり)、
  `> ` の引用 (連続行をひとまとめ)、`- ` / `* ` の箇条書き、`1. ` の番号付き (先頭の番号から数える)、
  行頭 2 スペースで 1 段の入れ子。
- 表 (M15g、GFM と同じ): `|` を含む見出し行の直後に、同じ列数の区切り行 (`---`、`:--` 左寄せ、`:-:` 中央、`--:` 右寄せ。
  外側の `|` は省略可) が来たら表。続く `|` を含む行が本体 (空行か `|` の無い行で終わる)。セルの中はインライン記法を解釈し、
  `\|` は文字の `|`。列が足りない行は空セルで埋め、多い分は捨てる。区切り行が合わなければ文字どおり。
  通知・プレビューの 1 行表示ではセルの文字を空白でつなぐ。
- 画像と HTML は解釈しない。それ以外の記法は文字どおり表示する。
- 改行と空行 (2026-10-05): 1 つの改行はそのまま改行。1 行以上の空行 (空白だけの行も) は**段落の間隔**
  (本文 1 行の約 0.4: Desktop / Web 10px、iOS 10pt、Android 10dp) で、空の 1 行としては描かない。空行が何行
  続いても間隔は 1 つ (Slack・markdown と同じ)。段落の端の空行は前後のブロック (見出し・箇条書き・引用・表・
  コード) との間の同じ間隔になり、ブロックどうしの間の空行だけの段落も 1 つの間隔。コードブロックの中の空行は
  そのまま。見出し・引用・箇条書き・表・コードブロック自身の余白は変えない。入力欄のプレビューとキャンバスも
  同じ描き方。絵文字だけの大きな表示 (EMOJI.md §7) は対象外 (改行はそのまま)。3 クライアントのケースは
  `apps/shared/body-paragraphs.json`。
プレーンテキスト保存は将来の全文検索・意味検索・要約の前提でもある (ARCHITECTURE.md §10)。

### 各操作と seq / updated_seq

| 操作 | seq 消費 | 変更内容 | outbox イベント |
| --- | --- | --- | --- |
| 作成 | 1 | `seq = updated_seq = 新 seq` | `message.created` |
| 編集 | 1 | `body`, `edited_at`, `updated_seq = 新 seq` | `message.updated (change=body)` |
| 削除 | 1 | `deleted_at`, `body = ''`, `updated_seq = 新 seq`、添付を `deleted` に | `message.deleted` |
| リアクション追加 / 削除 | 1 | `reactions` 行、`updated_seq = 新 seq` | `message.updated (change=reactions)` |
| スレッド返信作成 | 1 | 返信行 (`seq = updated_seq = 新 seq`) と親の `reply_count`, `last_reply_at`, `reply_user_ids` (返信者を先頭へ), `updated_seq = 新 seq` | `message.created` (data に親のスレッド情報を含む) |
| 回収の提出状況の変化 (L6) | 1 | 親の `updated_seq = 新 seq` (返信の作成・削除の seq の次)。投稿直後に回収が付いたとき・締切後の催促も | `message.updated (change=collection)` |

### message_revisions (編集履歴、M14c)

```sql
CREATE TABLE message_revisions (
  id           uuid PRIMARY KEY,
  message_id   uuid NOT NULL REFERENCES messages(id),
  body         text NOT NULL,          -- 編集で置き換えられた本文
  written_at   timestamptz NOT NULL,   -- その本文が書かれた時刻 (created_at か直前の edited_at)
  replaced_at  timestamptz NOT NULL    -- 置き換えた編集の時刻
);
CREATE INDEX message_revisions_message_idx ON message_revisions (message_id, replaced_at);
```

- `PATCH /messages/{id}` で本文が変わったときだけ 1 行足す (同じ本文の編集は記録しない)。
- `GET /messages/{id}/revisions` は古い順。**投稿者本人だけ** (他のメンバーは `403 not_message_owner`)。
  うっかり貼ったパスワードなどを編集で消した場合に、他人から読めてはいけないため (Mattermost と同じ扱い)。
- メッセージの削除で履歴も消す。検索・エクスポート・プッシュは現在の本文だけを扱う。

### 投票 (polls、M14b)

`messages.poll jsonb` に `{ "question", "options": [..], "multiple", "anonymous", "closed_at" }` を持ち、票は別テーブルに置く
(`anonymous` は M27。無い行は記名)。

```sql
CREATE TABLE poll_votes (
  message_id    uuid NOT NULL REFERENCES messages(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  option_index  smallint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, option_index)
);
```

- 作成は `POST /channels/{id}/messages` の `poll` (質問 200 文字、選択肢 2〜10 個・各 80 文字・重複不可、`multiple`)。
  本文が空なら `📊 質問` を本文にするので、プレビュー・プッシュ・検索は本文だけで済む。
  クライアントは本文がこの `📊 質問` のままなら本文を出さない (投票のカードが質問を出すので、同じ質問が 2 回続いていた)。
- `PUT/DELETE /messages/{id}/poll/votes/{index}` は reactions と同じ扱い: 変化があれば seq を 1 つ消費して
  `updated_seq` を進め、`message.updated` (`change = poll`) で全員に届く。単一選択は前の票を動かす。
  投票は先にチャンネル行をロックしてから今の票を読む (`allocate_seq` と同じロック順なので返信と行き違わない)。
  2 端末の同時投票が互いの票を見ずに単一選択に 2 票残していた (M28a)。
- `POST /messages/{id}/poll/close` (投稿者だけ。admin も他人の投票は締め切れない、2026-09-29 テスターの要望) で `closed_at` を入れ、以後の投票は `409 poll_closed`。
- 匿名 (M27、作成時の `poll.anonymous`、後から変えない): 誰が投票したかを誰にも見せない (投稿者・admin にも)。
  `PollOut.votes` は選択肢ごとに空の配列、`counts` が件数。票のテーブルは記名と同じ (同じ人が 2 回投票しないため)。
- `PollOut.counts` は選択肢ごとの件数 (記名・匿名とも)。`PollOut.mine` はその応答を受け取る人が投票した選択肢の
  番号で、本人宛ての応答 (履歴・差分・前後・スレッド・単体・投票と締め切りの応答・検索・保存済み・スレッド一覧) にだけ入る。
  `message.updated` などのイベントはメンバー全員に同じものを配るので `mine = null`。クライアントは null なら前に知っていた
  値を保つ (SYNC_PROTOCOL.md §8)。記名の投票でも `mine` は入るが、クライアントは記名の投票の自分の票を `votes` から
  導く (イベントにも毎回入るので常に新しい。保った `mine` は別の端末で取り消した票のことがある)。
  匿名の投票で同じ人の別の端末は、次に履歴か差分を取るまで自分の票の表示が古いことがある。

#### 日程調整 (M53、SCHEDULING.md)

`messages.poll` に `"kind": "schedule"`、`"slots"` (`{"starts_at", "ends_at"}` (UTC) か `{"date"}`)、`"tz"`、`"decided"`
(`{"index", "event_id", "by", "at"}` か null) を足す。`kind` の無い行は `"choice"`。`options` は候補の見出し (サーバが
`tz` で作る)。回答は `poll_votes` に 1 人 1 候補 1 行で、`answer` 列が ○ △ × (移行 0052):

```sql
ALTER TABLE poll_votes ADD COLUMN answer varchar(8) NOT NULL DEFAULT 'yes';   -- CHECK answer IN ('yes','maybe','no')

CREATE TABLE poll_comments (
  message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  text        text NOT NULL,                                   -- CHECK char_length(text) BETWEEN 1 AND 100
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
```

- choice の投票の行は全部 `yes`。schedule の `PollOut.votes` / `counts` / `mine` は ○ だけを数える (古いアプリはそれを見る)。
- `PUT /messages/{id}/poll/answers` (自分の回答の置き換えとコメント)、`POST` / `DELETE /messages/{id}/poll/decide` (決定と
  取り消し、作成者・チャンネルのオーナー・管理者)。変化は投票と同じく seq を 1 つ取り `message.updated` (`change = poll`)。
  回答の変更で行の `created_at` は変えない (表の人の並びが動かない)。
- 決定は poll の更新・チャンネルのカレンダーの予定 (DM と `create_event: false` は作らない)・スレッドへの返信を 1 つの
  トランザクションで行う。取り消しても予定は消さない。
- `PollOut` の追加 (`answers`、`respondents`、`comments`、`my_answers`、`my_comment` など) は SCHEDULING.md §7。
  `my_answers` / `my_comment` は `mine` と同じく本人宛ての応答だけ (イベントでは null)。

### message_acks と messages.priority (重要度と確認、M15e)

```sql
ALTER TABLE messages ADD COLUMN priority varchar(16);                 -- 'important' | 'urgent' | NULL
ALTER TABLE messages ADD COLUMN ack_requested boolean NOT NULL DEFAULT false;
-- CHECK: どちらもトップレベルの投稿だけ (parent_id IS NULL OR (priority IS NULL AND NOT ack_requested))

CREATE TABLE message_acks (
  message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  acked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
```

- 重要度と「確認を求める」は投稿時にだけ付けられ、後から変えない (Mattermost と同じ)。
- 確認は投稿者以外のメンバーが `PUT / DELETE /messages/{id}/ack` で付け外しする。`MessageOut.acks` は古い順。
  変化は `message.updated` (`change = ack`) で配り、seq を消費する。メッセージを削除すると確認も消す。
- `MessageOut.poll.votes` は選択肢ごとの投票者 id の配列 (投票順、匿名なら空)。件数は `counts`、自分の票は `mine`
  (上の「投票」)。3 端末とも記名の投票は選択肢ごとに投票した人の名前を出す (M27)。

### reactions

```sql
CREATE TABLE reactions (
  message_id  uuid NOT NULL REFERENCES messages(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  emoji       text NOT NULL,      -- unicode 絵文字、または ':shortcode:'
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
```

追加は `INSERT ... ON CONFLICT DO NOTHING`、削除は `DELETE`。どちらも変化があった時だけ seq を消費する。

### attachments

```sql
CREATE TABLE attachments (
  id             uuid PRIMARY KEY,                  -- UUIDv7 (アップロード時。ファイル一覧の同時刻の並びはこの順)
  uploader_id    uuid NOT NULL REFERENCES users(id),
  message_id     uuid REFERENCES messages(id),      -- bind 時に設定
  channel_id     uuid REFERENCES channels(id),      -- bind 時に設定。アクセス制御はこの列で判定
  status         text NOT NULL DEFAULT 'pending',   -- 'pending' | 'attached' | 'deleted'
  filename       text NOT NULL,                     -- 元のファイル名 (表示用。パス区切りは除去)
  content_type   text NOT NULL,                     -- サーバ側で sniff した値
  size_bytes     bigint NOT NULL,
  sha256         bytea,
  storage_key    text NOT NULL,                     -- 'attachments/{id}'
  width          integer,                           -- 画像、M79 から動画も (回転を当てた表示上の縦横)
  height         integer,
  thumbnail_key  text,                              -- 'attachments/{id}.thumb.jpg' (画像のサムネイル、動画のポスター)
  duration_ms    integer,                           -- M79: 動画の長さ
  video_probed_at timestamptz,                      -- M79: サーバが動画を調べた時刻 (結果の有無によらず)。NULL は未調査
  preview_status text NOT NULL DEFAULT 'none',      -- M108: 'none' | 'pending' | 'ready' | 'failed' (文書のプレビュー)
  preview_pages  integer,                           -- M108: ページ数
  preview_pdf_key text,                             -- M108: 'attachments/{id}.preview.pdf' (Office を変換した PDF。PDF のアップロードは NULL = 元のファイル)
  preview_thumb_key text,                           -- M108: 'attachments/{id}.preview.webp' (1 ページ目、幅 800 px)
  preview_width  integer,                           -- M108: サムネイルの縦横 (画素)
  preview_height integer,
  preview_attempts integer NOT NULL DEFAULT 0,      -- M108: 試行回数 (claim ごとに +1、上限 PREVIEW_MAX_ATTEMPTS)
  preview_next_at timestamptz,                      -- M108: 次に取ってよい時刻 (再試行の待ち、処理中のリース)
  preview_error  text,                              -- M108: 最後の失敗の理由 (300 文字まで)
  created_at     timestamptz NOT NULL DEFAULT now(),
  attached_at    timestamptz,
  deleted_at     timestamptz
);
CREATE INDEX attachments_message_idx ON attachments (message_id);
CREATE INDEX attachments_gc_idx      ON attachments (status, created_at);
CREATE INDEX attachments_preview_queue_idx ON attachments (preview_next_at) WHERE preview_status = 'pending';  -- M108
```

メタデータは PostgreSQL、バイト列はオブジェクトストレージ (versitygw)。
ライフサイクル: `pending` (アップロード済み、未添付。アップローダーのみ参照可) → `attached`
(メッセージに紐付け。チャンネルメンバーが参照可) → `deleted` (メッセージ削除。GC がバイト列を消す)。
`pending` のまま 24 時間経過したものは GC が削除する。1 メッセージあたり最大 10 件。

M42: `canvas_id uuid REFERENCES canvases(id) ON DELETE SET NULL` (部分索引 `attachments_canvas_idx`)。キャンバスの本文の画像は
`message_id` が NULL、`channel_id` がキャンバスの会話、`canvas_id` がそのキャンバス。`canvas_id` のある添付は、公開チャンネルでも
**会話のメンバーだけ**が読める (キャンバスと同じ。メッセージの添付の「参加前のプレビュー」(M27) は当てはまらない)。
ファイル一覧 (`GET /files`) とメッセージ検索のファイル名の枝は messages と結合するので、キャンバスの画像を含まない。
キャンバスの完全削除では deleted にしてから行を消す (SET NULL は行を消せるようにするためだけ)。1 キャンバス最大 100 件。

M79 (migration 0067): **動画の縦横・長さ・ポスター**。`video/*` のアップロードをサーバが ffprobe / ffmpeg で調べ、
`width` / `height` (回転と画素の縦横比を当てた、送った人が見た向きの縦横。画像と同じ列)、`duration_ms`、ポスター
(1 秒目、2 秒未満の動画は最初のフレーム。画像のサムネイルと同じ 512 px の JPEG を同じ `thumbnail_key` に置き、
同じ `GET /attachments/{id}/thumbnail` で返す) を入れる。手順と制限は SECURITY.md §4 「動画」。
`AttachmentOut` では、画像のサムネイルは `has_thumbnail`、動画のポスターは `has_poster` (動画では `has_thumbnail` は
常に false。M82 より前の Android はサムネイルのある添付をすべて写真として出すため) と `duration_ms`。
調べられなかった動画 (壊れている、対応しない形式、時間切れ) は縦横もポスターも無く、`video_probed_at` だけ入る。
ffmpeg の無いサーバや M79 より前の動画は `video_probed_at` が NULL のままで、`app.cli probe-videos` (infra/README.md の
運用コマンド) が後から埋める。メッセージに付いた動画はそのメッセージの `updated_seq` を進めて `message.updated`
(`change = "attachments"`) を出すので、端末は差分で受け取る (SYNC_PROTOCOL.md §7.3)。

M82 iOS (build 75): `AttachmentOut` は `has_poster` (無ければ false) と `duration_ms` (無ければ nil) を読む。動画のタイル
(`VideoTileModel`) はサーバの `width` / `height` で最初から最終の箱 (逆さのリストの行の高さが後から変わらない)、`has_poster`
なら `/thumbnail` のポスターを出して動画本体は開いたときだけ落とす。端末で動画を読む (ヘッダの縦横、`AVAssetImageGenerator`
のフレーム) のはポスターが無いか取得に失敗したときだけで、それも端末に既にある複製か開くために落とした複製だけ (タイルの
ために落とさない)。タイルの左下に「0:42 · 1.9 MB」、プレーヤーは最初のフレームが出るまでポスターを
`contentOverlayView` に重ねる。送信前のタイルとファイル一覧にもポスター (ファイル一覧は長さも)。`message.updated` は
change で分岐せずメッセージ全体を置き換える (`attachments` も知らない値も)。タイルの task は `has_poster` が変わると
やり直すので、backfill の後のポスターもそのまま出る。

M82 Android: 動画の判定は `content_type` (`video/`) で、写真の判定も `content_type` が `image/` かつ `has_thumbnail`
(出荷版の `isImage = hasThumbnail` を直した。動画は `has_thumbnail` が立っていても写真にならない)。`has_poster` /
`duration_ms` は省略可 (false / null) でデコードし、端末の保存も同じ形。メッセージの動画は `width` / `height` から
最初から最終の大きさ (280 × 240 dp 以内、拡大しない) のタイルで、`has_poster` なら `/thumbnail` のポスター、再生マーク、
左下に「0:42 · 1.9 MB」。動画の本体はタップして開いたときだけ、キャッシュの `downloads/` に流し込んで (メモリに全体を
持たない) アプリ内のプレーヤー (プラットフォームの VideoView と MediaController。ライブラリは足さない) で再生し、
最初のフレームが出るまでポスターと読み込み中を重ねる。ツールバーから他のアプリでも開ける (同じキャッシュを渡す)。
ポスターが無い・読めないときは映画のアイコンのタイル、縦横もポスターも無い (M79 より前のサーバ、未調査の動画) ときは
今までどおりのファイル行で、端末で動画からフレームや縦横を読むことはしない。送信前のタイルとファイル一覧にも
ポスター (と長さ)。`message.updated` は `change` で分岐せずメッセージを置き換えるだけなので、`"attachments"` も
知らない値もそのまま効く (`VideoAttachmentsTest`)。

M108 (migration 0082): **文書のプレビュー** (docs/PREVIEWS.md)。PDF と Office の文書 (doc / docx / xls / xlsx / ppt / pptx /
odt / ods / odp / rtf) のアップロードは `preview_status = 'pending'` で保存し、app の preview loop が converter
(Gotenberg) で PDF にして (PDF はそのまま) 1 ページ目を WebP にし、`preview_*` を埋めて `ready` にする。失敗は
`failed` と `preview_error`。メッセージに付いていればそのメッセージの `updated_seq` を進めて `message.updated`
(`change = "attachments"`)。GC と `verify-attachments` はプレビューのオブジェクトも扱う。既存の行は `none` のまま
(列の追加だけ)、`app.cli generate-previews` が作る。`AttachmentOut.preview` = `{status, pages, width, height}`
(`none` は null)。送信 (bind) は自分の pending の添付を `FOR UPDATE` で読む (プレビューの記録と順序をそろえる、
PREVIEWS.md §3)。

### outbox_events

```sql
CREATE TABLE outbox_events (
  id             bigserial PRIMARY KEY,
  event_type     text NOT NULL,        -- 'message.created' など (SYNC_PROTOCOL.md §6)
  channel_id     uuid,                 -- チャンネル系イベント
  seq            bigint,               -- seq を消費したイベントのみ
  audience_type  text NOT NULL,        -- 'channel' | 'user' | 'session' | 'all'
  audience_id    uuid,                 -- user / session の場合
  payload        jsonb NOT NULL,       -- クライアントに送る data そのもの
  created_at     timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text
);
CREATE INDEX outbox_events_pending_idx ON outbox_events (id) WHERE processed_at IS NULL;
```

- 書き込みは必ずドメイン変更と同じトランザクション内で `write_outbox(session, event)` を使う。
- `payload` にはクライアントへ送る完全な状態 (メッセージなら reactions・attachments 込み) を入れる。
  Relay が後から読み直すと、その間の変更で状態が変わり得るため。
- 処理済み行は 7 日後に周期ジョブが削除する (デバッグ用に短期間残す)。
- `attempts` が 10 を超えた行はスキップしてログに出す (poison event でリレーが止まらないようにする)。
  そうした行は処理済みと同じ保持期間 (7 日) の後に削除し、`/readyz` では `outbox_pending` に数えず
  `outbox_failed` として別に出す (以前は永遠に残り、pending として数えられ続けた。M28a)。

### push_deliveries

```sql
CREATE TABLE push_deliveries (
  id               bigserial PRIMARY KEY,
  event_id         bigint NOT NULL,                  -- outbox_events.id (FK なし。outbox は purge される)
  device_id        uuid NOT NULL REFERENCES devices(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  kind             text NOT NULL,                    -- 'alert' | 'silent'
  collapse_key     text,                             -- channel_id。端末側で同一チャンネルの通知をまとめる
  channel_id       uuid,
  message_id       uuid,
  message_seq      bigint,                           -- 送信直前の「既読済みならスキップ」判定に使う
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending',  -- 'pending' | 'sent' | 'failed' | 'skipped'
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,             -- 既定 created_at + 10 分
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  UNIQUE (event_id, device_id)                       -- outbox 再処理時の二重計画を防ぐ
);
CREATE INDEX push_deliveries_pending_idx ON push_deliveries (next_attempt_at) WHERE status = 'pending';
```

### link_previews (M11g)

```sql
CREATE TABLE link_previews (
  url_hash     text PRIMARY KEY,       -- sha256(URL、フラグメント除去後)
  url          text NOT NULL,
  status       text NOT NULL,          -- 'ok' | 'failed'
  title        text,
  description  text,
  image_url    text,
  site_name    text,
  fetched_at   timestamptz NOT NULL
);
```

メッセージ本文の URL に対する Open Graph 情報のキャッシュ (SECURITY.md §14)。メッセージとは結び付けず URL 単位で
持つので、同じリンクが何度貼られても取得は 1 回。成功は 7 日、失敗は 1 日で取り直す。クライアントは表示時に
`GET /link-previews?url=` で取り、端末内でも URL 単位にキャッシュする。iOS はアカウントの端末内 DB (meta
`preview:<url>`、新しい 500 件) に残し、会話を開き直しても (再起動後も) カードを最初から描く。まだ無いリンクの行は
カードと同じ高さの枠を先に出す (カードは中身によらず同じ高さ)。カードが後から来て上の行が動き、開いた会話の
位置が飛んでいた (テスター、2026-10-01)。

### audit_logs (M10)

```sql
CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  actor_id     uuid REFERENCES users(id),
  action       text NOT NULL,      -- 'user.create' | 'user.deactivate' | 'user.reset_password' | 'session.revoke' | ...
  target_type  text,
  target_id    uuid,
  details      jsonb,
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

### workspace_identity (デプロイの識別子、WORKSPACES.md)

```sql
CREATE TABLE workspace_identity (
  singleton   boolean PRIMARY KEY DEFAULT true CHECK (singleton),  -- 常に 1 行
  id          uuid NOT NULL,          -- migration 0034 で gen_random_uuid()
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

`GET /api/v1/server` とプッシュのペイロードで `workspace_id` として返す。クライアントはこの値で
通知をワークスペースに振り分ける。データなのでバックアップ / 復元で保たれる。行が無ければ起動時に作る。

### workspace_settings (ワークスペースの設定、M88、docs/MEMBERSHIP.md §3)

```sql
CREATE TABLE workspace_settings (
  singleton                 boolean PRIMARY KEY DEFAULT true CHECK (singleton),  -- 常に 1 行 (0071 で作る)
  show_membership_messages  boolean NOT NULL DEFAULT true,   -- 「参加・退出の表示」
  preview_before_join       boolean NOT NULL DEFAULT true,   -- 「参加前にチャンネルの中を見られる」(M27 のプレビュー)
  default_channel_ids       uuid[],                          -- M90 (0073) 「既定のチャンネル」、順序付き。NULL = 一度も保存していない
  icon_key                  text,                            -- M93 (0074) ワークスペースのアイコン (オブジェクトストアの `workspace-icon/<uuid7>`、256 px の PNG)。NULL = 無し (頭文字のタイル)
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid REFERENCES users(id) ON DELETE SET NULL
);
```

行が無ければ既定値 (両方 true) として読む (古いバックアップの復元)。`PATCH /admin/workspace-settings` が無ければ作る。
変更は監査ログと `workspace.settings_updated` イベント。bootstrap の `workspace_settings` で全員に返す。
`default_channel_ids` は管理者の GET / PATCH だけに出る (bootstrap には入れない)。外部キーは無く (配列)、使う時に
公開・未アーカイブでないものを飛ばす (MEMBERSHIP.md §6)。
`icon_key` はキーの最後の部分 (アップロードごとの uuid7) を版 `icon_version` として、`GET /server` (認証不要)・bootstrap・
イベントに出す。画像は `GET /server/icon` (認証不要。WORKSPACES.md §3.4)。

### import_refs (移行元の対応、M18・M87)

```sql
CREATE TABLE import_refs (
  source      varchar(32) NOT NULL,   -- 'mattermost' | 'slack'
  kind        varchar(16) NOT NULL,   -- 'user' | 'channel' | 'post' | 'file' | 'emoji' | 'bot_as_person'
  source_id   varchar(64) NOT NULL,   -- 移行元の id (Mattermost の 26 文字の id、Slack は下記)
  target_id   uuid NOT NULL,          -- 作った行 (users / channels / messages / attachments / custom_emoji) の id
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, kind, source_id)
);
```

移行 (`app.cli import-mattermost`、infra/README.md「Mattermost からの移行」) で作った行ごとに 1 行。もう一度
実行すると、ここにある移行元の行は飛ばす (後から増えた投稿だけを足す)。外部キーは張らない (移行元ごとに
指す表が違う)。移行の対応付け:

- **messages**: 作成順に、そのチャンネルの次の seq を振る (`seq = updated_seq`)。返信は親の `reply_count`・
  `last_reply_at`・`updated_seq` を通常の投稿と同じく進める。`id` は移行元の作成時刻の UUIDv7
  (`uuid7_at`)、`client_msg_id` は移行元の id から決まる UUIDv5 (再実行でも同じ)。`created_at`・`edited_at` は
  移行元の時刻、ピン留めは `pinned_at = created_at`、`pinned_by = 投稿者`。本文の `@名前` は `<@user_id>`、
  `@channel` / `@all` は `<!channel>`、`@here` は `<!here>` に置き換え、`mentioned_user_ids` / `mention_all`
  は置き換えた本文から求める。移行元が削除した投稿とシステムメッセージは読み込まない。
- **attachments**: `status = 'attached'`、id は移行元の id から決まる UUIDv5 (再実行で同じキーに書く)。
  `content_type` はアップロードと同じく中身から判定する。
- **reactions**: カスタム絵文字は `:name:`、標準の絵文字は文字そのもの (クライアントが送る形)。
- **read_states / thread_follows**: 読み込んだメッセージは全メンバーが既読 (`last_read_seq = last_seq`)、
  スレッドの参加者 (親の投稿者と返信した人) はフォローして既読。
- **users**: 移行元の人は、指定・前回の移行・同じメールアドレスの順で既存のアカウントに対応付け、それ以外で
  投稿かリアクションのある人は無効化済みのアカウント (bot は `role = 'bot'`) を作る。M91 (Slack): メールアドレスは
  `--email-domain-map FROM=TO` で替えてから照合・保存する (移行元のアドレスは結果の表にだけ出し、アカウントにも
  import_refs にも残さない。作成の監査ログの `details.source_id` で移行元の人が分かる)。`--activate-domain` の
  ドメインのふつうのメンバー (ゲスト・bot・削除済みでない) は**有効**でパスワード無しのアカウント (Google でログインが
  アドレスで結び付ける。投稿が無くても読み込むチャンネルのメンバーなら作る)、Slack のゲスト (`is_restricted` /
  `is_ultra_restricted`) は `role = 'guest'` の無効化済み。新しい人のユーザー名はアドレスの @ の前 (学籍番号)。

Slack (M87、`app.cli import-slack`、infra/README.md「Slack からの移行」) も同じ表と同じ規則で、`source = 'slack'`。
Slack のメッセージには全体で一意の id が無いので、`source_id` は次の形にする (スキーマは変えない):

| kind | source_id |
| --- | --- |
| user | Slack のユーザー id (`U…` / `W…`)。users.json に無い bot は `bot:<bot_id>` (bot_id も無ければ `bot:name:<表示名>`) |
| user / bot_as_person | `--bot-as` の bot: `bot-as:<名前>` → 投稿を受け持つ人。`user` はどの「先」でも (M92 は `new:` だけだった)、`bot_as_person` は既存の人・Slack の人のとき (`new:` で作った人と区別する)。再実行で「先」が別の人になると止まる (REVIEW-v0.1.30 #2、infra/README.md) |
| channel | Slack のチャンネル id (`C…`、非公開 `G…`、DM `D…`) |
| post | `<チャンネル id>:<ts>` (ts は `1714521600.000100` の形) |
| file | `<post の source_id>:<ファイル id>` (同じファイルが複数のチャンネルに共有されても別の添付になる) |
| emoji | 絵文字名 (`--emoji-dir` から作ったカスタム絵文字) |

`created_at` は `ts` (秒.マイクロ秒) をそのまま使い、並びも `ts` 順。`thread_broadcast` は `also_in_channel = true` の
返信、ピン留めの `pinned_by` は channels.json の `pins` にある人 (無ければ投稿者)。リアクションの時刻は Slack の
書き出しに無いので、メッセージの時刻。

## 4. 代表的なクエリ

履歴 (上スクロール。カーソルは `seq`。トゥームストーンは含めない):

```sql
SELECT * FROM messages
WHERE channel_id = $1 AND (parent_id IS NULL OR also_in_channel) AND deleted_at IS NULL AND seq < $before_seq
ORDER BY seq DESC LIMIT $limit;
```

差分同期 (トゥームストーンを含める):

```sql
SELECT * FROM messages
WHERE channel_id = $1 AND updated_seq > $since_seq
ORDER BY updated_seq ASC LIMIT $limit;
```

差分の応答には reactions と attachments を JOIN して埋める。履歴・差分どちらも、応答に含める
`channel.last_seq` は **メッセージより先に読む** (SYNC_PROTOCOL.md §4.3)。

検索 (M9、M19 で書き換え。権限フィルタは必ず付ける)。本文と添付のファイル名は別々の枝で、それぞれの PGroonga
索引で探し、UNION ALL でまとめる (1 つの条件 `body &@~ q OR EXISTS (filename &@~ q)` ではどちらの索引も使えず、
46.5 万件で 1.4〜6 秒かかり、点数が常に 0 で「関連度順」が新しい順になっていた。書き換え後は 7〜140 ms):

```sql
SET LOCAL enable_seqscan = off;              -- PGroonga は索引で見つけた行にしか点数を付けない
SET LOCAL statement_timeout = 5000;          -- 設定 search_timeout_ms。超えたら 503 search_timeout
WITH body_hits AS MATERIALIZED (             -- 本文の語だけを条件に、messages の PGroonga 索引で
  SELECT id, channel_id, sender_id, created_at, deleted_at, type, pgroonga_score(tableoid, ctid) AS score
  FROM messages WHERE body &@~ $q
), named_files AS MATERIALIZED (             -- ファイル名だけを条件に、attachments の PGroonga 索引で
  SELECT message_id, status, pgroonga_score(tableoid, ctid) AS score
  FROM attachments WHERE filename &@~ $q
)
SELECT m.*, hits.score FROM (
  SELECT id, max(score) AS score FROM (
    (SELECT b.id, b.score, b.created_at
       FROM body_hits b WHERE <範囲 (b の列で)>  -- has: / is:thread があるときだけ messages を JOIN し直す
       ORDER BY b.score DESC, b.created_at + interval '0' DESC LIMIT $offset + $limit)
    UNION ALL
    (SELECT m.id, max(f.score), m.created_at
       FROM named_files f JOIN messages m ON m.id = f.message_id
       WHERE f.status = 'attached' AND <範囲> GROUP BY m.id, m.created_at
       ORDER BY 2 DESC, m.created_at + interval '0' DESC LIMIT $offset + $limit)
  ) both_hits GROUP BY id
) hits JOIN messages m ON m.id = hits.id
ORDER BY hits.score DESC, m.created_at DESC, m.id      -- sort=newest なら m.created_at DESC
LIMIT $limit OFFSET $offset;
-- <範囲> = m.channel_id IN (自分のチャンネル) AND m.deleted_at IS NULL AND m.type = 'user'
--          AND 修飾子 (from / after / before / has / is:thread)
```

- 各枝は語だけを条件にした MATERIALIZED の段から始める。範囲の条件を語と並べると、行の少ない表 (始めたばかりの
  ワークスペース) ではチャンネルや送信者の索引から読んで語を後から確かめる計画になることがあり、点数がすべて 0 に
  なった (CI で一度起きた)。本文の段は範囲に使う列を持ち、ヒットを id で読み直さない (読み直すと 5 万件ヒットの語で
  時間が倍になった)。46.5 万件でよくある語が 76 → 100 ms、132 → 159 ms になったほかは変わらず、結果は同じ。
- 各枝は 1 ページ分 (`offset + limit` 件) だけ取る。よくある語は数万件に当たるが、使うのは 1 ページか件数の
  上限 (1,000 + 1) まで。件数も各枝を 1,001 件で打ち切って数える。
- 並べ替えは `created_at` そのものではなく式で行う。`messages_created_idx` を使って新しい順に 1 件ずつ語を
  試す計画になると、まれな語ほど遅くなり点数も 0 になるため (まれな語で 174 ms → 67 ms)。
- 同時に走る検索は 1 プロセスあたり `search_max_concurrent` (既定 4) まで。順番を `search_timeout_ms` 待っても
  取れなければ 503 `search_busy`。遅い検索が DB 接続を使い切って投稿や同期を待たせないため (接続は
  `db_pool_size` 20 + `db_max_overflow` 10)。

検索語の修飾子 (Slack / Mattermost と同じ書き方) はサーバが解釈する: `from:@user`、`in:#channel`、
`before:YYYY-MM-DD`、`after:YYYY-MM-DD`、`on:YYYY-MM-DD`。日付は呼び出し側のタイムゾーン
(`tz_offset_minutes`) の 0 時を境にし、Slack と同じく `before` / `after` はその日を含まない。
名前は呼び出し側が見えるユーザー / チャンネルだけに解決し、解決できない修飾子は推測せず
`filters.unresolved` に返して結果を空にする。修飾子だけの検索は新しい順の一覧 (score 0) になる。
M15h で内容の条件を足した (Slack と同じ語): `has:file` (`has:attachment`)、`has:link` (本文に http(s):// を含む)、
`has:pin`、`has:reaction`、`has:poll`、`is:thread` (スレッドの返信と、返信のある親)。複数書くと AND。
理解した条件は `filters.has` / `filters.is_thread` に返し、知らない語 (`has:video` など) は `unresolved` に入れる。
投票の無いメッセージの `poll` は JSON の null (SQL の NULL ではない) なので、`has:poll` は `jsonb_typeof(poll) = 'object'` で判定する。

キャンバスの検索 (`GET /search/canvases`、M42、CANVAS.md §4.8)。メッセージと同じく語だけを条件にした MATERIALIZED の段から入り、
索引 `canvases_search_idx` を必ず使う (テストで EXPLAIN を確かめる):

```sql
WITH canvas_hits AS MATERIALIZED (
  SELECT id, channel_id, created_by, updated_by, updated_at, deleted_at, pgroonga_score(tableoid, ctid) AS score
  FROM canvases WHERE ARRAY[title::text, body] &@~ $q::text     -- 語は text として渡す (配列の隣で配列に化けないように)
)
SELECT c.*, h.score FROM canvases c JOIN (
  SELECT id, score FROM canvas_hits
  WHERE channel_id IN (自分がメンバーの会話。DM を含み、参加していない公開チャンネルは含まない)
    AND deleted_at IS NULL AND 修飾子 (from: = 作成者か最終更新者、after / before / on = updated_at)
) h ON h.id = c.id
ORDER BY h.score DESC, c.updated_at DESC, c.id                -- sort=newest なら c.updated_at DESC
LIMIT $limit OFFSET $offset;
```

抜粋 (`snippet`) は LIMIT の後、返すページの分だけ Python で作る: 本文の空白・改行を 1 つの空白にまとめ、最初に現れる
`keywords` の前後 60 字 (切ったところに「…」)。題名だけに当たったときは本文の先頭 120 字。`has:` / `is:` はキャンバスには
無いので `filters.unresolved` に返す (結果は空)。同時実行数・時間切れ・レート制限はメッセージ検索と共有する。

検索画面の絞り込みメニュー (2026-09-27) は語を書き換えずに構造化パラメータで送る: `channel_id`、`from_user_id`、
`after` / `before` (タイムゾーン付き)、`has` (繰り返し可: file / link / pin / reaction / poll)、`is_thread`、
`sort` (`relevance` 既定 / `newest`)。語の修飾子と AND で合わさり、`q` は空でもよい (条件が 1 つも無ければ
`400 empty_query`)。応答の `total` は一致件数 (1000 件で数えるのをやめ、超えたら `total_capped: true`)。

## 5. サイズと保持

| データ | 見積り | 保持 |
| --- | --- | --- |
| messages | 1 行 ≈ 300 B + 本文。100 万件で 1 GB 程度 (インデックス込み) | 無期限。削除はトゥームストーン |
| attachments (オブジェクトストレージ) | 数十 GB | メッセージ削除後、GC がバイト列を削除 (行は残す) |
| outbox_events | 1 日数千行 | 処理済みは 7 日で削除 |
| push_deliveries | 1 日数千行 | 7 日で削除 |
| sessions / devices | ユーザー × 端末 | 失効 / 無効化から 30 日で削除 |
| ai_runs | 1 回ごとに 1 行 (入力は最大 6 万字) | 行は無期限 (費用の記録)。入力の本文は 90 日で消す (M65) |
| canvases / canvas_revisions | 版 1 つ ≈ 本文の圧縮後 (約 1 万字で 9.6 KB)。1 時間の自動保存で約 700 版 | キャンバスは無期限 (ゴミ箱は 30 日で完全削除)。版は 24 時間後に整理 (M42) |

## 6. 将来の追加候補 (スキーマ上の置き場所だけ決めておく)

- (実装済み M11c) ピン留めは `messages.pinned_at / pinned_by`、ブックマークは `bookmarks` 表。
- カスタム絵文字: `custom_emoji (name, attachment_id)`。
- 意味検索 / RAG: `pgvector` 拡張と
  `message_embeddings (message_id, model, chunk_index, embedding vector(N), updated_seq, PRIMARY KEY (message_id, model, chunk_index))`。
  `updated_seq` を持たせて再埋め込みの要否を判定する。要約や抽出結果は `channel_summaries` などの
  派生テーブルに置き、`messages` は変更しない。
- 既読カーソルを端末別にしたくなった場合: `read_states` に `device_id` を加えた別表にする。現時点では不要。
