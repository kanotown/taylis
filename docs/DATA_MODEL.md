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
users 1---* channel_members *---1 channels
users 1---* read_states *---1 channels
users 1---* notification_preferences *---1 channels
channels 1---* messages 1---* reactions
                        1---* attachments
                        1---* messages (parent_id: スレッド返信)
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
  password_hash         text NOT NULL,                    -- argon2id
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
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deactivated_at        timestamptz                       -- 無効化 (ログイン不可、表示は残す)
);
```

自由登録は無い。管理者が CLI または `POST /admin/users` で作成し、仮パスワードを本人に渡す。
削除は無効化のみ。メッセージの `sender_id` 参照を保つ。

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
  ログアウトやセッション失効で `enabled = false`。
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
  CHECK ((type IN ('public', 'private')) = (name IS NOT NULL)),
  CHECK ((type IN ('dm', 'group_dm')) = (dm_key IS NOT NULL))
);
CREATE UNIQUE INDEX channels_name_uniq   ON channels (name)   WHERE name IS NOT NULL;
CREATE UNIQUE INDEX channels_dm_key_uniq ON channels (dm_key) WHERE dm_key IS NOT NULL;
```

### DM と通常チャンネルの違い

| | public | private | dm | group_dm |
| --- | --- | --- | --- | --- |
| 名前 | あり (一意) | あり (一意) | なし (相手の名前を表示) | なし (メンバー名を列挙) |
| 作成 | 誰でも | 誰でも | `POST /dms {user_ids:[u]}`。`dm_key` で既存を返す (冪等) | `POST /dms {user_ids:[...]}` 3..9 人 |
| メンバー変更 | join / leave / 招待 / 除外 | 招待 / 除外 / leave | 不可 (固定 2 人。自分宛ては 1 人) | 不可 (別の組み合わせは別チャンネル) |
| 一覧 | ブラウズ可 | メンバーのみ | メンバーのみ | メンバーのみ |
| アーカイブ | 可 | 可 | 不可 | 不可 |
| 通知の既定 | mentions | mentions | all | all |
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
- 更新は常に `GREATEST(last_read_seq, $new)` で、後退しない。複数端末は `read.updated` イベントで揃える
  (SYNC_PROTOCOL.md §10)。
- 未読数はカウンタを持たず、seq の範囲から導出する (数十チャンネル × 数十人なら十分速い)。
  `channels.last_seq - last_read_seq` の引き算ではなく COUNT を使うのは、編集・リアクション・スレッド返信も
  seq を消費するため引き算では過大になるから。

```sql
SELECT count(*)                                                              AS unread_count,
       count(*) FILTER (WHERE $me = ANY (mentioned_user_ids) OR mention_all)  AS mention_count
FROM messages m
WHERE m.channel_id = $channel AND m.seq > $last_read_seq
  AND m.parent_id IS NULL AND m.deleted_at IS NULL AND m.type = 'user';
```

自分の送信は同一トランザクションで `last_read_seq` を進めるので、自分のメッセージは未読にならない。

### thread_follows (フォロー中スレッドと、その既読位置)

```sql
CREATE TABLE thread_follows (
  parent_id      uuid NOT NULL REFERENCES messages(id),   -- parent_id IS NULL の行
  user_id        uuid NOT NULL REFERENCES users(id),
  following      boolean NOT NULL DEFAULT true,           -- false = 手動で外した
  last_read_seq  bigint NOT NULL DEFAULT 0,               -- このスレッドで読んだ最後の返信の seq
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_id, user_id)
);
CREATE INDEX thread_follows_user_idx ON thread_follows (user_id, following);
```

- 親メッセージ × ユーザーで 1 行。返信の作成時に親の投稿者・返信者・スレッド内でメンションされた人を自動で
  フォローする (`INSERT … ON CONFLICT DO NOTHING`: 手動で外した `following=false` は戻さない)。
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
- 添付は予約時に `attachments.status = 'scheduled'` に予約し、未送信アップロードの GC から外す。取消 / 失敗で
  `deleted` に戻し、GC が実体を消す。

### custom_emoji (カスタム絵文字、M12f)

```sql
CREATE TABLE custom_emoji (
  id            uuid PRIMARY KEY,
  name          varchar(32) NOT NULL UNIQUE,   -- a-z 0-9 _ + - の 2〜32 文字、本文では :name:
  created_by    uuid NOT NULL REFERENCES users(id),
  content_type  text NOT NULL,                 -- png / gif / jpeg / webp、512px 以下、256 KB 以下
  size_bytes    integer NOT NULL,
  width         integer NOT NULL,
  height        integer NOT NULL,
  storage_key   text NOT NULL,                 -- versitygw の emoji/<id>
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

- 画像は添付と同じオブジェクトストアに置き、`GET /emoji/{id}/image` (要ログイン、1 日キャッシュ) で配る。
- 誰でも追加でき、作成者か admin が削除できる。削除しても本文の `:name:` は文字のまま残る (クライアントは
  未知の名前を文字で表示する)。一覧は bootstrap の `custom_emoji` と `emoji.updated` (audience=all) で揃える。
- リアクションの `emoji` 列は `:name:` 形式も受け付ける (DATA_MODEL.md `message_reactions` の注記どおり)。

### reminders (リマインダー、M12e)

```sql
CREATE TABLE reminders (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  message_id  uuid NOT NULL REFERENCES messages(id),
  channel_id  uuid NOT NULL REFERENCES channels(id),
  note        varchar(200),
  preview     text,                                   -- 設定時点の本文 (後で変わっても通知文はこれ)
  remind_at   timestamptz NOT NULL,
  status      varchar(16) NOT NULL DEFAULT 'pending', -- pending | fired | done | cancelled
  fired_at    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reminders_due_idx  ON reminders (status, remind_at);
CREATE INDEX reminders_user_idx ON reminders (user_id, status, remind_at);
```

- 個人データ。時刻になるとワーカー (予約送信と同じループ) が `fired` にして `reminder.updated` (audience=user)
  を書き、PushPlanner がその行から本人の端末へ `kind = reminder` のプッシュを作る (DND 中は出さない)。
- 一覧 `GET /reminders` は fired (新しい順) → pending (時刻順)。`DELETE /reminders/{id}` は pending なら
  `cancelled`、fired なら `done`。fired の件数はアプリのバッジに足す。

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

### notification_preferences (チャンネルごとの通知設定)

```sql
CREATE TABLE notification_preferences (
  user_id      uuid NOT NULL REFERENCES users(id),
  channel_id   uuid NOT NULL REFERENCES channels(id),
  level        text NOT NULL,                    -- 'all' | 'mentions' | 'none'
  muted_until  timestamptz,                      -- 一時ミュート
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_id)
);
```

行が無ければチャンネル種別の既定 (dm / group_dm は `all`、public / private は `mentions`)。
ユーザー全体の既定 (quiet hours など) が必要になったら `users` に列を足す。

### messages

```sql
CREATE TABLE messages (
  id                  uuid PRIMARY KEY,                    -- UUIDv7 (サーバ生成)
  channel_id          uuid NOT NULL REFERENCES channels(id),
  sender_id           uuid REFERENCES users(id),           -- system メッセージは NULL
  parent_id           uuid REFERENCES messages(id),        -- スレッド返信。1 段のみ (返信の返信は不可)
  seq                 bigint NOT NULL,                     -- 作成時に採番 (チャンネル内シーケンス)
  updated_seq         bigint NOT NULL,                     -- 最終変更時の seq。作成時は seq と同じ
  client_msg_id       uuid,                                -- クライアント生成 idempotency key
  type                text NOT NULL DEFAULT 'user',        -- 'user' | 'system'
  body                text NOT NULL DEFAULT '',            -- 最大 20,000 文字。削除時は ''
  mentioned_user_ids  uuid[] NOT NULL DEFAULT '{}',        -- 本文の <@uuid> から抽出
  mention_all         boolean NOT NULL DEFAULT false,      -- <!channel> / <!here>
  reply_count         integer NOT NULL DEFAULT 0,          -- スレッド親のみ
  last_reply_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),  -- サーバ時刻
  edited_at           timestamptz,
  deleted_at          timestamptz,                         -- トゥームストーン
  pinned_at           timestamptz,                         -- M11c: ピン留め (メンバーなら誰でも)。外すと NULL
  pinned_by           uuid REFERENCES users(id),
  UNIQUE (channel_id, seq)
);
CREATE UNIQUE INDEX messages_client_msg_id_uniq ON messages (sender_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX messages_channel_updated_seq_idx  ON messages (channel_id, updated_seq);
CREATE INDEX messages_parent_idx               ON messages (parent_id, seq) WHERE parent_id IS NOT NULL;
CREATE INDEX messages_pinned_idx               ON messages (channel_id, pinned_at) WHERE pinned_at IS NOT NULL;
-- M9: CREATE INDEX messages_body_pgroonga_idx ON messages USING pgroonga (body);
```

本文の形式: プレーンテキスト。メンションは `<@{user_id}>`、グループは `<@group:{group_id}>` (M12k)、全体メンションは `<!channel>` / `<!here>` の
トークンで埋め込む (表示名の変更に追従するため)。軽量 markdown の解釈はクライアント側で行い、サーバは
解釈しない。
絵文字の `:shortcode:` (例 `:tada:`) も本文にはそのまま入り、表示時にクライアントが `apps/shared/emoji.json` の表で
絵文字に置き換える (M11f。表に無いものはそのまま表示、コードの中は置き換えない)。対応範囲 (M3 で確定、2026-09-26 に拡張。3 クライアントで同じ字句解析):

- インライン: `**太字**` と `*太字*`、`_斜体_`、`~~取り消し~~`、`` `code` ``、`[表示名](https://…)`、
  `https?://` のリンク自動検出。
- ブロック (行頭で判定): `# ` 〜 `### ` の見出し (3 段階。`####` 以上と `#` 直後に空白が無いものは文字どおり)、
  ```` ``` ```` 〜 ```` ``` ```` のコードブロック (開始行に言語名を書ける。閉じない場合は文字どおり)、
  `> ` の引用 (連続行をひとまとめ)、`- ` / `* ` の箇条書き、`1. ` の番号付き (先頭の番号から数える)、
  行頭 2 スペースで 1 段の入れ子。
- 見出し、表、画像、HTML は解釈しない。それ以外の記法は文字どおり表示する。
プレーンテキスト保存は将来の全文検索・意味検索・要約の前提でもある (ARCHITECTURE.md §10)。

### 各操作と seq / updated_seq

| 操作 | seq 消費 | 変更内容 | outbox イベント |
| --- | --- | --- | --- |
| 作成 | 1 | `seq = updated_seq = 新 seq` | `message.created` |
| 編集 | 1 | `body`, `edited_at`, `updated_seq = 新 seq` | `message.updated (change=body)` |
| 削除 | 1 | `deleted_at`, `body = ''`, `updated_seq = 新 seq`、添付を `deleted` に | `message.deleted` |
| リアクション追加 / 削除 | 1 | `reactions` 行、`updated_seq = 新 seq` | `message.updated (change=reactions)` |
| スレッド返信作成 | 1 | 返信行 (`seq = updated_seq = 新 seq`) と親の `reply_count`, `last_reply_at`, `updated_seq = 新 seq` | `message.created` (data に親のスレッド情報を含む) |

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
  id             uuid PRIMARY KEY,
  uploader_id    uuid NOT NULL REFERENCES users(id),
  message_id     uuid REFERENCES messages(id),      -- bind 時に設定
  channel_id     uuid REFERENCES channels(id),      -- bind 時に設定。アクセス制御はこの列で判定
  status         text NOT NULL DEFAULT 'pending',   -- 'pending' | 'attached' | 'deleted'
  filename       text NOT NULL,                     -- 元のファイル名 (表示用。パス区切りは除去)
  content_type   text NOT NULL,                     -- サーバ側で sniff した値
  size_bytes     bigint NOT NULL,
  sha256         bytea,
  storage_key    text NOT NULL,                     -- 'attachments/{id}'
  width          integer,                           -- 画像のみ
  height         integer,
  thumbnail_key  text,                              -- 'attachments/{id}.thumb.jpg'
  created_at     timestamptz NOT NULL DEFAULT now(),
  attached_at    timestamptz,
  deleted_at     timestamptz
);
CREATE INDEX attachments_message_idx ON attachments (message_id);
CREATE INDEX attachments_gc_idx      ON attachments (status, created_at);
```

メタデータは PostgreSQL、バイト列はオブジェクトストレージ (versitygw)。
ライフサイクル: `pending` (アップロード済み、未添付。アップローダーのみ参照可) → `attached`
(メッセージに紐付け。チャンネルメンバーが参照可) → `deleted` (メッセージ削除。GC がバイト列を消す)。
`pending` のまま 24 時間経過したものは GC が削除する。1 メッセージあたり最大 10 件。

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
`GET /link-previews?url=` で取り、端末内でも URL 単位にキャッシュする。

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

## 4. 代表的なクエリ

履歴 (上スクロール。カーソルは `seq`。トゥームストーンは含めない):

```sql
SELECT * FROM messages
WHERE channel_id = $1 AND parent_id IS NULL AND deleted_at IS NULL AND seq < $before_seq
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

検索 (M9。権限フィルタは必ず付ける):

```sql
SELECT m.*, pgroonga_score(m.tableoid, m.ctid) AS score
FROM messages m
WHERE m.body &@~ $q
  AND m.deleted_at IS NULL
  AND m.channel_id IN (SELECT channel_id FROM channel_members WHERE user_id = $me)
  AND ($channel IS NULL OR m.channel_id = $channel)
  AND ($from IS NULL OR m.sender_id = $from)
  AND ($after IS NULL OR m.created_at >= $after)
  AND ($before IS NULL OR m.created_at < $before)
ORDER BY score DESC, m.created_at DESC
LIMIT $limit OFFSET $offset;
```

検索語の修飾子 (Slack / Mattermost と同じ書き方) はサーバが解釈する: `from:@user`、`in:#channel`、
`before:YYYY-MM-DD`、`after:YYYY-MM-DD`、`on:YYYY-MM-DD`。日付は呼び出し側のタイムゾーン
(`tz_offset_minutes`) の 0 時を境にし、Slack と同じく `before` / `after` はその日を含まない。
名前は呼び出し側が見えるユーザー / チャンネルだけに解決し、解決できない修飾子は推測せず
`filters.unresolved` に返して結果を空にする。修飾子だけの検索は新しい順の一覧 (score 0) になる。

## 5. サイズと保持

| データ | 見積り | 保持 |
| --- | --- | --- |
| messages | 1 行 ≈ 300 B + 本文。100 万件で 1 GB 程度 (インデックス込み) | 無期限。削除はトゥームストーン |
| attachments (オブジェクトストレージ) | 数十 GB | メッセージ削除後、GC がバイト列を削除 (行は残す) |
| outbox_events | 1 日数千行 | 処理済みは 7 日で削除 |
| push_deliveries | 1 日数千行 | 7 日で削除 |
| sessions / devices | ユーザー × 端末 | 失効 / 無効化から 30 日で削除 |

## 6. 将来の追加候補 (スキーマ上の置き場所だけ決めておく)

- (実装済み M11c) ピン留めは `messages.pinned_at / pinned_by`、ブックマークは `bookmarks` 表。
- カスタム絵文字: `custom_emoji (name, attachment_id)`。
- 意味検索 / RAG: `pgvector` 拡張と
  `message_embeddings (message_id, model, chunk_index, embedding vector(N), updated_seq, PRIMARY KEY (message_id, model, chunk_index))`。
  `updated_seq` を持たせて再埋め込みの要否を判定する。要約や抽出結果は `channel_summaries` などの
  派生テーブルに置き、`messages` は変更しない。
- 既読カーソルを端末別にしたくなった場合: `read_states` に `device_id` を加えた別表にする。現時点では不要。
