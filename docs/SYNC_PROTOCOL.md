# SYNC_PROTOCOL

クライアント (Desktop / iOS / Android) とサーバの間で、メッセージと既読状態を同期する手順。
3 クライアントはこの文書を仕様として同じ挙動を実装する。サーバが常に真実 (source of truth) である。

## 1. 保証すること / しないこと

保証する:

- 同一チャンネル内のメッセージ順序は `seq` で一意に決まる。
- WS が切れていた期間の作成・編集・削除・リアクション変更は、再接続後の差分取得ですべて回復できる。
  一時的なネットワーク断、アプリのサスペンド、WS 切断、端末の再起動、プッシュ通知の取りこぼし、
  いずれの後でも同じ手順で回復する。
- 同じ送信を何度リトライしても、サーバ上のメッセージは 1 つ。
- 既読位置は複数端末で同じ値に収束する (単調増加、後退しない)。
- 同じイベントを何度受け取っても、ローカル状態は同じになる (冪等)。

保証しない:

- WS イベントの到達 (取りこぼしは差分取得で回復する前提)。
- チャンネルをまたいだ順序。
- クライアントの時計とサーバの時計の一致 (順序にクライアント時刻を使わない)。

## 2. 用語

| 用語 | 意味 |
| --- | --- |
| `seq` | チャンネル内の連番。タイムラインを変える操作ごとに 1 つ消費する (DATA_MODEL.md §2) |
| `message.seq` | メッセージが作成された時の seq。並び順・既読位置に使う |
| `message.updated_seq` | メッセージが最後に変更された時の seq。差分取得のフィルタとマージ判定に使う |
| `channel.last_seq` | チャンネルの現在の seq |
| `synced_seq` | クライアントがチャンネルごとに永続化するカーソル。「この seq までの変更はローカルに反映済み」 |
| `last_read_seq` | ユーザーの既読位置 (サーバの `read_states.last_read_seq`) |
| `client_msg_id` | クライアント生成の UUIDv4。送信の idempotency key |
| `event.id` | outbox の id。デバッグ用。カーソルには使わない |

## 3. 基本原則

1. **REST が真実、WS はヒント**。WS イベントで受け取れる情報はすべて REST でも取得できる。
2. **状態ベースの同期**。イベントは操作 (「編集された」) ではなく結果の状態 (メッセージの現在の姿) を運ぶ。
   クライアントは「新しい `updated_seq` なら上書き」だけを実装すればよい。
3. **書き込みは REST のみ**。WS からの書き込みは typing など揮発情報に限る。
4. **ローカルストアが表示の唯一のソース**。ネットワーク応答は必ずストアに入れてから画面に出す。
5. **カーソルはサーバが返した値だけを使う**。クライアントが自分で seq を計算しない。
6. **プッシュは同期の合図**。プッシュ受信後は本手順で同期し、プッシュの内容自体は表示に使わない。

## 4. REST エンドポイント (同期に関わるもの)

### 4.1 `GET /api/v1/sync/bootstrap`

起動時と WS 再接続時に呼ぶ。自分に関係する全体像を 1 回で返す。

```json
{
  "server_time": "2026-09-25T13:00:00.000Z",
  "me": { "id": "...", "username": "toru", "display_name": "...", "role": "member", "must_change_password": false },
  "users": [ { "id": "...", "username": "...", "display_name": "...", "role": "member", "deactivated_at": null } ],
  "channels": [
    {
      "id": "...", "type": "public", "name": "general", "topic": "...", "archived": false,
      "last_seq": 1532, "last_message_at": "...",
      "membership":   { "role": "member", "joined_at": "..." },
      "read_state":   { "last_read_seq": 1520, "unread_count": 9, "mention_count": 1, "first_unread_at": "2026-09-25T12:41:07.000Z" },
      "notification": { "level": "mentions", "muted_until": null },
      "dm_user_ids": null
    }
  ],
  "limits": { "max_message_length": 20000, "max_attachment_bytes": 104857600, "max_attachments_per_message": 10 },
  "threads": { "unread_count": 2, "mention_count": 1 },
  "presence": [ { "user_id": "...", "status": "online" } ],
  "bookmarks": [ "<message_id>", "..." ],
  "favorites": [ "<channel_id>", "..." ],
  "dm_pins": [ "<channel_id>", "..." ],
  "closed_dms": [ "<channel_id>", "..." ],
  "blocked_user_ids": [ "<user_id>", "..." ],
  "custom_emoji": [ { "id": "...", "name": "party_parrot", "kind": "image", "content_type": "image/gif", "width": 64, "height": 64, "label": null, "color": null, "keywords": [], "pack_id": null, "position": 0, "created_by": "...", "created_at": "..." } ],
  "emoji_packs": [ { "id": "...", "name": "ドットはんぺん", "position": 0, "tab_version": "0192…", "created_at": "...", "updated_at": "..." } ],
  "templates": [ { "id": "...", "scope": "workspace", "owner_id": null, "name": "日報", "body": "**日報 {date}**\n…", "suggest_in": "times", "position": 0, "created_at": "...", "updated_at": "..." } ],
  "groups": [ { "id": "...", "name": "design", "description": "デザイン担当", "member_ids": ["..."], "created_by": "...", "created_at": "...", "updated_at": "..." } ],
  "sidebar_sections": [ { "id": "...", "name": "プロジェクト", "position": 0, "channel_ids": ["..."] } ],
  "drafts": [ { "channel_id": "...", "parent_id": null, "body": "書きかけ", "updated_at": "..." } ]
}
```

- `channels` は自分が所属するチャンネルのみ (public のブラウズは `GET /channels?include=public`)。
- ユーザー数・チャンネル数は数十なので全件返す。増えたらページングを足す。
- `read_state` / `notification` は M8 / M5 で追加される。それまでは省略される。
- `read_state.first_unread_at` は未読に数えたメッセージ (`unread_count` と同じ条件) のうち最も古い `created_at`。
  未読が無ければ null (M17)。未読バナーの「… 以降」に使う (§10.1)。`read_state` を返す所 (§4.5 の応答、
  read-all の応答、`read.updated`) はすべてこの値を含む。
- `channels[].last_message` (M49) は会話の最後のメッセージを 1 行にしたもの (DM 一覧のプレビュー、§7.8)。
  メッセージがまだ無ければ null。
- `threads` は未読の返信があるフォロー中スレッドの数 (THREADS.md §3)。一覧そのものは `GET /threads` で取る。
- `presence` は今つながっているユーザー (§5.2)。載っていないユーザーは offline。以後の変化は `presence` フレームで届く。
- `activity` (M39) は `{ read_at, unread_count, mention_unread }`: アクティビティ (メンション、自分の投稿へのリアクション、フォロー中のスレッドへの他の人の返信) のうち `read_at` より新しく、メンションとスレッドの返信はそのメッセージを会話・スレッドでまだ読んでいないものの数 (99 まで。2026-10-06、規則は MOBILE_UI.md §6.4)。一覧は `GET /activity?filter=all|mentions|reactions|threads&cursor=`、既読は `PUT /activity/read {read_at}` (進むだけ)。再接続のたびに bootstrap の値で直し、接続中は `reaction.added`・自分へのメンションや フォロー中のスレッドの `message.created`・`activity.read`、自分の既読位置が動いた `read.updated` と `thread.updated` (`reason: "read"`) で `GET /activity/summary` を取り直す。
- `bookmarks` は自分が保存したメッセージの id (新しい順)。本文つきの一覧は `GET /bookmarks`。変化は `bookmark.updated` で届く。
- `favorites` は自分がお気に入りにしたチャンネルの id (`channels` に含まれるものだけ、M12a)。変化は `favorite.updated` で届く。
- `dm_pins` (M118) は自分が先頭に固定した DM・グループ DM の id (`channels` に含まれるものだけ、固定の古い順。この順で DM の一覧の先頭に並べる。DATA_MODEL.md conversation_pins)。M118 より前のサーバは送らない (固定なしとみなし、固定の操作を出さない)。変化は `dm_pin.updated` で届く。
- `closed_dms` (M141) は自分が閉じた (「会話を閉じる」) DM・グループ DM のうち、閉じてから新しいメッセージが来て
  いないものの id (`channels` に含まれるものだけ、閉じた古い順。DATA_MODEL.md conversation_closes)。DM の一覧から
  隠す (§7.9)。M141 より前のサーバは送らない (閉じたものなしとみなし、閉じる操作を出さない)。変化は `dm_close.updated`
  と `message.created` で届く。
- `blocked_user_ids` (M104、docs/MODERATION.md §4) は自分がブロックした人の id (古い順)。その人のメッセージは折りたたんで
  表示し、通知しない (未読の数え方は変えない)。M104 より前のサーバは送らない (空とみなす)。変化は `block.updated` で届く。
- `workspace_settings` (M88) は `{ show_membership_messages, preview_before_join, icon_version, in_app_calls, calls_enabled, meeting_base_url }` (docs/MEMBERSHIP.md §3)。M88 より前のサーバは送らない (両方 true とみなす)。変化は `workspace.settings_updated` で届く。`in_app_calls` (M130、docs/CALLS.md §5.1) は `{ enabled, video, screen_share }` (`enabled` = 管理者のスイッチ かつ サーバに LiveKit の設定がある)。無いサーバ (M130 より前) では通話のボタンを出さない。M117 の `calls_enabled` / `meeting_base_url` は M130 からいつも false / null (公開済みの M117 のクライアントが 📞 を出さないように)。
- `active_calls` (M130) は自分が入れる会話の通話中の通話 (`[CallOut]`、下の `call.started`)。変化は `call.*` で届く。
- `attendance`（M140、docs/PRESENCE.md §3.1・§4）は在室状況のボード `{ enabled, states, entries, can_personalize }`。
  ゲスト・ボットと、管理者がオフにしているときは null（M140 より前のサーバは送らない：無いものとみなす）。変化は
  `attendance.updated`（1 人の行）と `attendance.config_updated`（`GET /attendance` を読み直す）で届く。
- `actions`（M143、docs/ACTIONS.md §7.1）は自分が押せる操作ボタン `{ enabled, show_on_attendance, actions: [ActionOut] }`。
  ゲスト・ボットと、管理者がオフにしているときは null（M143 より前のサーバは送らない）。変化は `actions.updated`（`GET /actions` を読み直す）で届く。

### 4.2 `GET /api/v1/channels/{id}/messages?before_seq=&limit=50`

履歴を新しい順に返す (上スクロール用)。カーソルは `seq` (offset は使わない)。`limit` は 1〜200 (既定 50)。
「以前を読み込む」は 50、「最初の未読へ」(§10.1) は 200 で読む。
トゥームストーンは含まない。スレッド返信は含まない (「チャンネルにも送信」した返信 `also_in_channel` は含む、M15c)。

```json
{
  "channel_last_seq": 1532,
  "messages": [ { "id": "...", "seq": 1532, "updated_seq": 1532, "...": "..." } ],
  "has_more": true
}
```

### 4.3 `GET /api/v1/channels/{id}/sync?since_seq=&limit=200`

差分取得。`updated_seq > since_seq` のメッセージを `updated_seq` 昇順で返す。
トゥームストーン (`deleted: true`) とスレッド返信を含む。返信とその親は同じ `updated_seq` を持つので、
ページは必ず `updated_seq` の切れ目で終える (境界の値を持つ行はすべて同じページに入れる。`limit` をわずかに
超えることがある)。途中で切ると次のページ (`> next_since_seq`) が残りを飛ばしてしまう。

```json
{
  "messages": [ { "id": "...", "seq": 1490, "updated_seq": 1531, "deleted": false, "...": "..." },
                { "id": "...", "seq": 1500, "updated_seq": 1532, "deleted": true } ],
  "next_since_seq": 1532,
  "has_more": false
}
```

`has_more` が true の間、`since_seq = next_since_seq` で繰り返す。

サーバ実装の注意: `has_more = true` の時の `next_since_seq` は返したメッセージの最大 `updated_seq`。
`has_more = false` の時は `channels.last_seq` だが、その値は **メッセージを読む前に** 読んでおく。
逆順にすると、2 つの読み取りの間にコミットされたメッセージをクライアントが永遠に取りこぼす
(先に読んだ値は保守的で、余分に受け取った分はマージ規則が吸収する)。§4.2 の `channel_last_seq` も同じ。

### 4.4 `POST /api/v1/channels/{id}/messages`

```json
{ "client_msg_id": "6f1c...-uuid4", "body": "hello <@u1>", "attachment_ids": [], "parent_id": null }
```

- `priority` (`important` / `urgent`) と `ack_requested` (M15e) はトップレベルの投稿にだけ付けられる (返信は 422)。
  クライアントは送信キュー (§9) にも保持して再送で落とさない。
- `also_in_channel: true` (M15c) は返信 (`parent_id` あり) にだけ付けられ (他は 422)、その返信はスレッドに加えて
  チャンネルのタイムラインにも並び、チャンネルの未読に数える。1 通のメッセージなので編集・削除・リアクションは
  両方の表示に効く。投稿制限チャンネル (M15a) では新規投稿と同じ権限が要る (`403 posting_restricted`)。
  クライアントのタイムラインの規則は「`parent_id` が無い、または `also_in_channel`」。
- 応答は `201 { message }`。同じ `(sender, client_msg_id)` が既にあれば `200 { message }` で既存を返す。
- 既存のメッセージの `channel_id` がリクエストと異なる場合は `409 idempotency_conflict`
  (クライアントのバグ。同じキーを別チャンネルで再利用した)。
- `message` には常に `client_msg_id` を含める。WS の `message.created` にも含める。
- 送信者はサーバが認証情報から決める。本文の `created_at` などクライアントの時刻は受け取らない。

### 4.5 `PUT /api/v1/channels/{id}/read`

`POST /api/v1/channels/read-all` (M12a 「すべて既読にする」) は参加中の全チャンネルを末尾まで既読にし、動いたチャンネルごとに
`read.updated (reason=advance)` を出す。応答は `{ channel_id, last_read_seq, unread_count, mention_count, first_unread_at }` の配列。
本文 `{"scope": "times"}` (L8、TIMES_FEED.md §4) なら、Times フィードの対象 (会員でミュートしていない times) だけ。本文が無いか
`"all"` なら全部。

```json
{ "last_read_seq": 1532 }
```

サーバは `GREATEST(現在値, 1532)` で更新し、変化があれば `read.updated` を自分の全端末に送る。
応答は現在の `{ last_read_seq, unread_count, mention_count, first_unread_at }`。

## 5. WebSocket

### 5.1 接続と認証

- `GET /api/v1/ws` を WebSocket にアップグレード。
- 接続後 5 秒以内にクライアントが `auth` フレームを送る。ヘッダは使わない (Tauri の WebView など
  ヘッダを付けられない環境に合わせる)。
- 認証成功でサーバが `hello` を返す。失敗は `error` の後に close code `4001`。

```json
--> { "type": "auth", "token": "<access_token>" }
<-- { "type": "hello", "session_id": "...", "server_time": "...", "heartbeat_interval_sec": 30 }
```

- WS 接続はセッション (`sid`) に紐付く。access token の期限切れでは切断しない。
  セッションが失効したら `session.revoked` を送って close code `4003` で切る。
- 1 接続は最大 24 時間で `4000` (reconnect) を送って切る。クライアントは通常の再接続手順を踏む。

### 5.2 フレーム

クライアント → サーバ:

| type | 内容 |
| --- | --- |
| `auth` | `{ token }` |
| `ping` | `{ active: bool }`。`heartbeat_interval_sec` ごとに送る。`active` はウィンドウがフォーカスされている / アプリがフォアグラウンドなら true (プッシュ抑制の判定に使う。PUSH_NOTIFICATIONS.md §4.1) |
| `typing` | `{ channel_id, parent_id? }`。揮発。入力中に 3 秒に 1 回まで送る (サーバは 1 接続あたり 2 秒に 1 回だけ中継し、メンバーでなければ捨てる) |
| `canvas_presence` | `{ canvas_id, editing, section? }` (M72、CANVAS.md §18.2)。揮発。キャンバスの編集欄にフォーカスがある間 `editing: true` (見出しが変わればすぐ、そのままなら 20 秒ごと)、やめたら false。サーバは 1 接続・1 キャンバスにつき同じ内容を 2 秒に 1 回だけ中継し、キャンバスが無い・ゴミ箱・メンバーでなければ捨てる |

サーバ → クライアント:

| type | 内容 |
| --- | --- |
| `hello` | 上記 |
| `pong` | `{ server_time }` |
| `event` | `{ id, event, ts, channel_id?, seq?, data }`。`event` がイベント名 (§6)、`id` は outbox の id |
| `typing` | `{ channel_id, parent_id, user_id }`。揮発 (M11b)。送った本人以外のメンバーに届く。クライアントは 5 秒で消す。AI ボットがメンションに応える準備をしている間は、サーバがボットの `user_id` で 3 秒ごとに同じ形を送る（docs/AI.md §2.2 の 6） |
| `canvas_presence` | `{ canvas_id, channel_id, user_id, editing, section }` (M72)。揮発。キャンバスの会話の、送った本人以外のメンバーに届く。クライアントは 45 秒送り直しが無ければ消す。送った接続が切れると、その接続が最後に `editing: true` を送ったキャンバスに `editing: false` が届く |
| `presence` | `{ user_id, status: "online" \| "away" \| "offline" }`。揮発 (M11b)。接続 / 切断、`ping` の `active: true`、5 分間 active な ping が無いときの away 判定 (30 秒ごとの sweep) で、接続中の全員に届く。在席を隠した人 (`users.presence_hidden`、L4) は常に offline として配り、bootstrap の `presence` にも載せない (本人にも offline に見える)。プロセス内の状態なので、複数プロセス化するときは Redis に移す (ARCHITECTURE.md §12) |
| `error` | `{ code, message }`。`auth_required` / `invalid_token` / `invalid_frame` / `already_authenticated` など |

### 5.3 ハートビートと再接続

- クライアントは 30 秒ごとに `ping`。最後に `pong` (または任意のフレーム) を受けてから 60 秒経ったら
  切断扱いにして再接続する。期限は「最後に受けた時刻」から数え、`ping` を送るたびに延ばさない
  (延ばすと半開きの接続を永久に検知できない)。
- 接続の閉じ方: `4003` (セッション失効) はサインアウト。`4001` (auth フレームの遅れ・token 失効) は
  サインアウトせず、access token を更新して再接続する (更新が 401 で拒否されたときだけサインアウト)。
- 接続の途中 (hello 待ち・bootstrap・catch_up) で失敗・切断したら、その接続を捨ててから再接続を 1 本だけ
  予約する。古い接続の処理が後から「接続済み」にしてはならない (WS が無いのに接続済みの表示になる)。
- サーバは 90 秒 `ping` が無ければ切る。
- 再接続はジッター付き指数バックオフ (1s, 2s, 4s, ... 最大 30s)。ネットワーク復帰やフォアグラウンド復帰の
  通知を受けたら即座に試す。
- close code: `4000` reconnect 要求、`4001` 認証失敗、`4003` セッション失効、`1012` サーバ再起動。

## 6. イベント一覧

`event` フレームの `type` と `data`。seq 列が「消費」のものは、チャンネルの seq を 1 つ持つ。

| type | audience | seq | data |
| --- | --- | --- | --- |
| `message.created` | channel | 消費 | `{ message }` (reactions, attachments 込み。返信の場合は `parent_thread: { id, reply_count, last_reply_at, reply_user_ids, updated_seq, participant_ids }`。`participant_ids` はスレッドのフォロワー (THREADS.md §2) で、プッシュ対象の判定に使う。`reply_user_ids` は親の `MessageOut.reply_user_ids` と同じ値 (C3、返信した人の最近順・最大 5。古いサーバは送らないので、クライアントは無ければ手元の値を残す)) |
| `message.updated` | channel | 消費 | `{ message, change: "body" \| "reactions" \| "pin" }`。`pin` は `pinned_at` / `pinned_by` の変化 (M11c) `change` は `body` / `reactions` / `pin` / `poll` (M14b。M53 の日程調整の回答・コメント・決定も) / `ack` (M15e: `acks` の変化) / `collection` (L6、M59: 回収のある投稿の `collection` の変化。対象者の最初の返信・最後の返信の削除、締切後の催促 (`reminded_at`)、投稿直後に回収が付いたとき。返信の `message.created` / `message.deleted` の後に、親が別の seq を取って出す。RECURRING.md §3) / `tasks` (L9、M63: `MessageOut.tasks` の変化。そのメッセージから作った共有のタスクの作成・削除・状態・期限・担当。REVIEWS.md §2.2) / `call` (M130: 知らせた通話が終わり `message.call` が変わった。docs/CALLS.md §5.4) / `attachments` (M79: 添付の動画の縦横・長さ・ポスターをサーバが後から埋めた。`app.cli probe-videos` の backfill が出す。SECURITY.md §4 「動画」。M108: 添付の文書のプレビューが `ready` / `failed` になった。preview loop と `app.cli generate-previews` が出す。docs/PREVIEWS.md §3) |
| `message.deleted` | channel | 消費 | `{ message }` (`deleted: true`、`body` は空。返信の削除は親の `parent_thread` も含む) |
| `read.updated` | user | — | `{ channel_id, last_read_seq, unread_count, mention_count, first_unread_at, reason }`。アクティビティのバッジも取り直す (その会話のメンションが既読になる、MOBILE_UI.md §6.4) |
| `bookmark.updated` | user | — | `{ message_id, channel_id, bookmarked }` (M11c)。自分の他端末が保存 / 解除したときに届く |
| `activity.read` | user | — | `{ read_at }` (M39)。アクティビティの既読位置が進んだ (自分の他端末から)。クライアントはバッジを取り直す |
| `activity.items_read` | user | — | `{ item_ids, read_at }` (2026-10-07、MOBILE_UI.md §6.4)。自分のどれかの端末でアクティビティの項目を開いた (`PUT /activity/items/read`)。項目は `at` ≦ `read_at` のあいだ既読。クライアントはその行の点を消し、バッジを取り直す。知らないクライアントは無視してよい |
| `activity.updated` | user | — | `{ item_ids }` (Review v0.1.22)。持っているアクティビティの項目が書き換わった (キャンバスの版の本文の消去で抜粋が空になったとき、CANVAS.md §20.8。M112: 予約の担当者の作業が済んだとき、RESERVATIONS.md §5)。一覧を表示・保持していれば読み直す (予約の項目は「対応済み」に)。M112 からバッジも読み直す (済んだ作業は未読に数えない) |
| `reaction.added` | user (投稿者) | — | `{ channel_id, message_id, user_id, emoji, at }` (M39)。他の人が自分の投稿にリアクションした。アクティビティのバッジを取り直す (`GET /activity/summary`)。外したときは送らない (一覧は表から作るので消える) |
| `favorite.updated` | user | — | `{ channel_id, favorite }` (M12a)。自分の他端末が星を付けた / 外したときに届く。会話を自分のセクションへ入れたときも `favorite: false` で届く (DATA_MODEL.md sidebar_sections「1 つの会話は 1 か所」、2026-10-07) |
| `dm_pin.updated` | user | — | `{ channel_id, pinned, at }` (M118)。自分が DM・グループ DM を先頭に固定した / 外した (変わったときだけ。自分の全端末)。固定なら手元の `dm_pins` の最後に足し (すでにあれば動かさない)、外したなら取り除く。`at` は変えた時刻 |
| `dm_close.updated` | user | — | `{ channel_id, closed, at, closed_seq }` (M141)。自分が DM・グループ DM を閉じた / 開いた (`PUT` / `DELETE /channels/{id}/close`、既にある DM を返す `POST /dms`。閉じている状態が変わったときだけ。自分の全端末)。閉じたなら手元の `closed_dms` に足し、開いたなら取り除く。`closed_seq` は閉じた位置 (閉じたときの `last_seq`。開いたときと古いサーバは null)。手元の `last_message` の seq がそれより大きければ、その閉じたは取らない (§7.9、Review v0.1.43 #6)。新しいメッセージで開いたときは送らない (§7.9) |
| `block.updated` | user | — | `{ user_id, blocked }` (M104、docs/MODERATION.md §4)。自分がブロック / 解除したとき自分の全端末に届く。ブロックされた人には届かない |
| `scheduled.updated` | user | — | `{ scheduled: ScheduledOut }` (M12d)。予約送信の作成 / 送信済み / 失敗 / 取消。`status` で一覧の行を置き換える (sent と cancelled は一覧から外す。failed は `error` と一緒に残し、本文を下書きに戻すか `DELETE /scheduled/{id}` で消すまで表示する。`GET /scheduled` も pending と failed を返す) |
| `emoji.updated` | all | — | `{ emoji: CustomEmojiOut, deleted }` (M12f)。カスタム絵文字の追加 / 削除。クライアントは名前の表を差し替える。M100: 表示名・キーワード・色・セットの変更でも出る (文字の絵文字のピルは描き直す) |
| `emoji_pack.updated` | all | — | `{ pack: EmojiPackOut, deleted }` (M100、docs/EMOJI.md §3)。絵文字のセットの作成・名前・順番・タブのアイコン・削除。削除ではそのセットの絵文字を「セットなし」にする (それぞれの `emoji.updated` も来る) |
| `template.updated` | all (個人のテンプレートは本人) | — | `{ template: TemplateOut, deleted }` (M30)。投稿テンプレートの追加・変更・削除。クライアントは id で差し替えるか取り除く (DATA_MODEL.md message_templates) |
| `group.updated` | all | — | `{ group: GroupOut, deleted }` (M12k)。ユーザーグループの作成 / 変更 / 削除。クライアントは id の表を差し替える (`@name` の候補と `<@group:id>` の表示に使う) |
| `roster.updated` | all (guest を除く) | — | `{ user_id, profile: LabProfileOut \| null }` (M23)。名簿の行の追加 / 変更 / 削除 (`profile` が null なら外れた)。クライアントは user_id の表を差し替える。管理グループのメンバーの変化は別に `group.updated` で届く |
| `sidebar.updated` | user | — | `{ sections: [SidebarSectionOut], defaults: [SidebarDefaultOut] }` (M14f、`defaults` と各セクションの `sort` / `manual_order` は 2026-10-07)。自分のサイドバーのセクション一覧全体と既定のセクションの並べ替え。クライアントは差し替える (`defaults` が無ければ今のまま)。星を付けた会話がセクションから外れたときも届く (2026-10-07) |
| `channel.links_updated` | channel | — | `{ channel_id, links: [ChannelLinkOut] }` (M15f)。会話の上部のリンク全体。クライアントは差し替える (bootstrap には含めず、会話を開いたときに `GET /channels/{id}/links` で読む) |
| `canvas.created` | channel | — | `{ canvas: CanvasMeta }` (M41)。キャンバスの作成、ゴミ箱からの復元。本文は載せない。手順は §14 |
| `canvas.updated` | channel | — | `{ canvas: CanvasMeta, change: "content" \| "title" \| "settings" \| "restore" }` (M41)。`version` が手元より大きければメタを差し替え、開いていて編集中でなければ本文を読み直す (§14) |
| `canvas.deleted` | channel | — | `{ canvas_id, channel_id }` (M41)。ゴミ箱に移された。手元から消す |
| `canvas.mentioned` | user | — | `{ canvas_id, channel_id, rev_id, title, by_user_id }` (M72、CANVAS.md §18.1)。キャンバスの保存で新しくメンションされた (その版で 1 回)。表示は変えず、アプリを開いている端末が通知する (会話がミュート / なしなら出さない。プッシュは PushPlanner) |
| `calendar.event.updated` | channel (自分用: user) | — | `{ event: CalendarEventData, editor_ids }` (M51)。予定の作成・変更。人ごとに違う `can_edit` と `alarm` は載せない: `can_edit` は `editor_ids` に自分がいるか、`alarm` は手元の値のまま。表示中の期間に重なる予定だけを差し替え、外れたら消す。手順は §15 |
| `calendar.event.deleted` | channel (自分用: user) | — | `{ id, channel_id }` (M51)。手元から消す |
| `calendar.alarm.updated` | user | — | `{ event_id, channel_id, alarm: CalendarAlarmOut \| null, occurrence?: CalendarEventData \| null }` (M51。`occurrence` は Review v0.1.22 #9: 通知の対象の回をサーバが解決したもの、CALENDAR.md §10.11)。自分の通知の設定・計算し直し・発火 (`status: fired`)・削除 (null)。fired はアプリ内でも通知する (プッシュは PushPlanner) |
| `task.updated` | channel (自分用: user) | — | `{ task: TaskData, deleter_ids }` (M55)。タスクの作成・変更・移動 (並べ替えで振り直したカードも 1 件ずつ)。人ごとに違う `can_delete` は載せない: `deleter_ids` に自分がいるか。手順は §16 |
| `task.deleted` | channel (自分用: user) | — | `{ id, channel_id }` (M55)。手元から消す |
| `task.assigned` | user | — | `{ task_id, channel_id, channel_name, title, by_user_id, kind }` (M55。`kind` は L9、M63)。ほかの人が自分を担当に加えた (自分で加えたときは出ない)。DM のタスクの `channel_name` は空文字。アプリ内でも通知する (プッシュは PushPlanner) |
| `task.review_done` | user | — | `{ task_id, channel_id, channel_name, title, by_user_id }` (L9、M63)。自分が出したレビュー依頼を依頼先が完了にした。アプリ内でも通知する (REVIEWS.md §4) |
| `wiki.changed` | all | — | `{ seq }`（M120、§17）。ドキュメントの木の変更のフィードが進んだ。中身は人ごとに違うので載せない。端末は 300 ms まとめて `GET /wiki/changes?since=` |
| `wiki.page.updated` | page（送る時点でページを読める人） | — | `{ page: PageMeta, change }`（M120）。`change` は `content` / `meta` / `restore`。開いているページを読み直す（編集中なら次の保存でマージ）。`page.parent_id` は常に null |
| `wiki.mentioned` | user（読める人だけ） | — | `{ page_id, rev_id, title, by_user_id }`（M120）。ページの保存で新しくメンションされた |
| `wiki.shared` | user（読める人だけ） | — | `{ page_id, title, level, by_user_id }`（M120）。名前を挙げて共有された |
| `wiki.rows.changed` | page（送る時点でデータベースを読める人） | — | `{ database_id, seq, schema_version }`（M123）。行・値・題名・ゴミ箱・スキーマ・ビューが変わった。開いている表を読み直す（§17） |
| `reservation.updated` | all | — | `{ pool_id, deleted }` (M99 → M112、RESERVATIONS.md §7)。ワークスペースの予約の枠が変わった (設定・予約・待ち・利用中、`deleted` なら枠が消えた)。中身は人ごとに違う (自分の予約、担当者だけのアドレスと作業) ので載せない。端末は `GET /reservation-pools` で読み直す (続けて届いたものは 300 ms で 1 回にまとめる)。bootstrap のたびにも読む。M99〜M111 の端末は `channel_id` が無いので読まない (`GET /channels/{id}/reservation-pools` はいつも空) |
| `reservation.notice` | user | — | `{ item_id, pool_id, reservation_id, text, operator, at }` (M112)。自分あての予約の知らせ (担当者の作業か、自分の予約・利用のこと)。アクティビティの項目 (種類 `reservation`、`include=reservation`) が増えたのでバッジを読み直し、開いている端末はバナー / 通知を出す (プッシュは PUSH_NOTIFICATIONS.md §4)。ほかの担当者が対応して済みになった項目は `activity.updated` の `item_ids` に入る |
| `task.due` | user | — | `{ task_id, channel_id, channel_name, title, due_on }` (M55)。担当 (自分用は自分) の未完了のタスクの期限の日の 8:00。1 回だけ。アプリ内でも通知する |
| `draft.updated` | user | — | `{ channel_id, parent_id, body, updated_at, deleted }` (M15d)。自分の端末が下書きを保存 / 削除した (`deleted` なら `body` は空)。取り込み方は §8 |
| `ai.run_updated` | user (頼んだ人) | — | `{ run: AiRunOut }` (M65、docs/AI.md §5)。要約の状態が変わるたび (running、done、failed)。メンションの run は出さない (返事はふつうのメッセージ)。取りこぼしうるので、開いている要約は再接続のあと `GET /ai/runs/{id}` で読み直す |
| `reminder.updated` | user | — | `{ reminder: ReminderOut }` (M12e)。作成 / 発火 (fired) / 完了 / 取消。fired の行は「リマインダー」一覧の先頭に出し、アプリ内でも通知する。`kind` は `personal` / `ack` (L4) / `collect` (L6: 回収の締切後の催促。本人にだけ届く) |
| `thread.updated` | user (フォロワー) | — | `ThreadState` + `reason: "reply" \| "deleted" \| "read" \| "follow"` (THREADS.md §4)。一覧の行と「スレッド」バッジはこの値で置き換える。`read` / `follow` は本人の全端末にだけ届く。`read` ではアクティビティのバッジも取り直す (そのスレッドの返信・メンションが既読になる、MOBILE_UI.md §6.4) |
| `notification_preference.updated` | user | — | `{ channel_id, level, muted_until }` |
| `notification.test` | user | — | `{ title, body, device_id, sent_at }` (PUSH_NOTIFICATIONS.md §15)。自分が「テスト通知を送る」を押した。Desktop / Web は OS の通知を出す (`device_id` の端末、つまり押した端末は自分で出し済み)。iOS / Android は無視する (プッシュが届く)。表示は変えない |
| `channel.created` | channel (public は all)。参加・追加された本人には user 宛てにも送る | — | `{ channel, member_ids }`。`channel` は bootstrap と同じ形だが `membership` は null。受信者は `member_ids` に自分が含まれるかで所属を判定する (public は非メンバーにも届く) |
| `channel.updated` | channel。公開 ↔ 非公開の変換 (M15b) だけは all (guest を除く) | — | `{ channel, member_ids }`。`channel.posting_policy` (M15a) を含む。メンバーでない受信者は、public ならブラウズ用に保持し、public でなくなった (非公開に変換された) 会話は手元から消す。非公開への変換ではメンバーに通常の event、メンバー以外には `topic` / `purpose` / `member_count` が null で `member_ids` が空の event が届く (消すのに要る `id` と `type` だけ。メンバーの一覧を非メンバーに配らない、M28a) |
| `channel.archived` | channel | — | `{ channel_id }` |
| `channel.member_added` | channel | — | `{ channel_id, user_id }`。追加された本人には `channel.created` も送る。クライアントは保持している `member_count` を +1 (`member_removed` は −1) して、次の一覧取得までの表示に使う (M11h) |
| `channel.member_removed` | channel + 本人 (outbox 行を 2 つ書く) | — | `{ channel_id, user_id }` |
| `channel.member_updated` | channel | — | `{ channel_id, user_id, role }` (L4、M31)。オーナーの追加・解除 (`PATCH /channels/{id}/members/{user_id}`)。自分なら `membership.role` を変え、開いているメンバー一覧を読み直す |
| `user.created` / `user.updated` / `user.deactivated` | all | — | `{ user }` (UserPublic)。本人だけの設定 (UserMe の `notify_keywords`・`notification_default`・`notify_reactions`・`quick_reactions`・`nav_items`・`locale`・`composer_mode`・`docs_editor_mode` など) は載らない。`PATCH /users/me` はどの項目でも `updated_at` を進めて `user.updated` を出すので、**自分についての `user.updated` の `updated_at` が手元の `me` より新しければ、別の端末が設定を変えた**: クライアントは `GET /users/me` を読み直して `me` を置き換える (M50。iOS・Android も M111 から読み直す。読み直さない端末も次の bootstrap の `me` で揃う) |
| `session.revoked` | session | — | `{ reason }` |
| `attendance.updated` | all（guest を除く） | — | `{ user_id, state_id, since, note, source, log_id }`（M140、docs/PRESENCE.md §4）。ある人の在室状況が変わった。`user_id` の行を置き換える。`state_id` を知らなければ `GET /attendance` を読み直す。`log_id` は端末では使わない |
| `attendance.config_updated` | all（guest を除く） | — | `{}`（M140）。在室状況の有効・無効、自分用の状態の規則、状態（ワークスペース・個人）が変わった。人ごとに違う（`can_personalize`）ので中身は無い。`GET /attendance` を読み直す（300 ms でまとめる。`enabled: false` ならボードを消す） |
| `actions.updated` | all（guest を除く） | — | `{}`（M143、docs/ACTIONS.md §8）。操作ボタンの設定かボタンが変わった。押せるボタンは人ごとに違うので中身は無い。`GET /actions` を読み直す（続けて届いたものは 300 ms でまとめる） |
| `actions.status_updated` | 組のボタンを 1 つでも押せる人（outbox の audience `action`） | — | `ActionStatusOut`（M143、docs/ACTIONS.md §12.3）。操作する機器の状態。押した数秒後の再読か、状態が変わったとき。`fetched_at` が手元より古ければ捨てる。再接続の後は `GET /actions/status` で揃える |
| `workspace.settings_updated` | all | — | `{ settings: { show_membership_messages, preview_before_join, icon_version, in_app_calls, calls_enabled, meeting_base_url } }` (M88、docs/MEMBERSHIP.md §3。`in_app_calls` は M130、`calls_enabled` / `meeting_base_url` はいつも false / null。docs/CALLS.md)。管理者がワークスペースの設定を変えた。手元の値を置き換え、開いているプレビューを追従させる (オフなら行を捨てて「参加するとメッセージを読めます」、オンなら読み込む) |
| `call.started` / `call.updated` / `call.ended` | channel | — | `{ call: CallOut }` (M130、docs/CALLS.md §5.3)。`CallOut` = `{ id, channel_id, message_id, started_by, started_at, ended_at, participants: [{ user_id, joined_at }], participant_count, peak_participants }`。通話が始まった / 人が入った・抜けた / 終わった。会話の「通話中 (n)」を id で置き換える (ended なら外す)。seq は無く取りこぼしうるので、再接続のあとは bootstrap の `active_calls` か `GET /calls?active=true` で置き換える。通話の記録はメッセージの側 (終わると `message.updated` の change `call`) |

`message.created` の `message.type` が `"system"` の行 (M88 の参加・退出の一言。`system_event` に `{kind, actor_id, user_ids}`) も
seq を 1 つ取り、ふつうの行と同じに差分・マージする。未読・通知・メンションには数えない (§10.1 12.、docs/MEMBERSHIP.md §1)。

`message.call` が null でない行 (M130: `{kind: "livekit" | "link", url, started_by, call_id, started_at, ended_at, duration_seconds, participant_count}`。M117 の会議リンクは `kind: "link"` で `url` / `started_by` だけ) は通話を始めたメッセージ (docs/CALLS.md §5.4)。LiveKit の通話の `url` は `<PUBLIC_BASE_URL>/call/<id>`。通話が終わると `message.updated` (change `call`、新しい seq) で終わった時刻・長さ・人数が入る。ふつうの
`type = "user"` の行なので、未読・通知・検索も同じに扱う。

`message` オブジェクトの形は REST と同一 (`openapi/openapi.json` の `MessageOut` スキーマ)。フレームと各イベントの
`data` の JSON Schema は `openapi/ws-events.json` に生成される。

## 7. クライアントの同期手順

### 7.1 状態

チャンネルごとに `synced_seq` (nullable) を持つ。`null` は「このチャンネルのメッセージをまだ 1 件も
ローカルに持っていない」。加えて `channel.last_seq`、`last_read_seq`、`unread_count`、`mention_count`。
これらはローカルストア (SQLite) に永続化し、端末の再起動やアプリの再インストール以外では失わない。

### 7.2 起動 (コールドスタート / ウォームスタート共通)

保存済みの本人情報と refresh token がある場合は、ローカルストアを先に読み込み画面を表示する。
接続前に access token が無いか残り 60 秒未満なら更新する (まだ有効なら更新しない)。更新のたびに refresh token が
ローテーションされ、応答を取りこぼした古い token を 30 秒以上後に使うと再利用検知でセッションが失効するため
(SECURITY.md §2.3)。通信エラーならキャッシュと下書きを保持し、更新は 30 秒の猶予内に短い間隔で再試行する。
認証拒否 (`401`) はログアウトする。ローカルに本人情報が無い初回ログインには接続が必要。
ブラウザ版 (M12j) はローカルストアを持たない (メモリのみ) ので毎回この「初回ログイン」と同じ経路になり、
refresh token は HttpOnly cookie から復元する (SECURITY.md §2.3)。

```
1. WS を接続して auth。hello を受ける。以後に届くイベントはいったんバッファする
2. bootstrap を取得し、users / channels / membership / read_state / notification をローカルに上書き
3. バッファしたイベントを順に適用し (§7.4)、ライブ状態に入る
4. 表示中のチャンネルについて catch_up(channel) を実行。他のチャンネルは開いた時
```

WS を先に張ってから bootstrap を取る理由: hello 以降の変更はすべて WS で届き、hello 以前の状態は
bootstrap に含まれるので、両者の間に隙間ができない。bootstrap の応答とバッファしたイベントが
重複しても、マージ規則 (§8) で同じ結果になる。catch_up (4) と WS イベントの順序も問わない。

### 7.3 catch_up(channel)

```
if synced_seq is null:
    r = GET /channels/{id}/messages?limit=50           # 最新ページ
    upsert(r.messages)
    synced_seq = r.channel_last_seq                    # ページより後の変更は WS / 差分で追う
else:
    loop:
        r = GET /channels/{id}/sync?since_seq=synced_seq&limit=200
        upsert(r.messages)                             # deleted: true はローカルから削除
        synced_seq = r.next_since_seq
        if not r.has_more: break
```

タイムラインの範囲: チャンネルごとに `oldest_loaded_seq` (最新ページと「以前を読み込む」で連続して
読み込んだ最も古い seq。全部読んだら 0) を持つ。タイムラインは `seq >= oldest_loaded_seq` の行だけを並べ、
「以前を読み込む」は `before_seq = oldest_loaded_seq` で取る。差分・イベント・API 応答で範囲外の古い行
(スレッドの親の更新、古いメッセージへのリアクションなど) が届いても保存はしてよいが、タイムラインには
出さず、ページングの基準にもしない (出すと間に穴が空き、その穴は二度と埋まらない)。

大きく遅れている場合の打ち切り: `channel.last_seq - synced_seq > 5000` なら差分を追わず、ローカルの
メッセージを捨てて `synced_seq = null` として最新ページから読み直す。長期間オフラインだった端末が
数千件の差分を引く無駄を避けるため。

### 7.4 ライブ (WS 接続中) のイベント処理

seq を消費するイベント (`message.*`) を受け取った時:

```
if channel.synced_seq is null:
    # ローカルにタイムラインが無い。チャンネル一覧の情報だけ更新する
    channel.last_seq = event.seq
    if type == message.created and 未読に数える行 (§10.1 12.): unread_count += 1 (+ mention_count)
elif event.seq == synced_seq + 1:
    upsert(event.data.message)
    synced_seq = event.seq
    channel.last_seq = event.seq
    (未読カウンタを同様に更新)
elif event.seq > synced_seq + 1:
    # ギャップ。イベントを取りこぼした
    catch_up(channel)                                  # この差分取得で synced_seq が event.seq 以上になる
else:
    # event.seq <= synced_seq: 既に反映済み。無視
```

`upsert` は §8 のマージ規則に従うので、ギャップ検知中に届いたイベントを先に適用しても壊れない。

- `synced_seq` が null のチャンネルでも、すでにローカルにある行 (開いているスレッドの返信・その親) に関わる
  イベントは upsert する (スレッド一覧から開いたスレッドに新しい返信が出るように)。
- トップレベルの `message.created` で `channel.last_message_at` を進める (DM 一覧の並び順)。
- `message.*` は DM 一覧のプレビュー (`last_message`) も動かす。`synced_seq` が null の会話でも (§7.8)。
- 「自分宛て」(mention_count を足す、`level = mentions` でも通知する) は `mention_all`、`mentioned_user_ids` に
  自分がいる、または本文に自分の `notify_keywords` のどれかが含まれる (大文字小文字を区別しない部分一致) 場合。
  サーバはキーワードの一致を他のメンバーに見せないため `messages.keyword_user_ids` に分けて持ち、イベントには
  含めない (M16a)。クライアントは bootstrap の `me.notify_keywords` で同じ判定をする。

未読数と取りこぼしのイベント (M28e、3 端末共通): 未読数はブートストラップの値に、ライブで受けたイベントの分を足したもの
で、`last_seq` までを数えている。イベントの seq に飛びがあって §7.3 の差分同期を行ったときは、差分が持ってきた行のうち
それまで数えていた seq (差分の前の `last_seq`) より後で新しい `synced_seq` までのもの (飛びを見せたそのイベントの行も
含む) を、その場で未読に数える (同じ行が 2 ページにまたがっても 1 回)。取りこぼした行の分は誰も読まなければ
`read.updated` が来ないので、こうしないと次のブートストラップまで数が合わなかった。再接続のブートストラップ後の差分同期は
何も数えない (ブートストラップの値がすべてを含む)。

### 7.5 再接続

```
1. WS 切断を検知 → 指数バックオフで再接続
2. 接続成功 (hello) 後は起動時 (§7.2) と同じ: イベントをバッファ → bootstrap → バッファ適用
3. 表示中のチャンネルを catch_up。他は開いた時
4. 未送信キュー (§9) の送信を再開
```

切断中の変更はすべて `updated_seq` で拾えるため、切断時刻を記録する必要はない。

接続状態の帯 (「サーバに接続しています…」「オフラインです。再接続を待っています…」) は、接続中・オフラインが
**2 秒続いたときだけ**出す (3 端末共通)。起動や前面への復帰のたびの短い再接続で帯が一瞬出て画面が上下に
ずれないようにするため。一度出た帯は状態に合わせて文言を変え、接続できたら消す (2026-09-27、利用者の指摘)。

### 7.6 チャンネル一覧の変化

`channel.*` イベントはデータを伴うのでそのまま反映する。取りこぼしは次回 bootstrap で回復する。
`channel.member_removed` が自分宛てなら、そのチャンネルのローカルデータを削除する。
`channel.created` は受け手ごとの membership を持たない。DM でなく、`member_ids` に自分が入り、`created_by` が自分で、
手元に membership が無いときは、role owner (`joined_at` はチャンネルの `created_at`) として持つ (M32。別の端末で作った
チャンネルで、次の bootstrap までオーナーの操作が出なかった)。

### 7.6.1 参加前のプレビュー (M27)

公開チャンネルは参加する前に中を見られる (Slack)。ゲスト以外は未参加でも履歴・スレッドの返信・単体のメッセージを読める
(SECURITY.md §3.2)。

- チャンネルを探す画面・チャンネルへのリンク・移動（⌘K / ✏️）の候補から開くと、すぐには参加せず会話を読み取り専用で出す。
  下の入力欄の代わりに「#name に参加する」。参加すると通常の会話になる (`channel.member_added` / 参加の応答から §7.3)。
- イベントはメンバーにしか届かないので、プレビューは開いた時の `GET /channels/{id}/messages` の結果 (上へのスクロールで前のページ)。
  カーソル・既読位置・未読は持たず、既読も送らない。ローカルの永続キャッシュ (SQLite / スナップショット) にも書かない。
  閉じるか別の会話を開いたら捨てる。
- 行のタップでスレッドを開けるが返信欄は無い。リアクション・投票・確認・長押しの操作は出さない (サーバも 403)。
- M88: 管理者が「参加前にチャンネルの中を見られる」(`workspace_settings.preview_before_join`) を切ると、サーバは未参加の
  公開チャンネルの読み取りを `403 preview_disabled` で断る。クライアントは設定がオフなら履歴を取りに行かず、見出しと
  「参加するとメッセージを読めます」(説明・人数・「参加」) を出す。403 が返った時も同じ表示 (docs/MEMBERSHIP.md §3〜§5)。

### 7.7 保持件数の上限 (M22)

端末がメモリとローカルストアに持つメッセージは、チャンネルごとに最新 **500 件**まで (3 端末共通)。持つ件数に比例して
起動・描画・メモリが重くなるため (2026-09-28 の評価。上限が無いと研究室の利用で 1〜3 年に数万件)。

- 数えるのは seq の付いた行 (返信、タイムラインの範囲外に届いた古い行も含む)。送信待ちの行 (seq なし) は数えず、
  削らない。
- **古い側からだけ削る**。新しい側を削ると差分 (§7.3) で埋め直せない。削った中で最も新しい seq を d として、
  `oldest_loaded_seq` が d 以下なら d + 1 にし、`has_older = true`。`synced_seq` は変えない。ローカルストアからも消す。
- 削る時:
  1. 起動時、ローカルストアを読んだとき。
  2. 会話を離れたとき (別の会話を開いたとき)、離れた会話を。
  3. 誰も見ていないチャンネルにライブで行が届き、上限を **100 件**超えたとき (1 行ごとには削らない)。
- 開いている会話と、開いているスレッドのチャンネルは削らない (§10.1 9.。スレッドの古い返信も消えるため)。スレッドを
  閉じた時点でそのチャンネルが開いていなければ削る。
- 削る処理は同期の直列キューの中で行う。先に読み込み中だった「以前を読み込む」のページが削った後に着くと、
  範囲 (§7.3) に穴が空くため。キューの順番が来た時点でその会話がまた開かれていれば削らない。
- 削ったチャンネルのスレッドは「全部の返信を持っている」(§10.2) 扱いをやめる。次に開いたときに返信を取り直す。
- 上へ遡ると `before_seq = oldest_loaded_seq` でサーバから取り直す (1 ページ約 10 ms)。オフラインで読めるのは各
  チャンネルの最新 500 件。

### 7.8 会話の最後のメッセージ (M49、DM 一覧のプレビュー)

`ChannelOut.last_message = {id, sender_id, type, seq, excerpt, has_attachments, created_at} | null`。
新しいイベントの種類は足さない。サーバの値を起点に、クライアントが既存の `message.*` から保つ。

- **サーバが入れる所**: 会員への応答だけ。bootstrap、`GET /channels` (自分の行)、`GET /channels/{id}` (会員のとき)、
  既存の DM を返す `POST /dms`。ここでの null は「メッセージが無い」。
- **入れない所**: それ以外の応答 (PATCH・join・archive …)、`channel.*` イベント (非会員にも届く、M15b)、非会員への
  公開チャンネル (参加前のプレビュー M27 でも)。ここでは常に null で、「何も言っていない」の意味。クライアントは
  持っている値を残す。
- **対象**: トップレベルと `also_in_channel` の返信。スレッドだけの返信と削除済みは数えない。
- **excerpt**: プッシュの本文と同じ規則。本文を 1 行にし (メンションは表示名、知らない人は「@メンバー」、
  知らないグループは「@グループ」。軽い Markdown を外し、改行をつなぐ)、140 文字まで (140 文字目を「…」)。本文が
  無ければ添付の言い方 (「画像を送信しました」「ファイルを 2 件送信しました」…)。guest には見えない人の名前は
  「@メンバー」(M13e)。検証ケースは `apps/shared/dm-preview.json`。
- **先頭 (クライアント)**: 無い・excerpt が空なら何も出さない。system メッセージはそのまま。自分のものは「あなた: 」
  (自分だけの DM では付けない)。1:1 DM の相手のものはそのまま (行に名前があるため。Slack と同じ)。グループ DM と
  チャンネルは「<表示名>: 」(知らない人は「メンバー: 」)。

クライアントでの更新 (3 端末共通):

```
on message.created / message.updated / message.deleted / 差分・履歴・自分の応答で届いた行 (m):
    if m がタイムラインの行でない (スレッドだけ・送信待ち) or 会員でない: 何もしない
    cur = channel.last_message
    if m.deleted:
        if cur.id != m.id: 何もしない
        タイムラインを持っていれば (synced_seq != null) その中で m.seq より前の最新の生きた行 → last_message
        無ければ last_message = null。さらに synced_seq が null か has_older なら GET /channels/{id} で取り直す
    elif cur is null or cur.id == m.id or m.seq > cur.seq:
        last_message = m から作る (同じ excerpt の規則)
```

- **`synced_seq` が null の会話でも更新する** (DM 一覧は開いていない会話ばかり)。
- 取り直しの応答より新しいもの (その間に届いたイベント) が手元にあれば、それを残す。
- 取りこぼしは再接続の bootstrap で直る (bootstrap の値で置き換える。null も含む)。
- 編集は seq を変えないので、最後の行の編集は本文だけ差し替わる。リアクションだけの `message.updated` では変わらない。

### 7.9 閉じた DM (M141、「会話を閉じる」)

DATA_MODEL.md conversation_closes。3 端末共通の規則:

```
状態: closed_dms (集合)。bootstrap の値で置き換える (再接続のたび。取りこぼしはここで直る)
on dm_close.updated {channel_id, closed, closed_seq}: closed なら足し、そうでなければ取り除く。ただし closed で、
    closed_seq があり、手元の last_message (§7.8) の seq が closed_seq より大きいときは何もしない (その新しい行で
    サーバでも開いている。この端末に先に届いただけ。Review v0.1.43 #6)
on message.created (m): m がタイムラインの行 (parent_id が無いか also_in_channel) で、m.channel_id が closed_dms に
    あれば取り除く (API は呼ばない。サーバも同じ規則で開いたとみなす)
閉じる (DM の行のメニュー・会話の見出しの「…」): その場で closed_dms に足し、dm_pins から外し、未読を 0 にする
    → PUT /channels/{id}/close。失敗したら、この操作が変えたものだけを戻してエラーを出す (Review v0.1.43 #7):
      - closed_dms から取り除く
      - 固定していたなら、その会話だけを閉じる前の位置へ戻す (今の一覧で範囲に収める)。待つ間に他の端末で変わった
        ほかの固定はそのまま
      - 既読はサーバに聞き直す (PUT /channels/{id}/read {last_read_seq: 0}。何も動かさず今の状態を返す) 値をそのまま
        取る (下がることもある)。聞き直しも失敗したら、閉じたときに置いた値 (last_seq・last_read_seq・未読数・
        メンション数) から何も変わっていないときだけ閉じる前の値を書き戻し、変わっていれば (新着・他端末の既読) その
        まま次の bootstrap に任せる
    開いている会話を閉じたら、Desktop / Web はホームへ、スマホは一覧へ戻る
開く (検索・ジャンプ・プロフィールの「メッセージを送る」・リンク・通知・Desktop の「元に戻す」で、closed_dms にある
    会話を開いた): その場で取り除き DELETE /channels/{id}/close (失敗はログだけ。次の bootstrap で閉じた状態に戻る)
```

- 隠す所: サイドバーのすべての場所 (お気に入り・自分のセクション・「ダイレクトメッセージ」)、スマホの DM タブと
  ホームの「ダイレクトメッセージ」、iPad / タブレットの一覧、Alt+↑/↓ の移動。自分だけの DM が閉じているときは、まだ
  無いときの仮の行も出さない。隠さない所: 検索、ジャンプ (⌘K)、メンバー・プロフィール、通知、アクティビティ。
- 閉じた会話は既読になっており、新しいメッセージが来れば開くので、バッジの数え方は変えない。
- サーバは閉じる位置をメッセージの採番と同じチャンネル行のロックの中で読み、コミットまで持つ (Review v0.1.43 #6)。
  閉じる前にコミットされたメッセージは閉じた位置の内側 (既読) に入り、閉じる間に送られたメッセージは待ってからその
  後の seq を取るので会話を開き、その `message.created` は `dm_close.updated` の後に届く。
- 上の規則 (閉じたを取るか、固定の戻し方、既読の書き戻し) の例は `apps/shared/dm-close-rules.json` にあり、3 端末とも
  これでテストする。
- Desktop / Web は閉じたあと「会話を閉じました」と「元に戻す」を数秒出す。元に戻すと開き (DELETE)、固定していた
  なら固定し直す (固定の最後に付く)。既読は戻さない。

## 8. マージ規則

```
upsert(m):
    local = store.get(m.id)
    if local is None or m.updated_seq > local.updated_seq:
        if m.deleted: store.delete(m.id)  (トゥームストーン表示をする場合は deleted フラグ付きで保存)
        else:         store.put(m)        # reactions / attachments も m の内容で置き換える
    # m.updated_seq <= local.updated_seq なら何もしない (古い or 重複)

apply read.updated(e):
    ch = store.channel(e.channel_id)
    ch.last_read_seq = max(ch.last_read_seq, e.last_read_seq)
    ch.unread_count  = e.unread_count      # サーバが数えた値で置き換える
    ch.mention_count = e.mention_count
    ch.first_unread_at = e.first_unread_at # 未読数と一緒に置き換える (§10.1)
```

同じ `updated_seq` のメッセージが 2 回来た場合は 2 回目を無視してよい (内容は同じ)。

例外は投票の `poll.mine` (M27、DATA_MODEL.md「投票」): 本人宛ての応答にだけ入り、イベントでは null。

```
merge poll.mine (upsert の後):
    if m.poll and m.poll.mine is None and local and local.poll:
        stored.poll.mine = local.poll.mine          # イベントは前に知っていた自分の票を消さない
    if local and m.updated_seq == local.updated_seq and m.poll and m.poll.mine is not None:
        local.poll.mine = m.poll.mine               # 投票の応答がイベントより後に着いても自分の票は入る
```

自分の投票・取り消し・締め切りの応答は、上のマージの後に `updated_seq` に関係なく `mine` を入れる (setMyVotes)。
他のメンバーの投票のイベント (より新しい `updated_seq`) が応答より先に着くと、応答はマージで捨てられるため。

日程調整 (M53、SCHEDULING.md) の `poll.my_answers` と `poll.my_comment` も `mine` と同じ扱い (本人宛ての応答だけ、
イベントでは null、null なら前の値を保ち、自分の回答・決定・取り消しの応答は setMyVotes で入れる)。記名の日程調整では
クライアントは自分の回答とコメントを `answers` / `comments` から導く (`votes` と同じ理由)。回答・コメント・決定・取り消しは
どれも `message.updated` (`change = poll`) で、決定はそのあとにスレッドの返信の `message.created` (親の `parent_thread` 付き)
と、チャンネルのカレンダーの `calendar.event.updated` (CALENDAR.md §5) が続く。

### 下書きの同期 (M15d)

下書きは入力欄 (`channel_id` + `parent_id`) ごとに端末に置き、本文だけをサーバと共有する。
端末の未送信の編集を他の端末の古い版で消さないため、各下書きに 2 つの状態を持つ:

- `dirty`: この端末で編集してまだサーバに保存していない (サーバの版を知らない既存の下書きも dirty とみなす)
- `synced_at`: 最後にサーバと一致した時の `updated_at`

```
local edit(key, text):
    draft.text = text; draft.dirty = true
    入力が 1 秒止まったら push(key)          # 送信で空になった場合もすぐ push

push(key):                                   # オンラインのときだけ。失敗したら dirty のまま再接続後に再送
    text が空 → DELETE /drafts?channel_id=&parent_id=   (成功で dirty=false)
    それ以外 → PUT /drafts {channel_id, parent_id, body} (成功で dirty=false, synced_at=応答の updated_at)
    403 / 404 / 422 (会話を抜けた、親が消えた等) → dirty=false にして手元の本文は残す

apply draft.updated(e) / bootstrap の drafts:
    local = drafts[key]
    if local.dirty: 無視 (この端末の編集が勝つ。次の push でサーバも置き換わる)
    elif e.deleted: 本文を空に (添付は端末のものなので残す)
    else: 本文 = e.body; synced_at = e.updated_at
bootstrap の後:
    サーバに無く、dirty でもなく synced_at を持つ下書き → 他の端末で送信 / 削除された。本文を空に
    dirty な下書き → push
```

## 9. 送信の冪等性と楽観的 UI

```
send(channel, body):
    client_msg_id = uuid4()
    store.outbox.add({client_msg_id, channel, body, attachment_ids, created_at})
    store.messages.put(pending message: id = "local:" + client_msg_id, seq = null)   # 末尾に仮表示
    flush_outbox()

flush_outbox():                                   # 直列。1 件ずつ順に送る
    if flushing: again = true; return             # 送信中に積まれた分は、今のループが終わった後に続けて送る
    flushing = true
    loop:
        item = 次の未送信 (failed でない) 項目を outbox から読み直す。無ければ終わり
        r = POST /channels/{id}/messages (item)
        if 2xx:  reconcile(item.client_msg_id, r.message); outbox.remove(item)
        elif 401 token_expired: refresh して 1 回だけ再試行
        elif 4xx (429 以外): failed として保存 (再起動後も「送信に失敗」のまま)。次の項目へ
        else (429 / 5xx / network / timeout / HTML のエラーページ): 中断し、接続中ならバックオフ
             (2s, 4s, ... 最大 30s) のタイマーで再開。再接続後にも再開
    flushing = false; if again: flush_outbox()

reconcile(client_msg_id, message):
    仮メッセージ ("local:..." ) を message で置き換える (seq が付く)
```

エラーの分類と扱いは ARCHITECTURE.md §9 に従う。再送は同じ `client_msg_id` なので重複しない。

- WS の `message.created` が REST 応答より先に届くことがある。`data.message.client_msg_id` が自分の
  outbox にあれば同じ手順で reconcile する。後から来た REST 応答は同じ `updated_seq` なので無視される。
- 仮メッセージは `seq` が無いので、並び順は「確定メッセージの後、作成時刻順」で表示する。
- 添付付き送信: 先に `POST /attachments` で id を得てから本文を送る。添付アップロードの再送は
  新しい id になる (アップロード自体は冪等にしない。未使用の id は 24 時間で GC)。

## 10. 既読の複数端末同期

- 接続中かつアプリが前面にある通常の会話画面で、表示できたメッセージの最大 `seq` を
  `PUT /channels/{id}/read` で送る。画面より高いメッセージは表示部分をもって閲覧とする。
  連打を避けるため 1 秒デバウンスする。チャンネルを開いただけでは `last_seq` を既読にしない。
  送るのは未読の行がすべて読み込まれていて、最初の未読行が画面に出た後に限る (§10.1)。
- 検索結果から開いた前後の会話は独立した表示ウィンドウであり、既読位置を進めない。
  通常の会話へ戻ると表示範囲に基づく更新を再開する。
  そのウィンドウの最新行がクライアントの読み込み済み範囲（`oldestLoadedSeq` から最新まで）に届いていれば、
  ウィンドウは最新の会話とつながる。以降に届いた行も末尾に並び、末尾にいれば通常どおり追従する。
  「最新の会話に戻る」は、つながっていない（新しい行が未読み込み）間か、末尾から離れている間だけ出す
  （Desktop / Web、`ui/focusWindow.ts`、2026-10-07）。既読位置を進めないのは変わらない。
- 送信前にローカルの `last_read_seq` を先に進めて表示を更新してよい (楽観的)。サーバは単調増加で
  マージするので矛盾しない。
- bootstrap の `read_state` は正 (max マージしない)。送れなかった既読 (PUT の失敗、デバウンス中の終了) は
  覚えておき、再接続後に送り直す。こうしないと手元だけ進んだ位置が「既読にできない未読」を残す。
- スレッドの返信を送っても、チャンネルの既読位置は進めない (サーバもトップレベルの投稿だけで進める)。
  返信はスレッドの既読位置を進める (THREADS.md)。
- 「ここから未読にする」は `PUT /channels/{id}/read` に `mode: "set"` を付けて送る。サーバは位置を
  そのまま (`last_seq` で clamp して) 設定し、未読数を再計算して `read.updated` を配る。他端末はこの
  イベントの値で位置を下げる。操作した端末は、その会話を離れるまで表示範囲による既読更新を止める
  (Mattermost と同じ)。既定の `advance` は従来どおり単調。位置を前へ進める使い方は、未読の行がすべて読み込まれて
  いる時だけ (§10.1 10.)。
- `read.updated` には `reason` (`advance` / `set`) が入る。`advance` はクライアント側で max マージする
  (古い PUT のイベントが、その後に進めたローカル位置より遅れて届くことがあるため)。`set` だけが位置を
  下げる。未読数はどちらもサーバの値で置き換える。
- 他端末には `read.updated` が届く。バッジや未読数はその値で置き換える。
- 自分が送信したメッセージは、サーバが送信トランザクション内で既読にする (予約送信 (M12d) は除く)。
  クライアントは自分の `message.created` で `unread_count` を増やさない。手元の既読位置は、この端末の送信の応答で
  進める (自分の `message.created` では動かさない、§10.1 11.)。
- 既読位置を端末別に持つ要件は現時点では無い (DATA_MODEL.md §6)。

### 10.5 静かな未読 (M24、times)

会話ごとの「未読あり」(太字、未読フィルタ、未読の会話への移動、ワークスペースの未読の点) とバッジの数は、サーバの
`GET /sync/summary` と 3 端末で同じ規則で決める。検証ベクトルは `apps/shared/unread-rules.json` (サーバと 3 端末の
テストが同じファイルを読む)。

```
muted(c)      = level == "none" or muted or muted_until > now   -- level はチャンネル自身の値 (全体設定は入れない)。muted は M35
quiet(c)      = c.times_owner_id != null and c.times_owner_id != me and level != "all" and not muted(c)
has_unread(c) = member and (muted(c) or quiet(c) ? mention_count > 0 : unread_count > 0)
badge(c)      = muted(c) ? mention_count : (DM ? unread_count : mention_count)
```

- 通知の全体設定 (M35、`users.notification_default`) はプッシュだけに効き、未読の規則には入らない (全体を「なし」に
  しても会話が全部ミュート扱いにならないように)。規則の `level` はチャンネル自身の値 (無ければ null)。
- 静かな未読の会話は、メンションが無ければ太字にしない。未読があることは名前の横の控えめな点で示す (ミュートは
  何も示さない、という違い)。プッシュはチャンネルの既定 (`mentions`) どおりメンションのときだけ。
- 通知レベルを `all` にすると普通のチャンネルと同じになる (太字、全件のプッシュ)。

### 10.1 最初の未読が読み込まれていないとき (M17)

最新ページ (50 件) より未読が多い会話は、開いても最初の未読が手元に無いことがある (その端末で初めて開く、
ブラウザ版の再読み込み、§7.3 の読み直し、保持件数の上限 (§7.7) で古い側が削られた会話)。この状態で表示範囲から
既読を送ると、見ていない未読を飛び越えて既読位置が進み、それが全端末に同期される (2026-09-28 の調査では
未読 2,007 件のチャンネル `#big` が、開いただけで約 40 件になった)。3 端末とも次の規則に従う。

```
covers(m)        = oldest_loaded_seq == 0
                   or (oldest_loaded_seq != null and oldest_loaded_seq <= m + 1)
                   # seq が m より大きいタイムラインの行が、古い側はすべて手元にある (§7.3 の連続範囲)
caught_up        = synced_seq != null and synced_seq >= last_seq
                   # 新しい側もすべて手元にある。bootstrap が last_seq を上げてから catch_up が終わるまで
                   # (再接続、再起動、追いついていない会話を開いた) は、未読の行がまだ届いていない
read_range_ready = unread_count == 0 or (covers(last_read_seq) and caught_up)
最初の未読行     = 読み込み済みのタイムラインで seq > last_read_seq かつ送信者が自分でない最初の行
                   (type は問わない。システム行でもよい)
```

行の seq は返信などで飛ぶので `covers` は保守的に働く (最初の未読が手元にあっても false のことがある。
そのときは「最初の未読へ」が 1 ページ多く読むだけ)。`caught_up` を欠くと、差分が届く前の手元に最初の未読行が
無いことを「未読行が無い」と取り違えて anchored になり、差分が届いて最下部へ追従した後の行で既読を送って、
見ていない未読を飛び越える (2026-09-28、再接続・再起動の後に 131..415 を飛び越えた)。

1. **エンジン**: 表示範囲による既読 (force なしの markRead) は `read_range_ready` が false の間は何もしない
   (ローカルの位置も動かさず、PUT も送らない)。明示的な操作 (Esc、バナーの「既読にする」、この端末からの
   トップレベル投稿 (11.)、「すべて既読にする」) はこれまでどおり効く。
2. **起点の確認 (anchored)**: 会話の画面ごとに持つ。表示範囲による既読は anchored の間だけ送る。範囲が揃っても、
   画面より上に読み込まれただけの未読 (手で上へ遡った直後、他端末が既読を動かした後、追いつきや読み直しで行が
   埋まった後) を飛び越えないため。
   - **true になる**: `unread_count == 0`、または `read_range_ready` の状態で最初の未読行が画面に出た (既読と同じ
     「表示できた」の基準)、または `read_range_ready` なのに最初の未読行が無い。
   - **false にする** (次のいずれか):
     1. 開いた時、検索位置の表示から戻った時、§7.3 の読み直しでその会話の行が入れ替わった時 (読み直しの間に
        評価の機会が無かった場合も。例えばバックグラウンドで読み直した)。
     2. `read_range_ready` が false になった時。
     3. `last_read_seq` が下がった時 (他端末の「ここから未読にする」の `read.updated (set)`、手元より低い
        bootstrap の値) と、「ここから未読にする」の保留が既読なしに解けた時 (別の会話を開いた。iOS では検索の
        シートから開いても解ける)。**この変化で起きた評価では、最初の未読行が画面にあっても既読を送らない**
        (他端末が未読に戻した位置を、その前から画面にあった行で打ち消さないため)。次の表示の変化 (スクロール、
        行の追加や高さの変化、前面への復帰、接続の回復) からは通常どおり。
     4. **見ずに通り過ぎた**: anchored の評価のたびに、最初の未読行が画面より上 (表示できた行のどれよりも seq が
        小さい) にあって一部も画面に出ていなければ false にする (その評価では送らない)。見ていない間 (別アプリ、
        スレッドの画面、会話の「ピン留め」「ファイル」のタブ (M29)、オフライン) に届いた行へ最下部が追従した、追いつき・読み直しで行が埋まった、
        「新着 N 件」や速いスクロールで一画面以上飛んだ、位置合わせがずれた、のどれも、画面の行より上に一度も
        出ていない未読が残る。一部でも画面にあれば読み進めている途中なので落とさない。表示できた行が無い評価
        (画面を見ていない) では判定しない。最下部にいる時に届いた行へ追従するかは端末の既定どおりでよい
        (Desktop は、追従すると最初の未読行が画面より上に出てしまう時は代わりにその行を上端に置く。どちらでも
        この規則が守る)。
   - 判定に使う行とチャンネル状態は同じ時点のものにする (ストアの最新どうし、または描画に使ったスナップショット
     どうし)。描画前の古い行の先頭を最初の未読行と取り違えると、その上に読み込まれた行を飛び越える。
   - 位置合わせのスクロール (4.、6.) が着地するまでは、anchored の判定も既読もしない (画面の枠がまだ前の位置を
     表しているため)。
3. **「新着メッセージ」の区切り**: 位置は従来どおり開いた時の既読位置 `mark` (「ここから未読にする」の保留中は
   その位置) に固定し、`covers(mark)` のときだけ描く。範囲が届いていないのに読み込み済みの先頭に描くと嘘になる。
4. **開いた時の位置** (開いた時と、検索位置の表示から戻った時。戻った時も開いた時と同じく `mark` を
   その時の `last_read_seq` (`unread_count == 0` なら null) で取り直す):
   - 検索結果・パーマリンクはその行を中央。
   - 区切りを描けるなら、**区切り「新着メッセージ」を画面の上端** (ナビゲーションバーなどに隠れない位置) に置き、
     その直下に最初の未読行を出す (行を上端に置くと区切りが画面の外に出る)。
   - それ以外は最下部 (最新)。区切りを描けないのに読み込み済みの先頭へ移ると、「以前を読み込む」が続けて走る。
   - **追いつき中** (接続中またはオンラインで `caught_up` でない) に開いた会話は、位置合わせを追いつくまで待つ
     (最初の未読行がその差分で届くため)。待つのは最大 3 秒で、その前に利用者が自分でスクロールしたら位置合わせは
     しない (その場に置く)。オフラインなら待たない。手元の行を先に最下部に出しておき、差分が届いた時にこの規則で
     置き直してもよい (Desktop)。
   - 区切りへの位置合わせは**着地**として扱う: スクロールを始めてから着地するまで、バナーを隠し、anchored の判定も
     既読もしない。遅延描画のリスト (iOS の LazyVStack) は推定の高さで位置がずれるので、目的の行が画面に出るまで
     数回 (3 回) まで置き直す。着地したら anchored にしてよい (ずれて最初の未読行が画面より上に残れば 2. の 4 で
     落ちる。着地後に実際の表示で判定してもよい)。
   - **着地した位置を保つ** (2026-10-01、開いた直後に位置が大きく飛ぶ報告): リンクカード・写真・動画は行が描かれた
     後に届いて高さが変わる。画面より上の行が伸びても、画面の一番上の行 (着地なら最初の未読行) は画面上の位置を
     変えない。最下部にいる間は、読み手が上へスクロールするまで最下部に留まる (伸びている最中のスクロールイベントを
     読み手が離れたと取らない)。写真はサーバの幅・高さから最終の大きさを先に確保する。WebKit (macOS アプリ、
     Safari) には CSS の scroll anchoring が無いので、端末側で行う (Desktop: `scrollAnchor.ts`、Chromium の
     anchoring はこのリストでは切って同じ仕組みにそろえる。スレッドの画面 (§10.2) とプレビューも同じ `ListAnchor`)。
5. **未読バナー**: 通常の会話 (検索位置の表示でない) で位置合わせの後、`unread_count > 0` かつ anchored でなく、
   「ここから未読にする」の保留も着地中のスクロールも無く、「追いつき中で最初の未読行がまだ手元に無い」(接続中
   またはオンラインで `caught_up` でなく、最初の未読行が無い) でもないときに出す (最後の条件は、再接続のたびの
   追いつきでバナーが一瞬出ないため)。
   - 置き場所はスクロールする内容の外 (リストの上の帯)。内容の中に置くと、消えた時に行が上へずれ、上端に置いた
     最初の未読行が画面の外に出る (WebKit にはスクロールアンカーが無い)。帯の高さが変わっても、最下部にいた
     読み手は最下部のままにする。
   - 文言は「未読 {n} 件 · {since} 以降」。n は `unread_count` (サーバが数えた値) を 3 桁ごとに半角カンマで区切る
     (「未読 2,000 件」)。since は `first_unread_at` を端末の時刻で表し、今日は「10:23」、昨日は「昨日 10:23」、
     それより前は日付の区切りと同じ表記に時刻を足す (2026-09-28 に見ると「9月26日 (土) 10:23」、「2025年12月31日 (水) 10:23」)。
     時刻は 24 時間表記の 2 桁。`first_unread_at` が null (古いサーバ) なら「未読 {n} 件」だけ。
   - 「最初の未読へ」: `read_range_ready` のとき、または n <= 500 のときに出す (6.)。
   - 「既読にする」: 常に出す。`markRead(last_seq, force)` を送る (Esc と同じ。未読が 0 になりバナーは消える)。
   - オフラインの間は 2 つのボタンを無効にする。「最初の未読へ」の読み込みから着地まで、ボタンの代わりに
     「読み込み中…」を出す (途中でボタンが戻ると二度押しできてしまう)。
6. **「最初の未読へ」**:

   ```
   jump(channel):                                  # エンジンの直列キューで実行
       target = last_read_seq                      # 押した時点の値 (キューに入れる前に読む)
       pages = 0
       while not covers(target) and has_older and pages < 4 and online and この会話を表示中:
           r = GET /channels/{id}/messages?before_seq=oldest_loaded_seq&limit=200
           upsert(r.messages); oldest_loaded_seq と has_older は「以前を読み込む」と同じ規則で更新
           pages += 1
       if covers(target): mark = target; seenSeq = target; 区切りを上端へ着地させる (4.)
       else: バナーのまま (通信の失敗はいつものエラー表示。もう一度押すと続きから読む)
   ```

   - 後ろ向きに連続して読むので §7.3 の連続範囲がそのまま保たれ、ストアもページングも変えなくてよい。
     前向きのページ (`after_seq`) や `/messages/{id}/context` で最初の未読の周りだけを読むと、最新側から離れた
     2 つ目の範囲ができ、ストア・ページング・ライブ更新をすべて 2 範囲に対応させることになる。差分
     (`/sync?since_seq=last_read_seq`) は返信とトゥームストーンも運び、`updated_seq` 順なので最後のページまで
     読まないと範囲が連続しない。
   - 500 件の上限は端末が一度に持つ行数を抑えるため (iOS は M20 まで行数に比例して重い。M22 の保持件数と同程度)。
     超えるときは「既読にする」だけを出す。手で上へ遡ることはでき、最初の未読行が画面に出た時点で既読が進み始める。
   - 4 ページ (800 行) は安全弁 (システムメッセージなど未読に数えない行が多い場合)。
   - 一度に最大 800 行が加わっても、行ごとの付随リクエスト (リンクプレビューなど) は画面の近くに来た行だけが送る。
     保持する行をすべて描画する実装 (Desktop) は IntersectionObserver などで遅らせる (一斉に送るとサーバの
     レート制限 429 に当たり、そのセッションのプレビューが出なくなる)。
7. **「新着 N 件」(最下部へ移るボタン)** は、seenSeq より後の、他人の読み込み済みの行を数える。seenSeq は、区切りに
   位置合わせした時 (開いた時、「最初の未読へ」) は `mark`、最下部に位置合わせした時はその時の最大 seq。その後は
   位置合わせが済んでから最下部にいる間だけ最大 seq に進める (位置合わせ前のリストの初期位置 (最下部) で進めると、
   区切りから開いた時に 0 件になる)。4. により数える範囲はいつも全部手元にあるので本当の件数になる (範囲が届かない
   会話は最下部で開くので 0)。読み込んだ行だけで未読全体を数えて表示してはならない。
8. **`first_unread_at` の保持**: サーバの値 (bootstrap の `read_state`、PUT の応答、`read.updated`、read-all の応答)
   で `unread_count` と一緒に置き換える。ローカルで未読数を動かすときは、0 → 1 (ライブの未読。12. の行だけ) で
   そのメッセージの `created_at`、0 にしたら null、「ここから未読にする」では数え直した最初の行の `created_at`。
9. 保持件数を削る処理 (M22、§7.7) は、開いている会話では行わない。読み進めている途中で最初の未読が消えると、
   規則 1 で既読が止まるため。
10. **「ここから未読にする」と範囲**: 行 `seq` での操作は位置を `seq - 1` にする。前へ進める (`seq - 1 > last_read_seq`)
    のは `read_range_ready` のときだけ (間の未読行がすべて手元にある)。そうでなければその行のメニューに出さない
    (Desktop の Alt+クリックも効かない)。範囲が届かないまま進めると、読み込んでいない未読をまとめて既読にして
    全端末に配ってしまう (未読 2,000 件で読み込み済みの行 2990 に使うと 1001..2989 が既読になる)。エンジンも同じ
    条件で守る: 条件を満たさない呼び出しは位置を動かさず PUT も送らず、保留だけを `last_read_seq` に置く (表示範囲の
    既読を止める)。後ろへ戻す (`seq - 1 <= last_read_seq`) のは従来どおり範囲に関係なくできる (検索位置の表示でも)。
11. **自分の投稿**: 自分の投稿で手元の既読位置を進めるのは、この端末からのトップレベル投稿が成功した時
    (`POST` の 2xx、§9 の reconcile) だけ: `last_read_seq = max(現在, seq)`、未読 0、`first_unread_at` null、保留を
    解く (サーバが同じトランザクションで進めている)。自分の `message.created` イベントでは未読を数えないだけで、
    既読位置も保留も動かさない。他端末からの投稿はサーバが進めて `read.updated` が届き、予約送信 (M12d) はサーバも
    進めない。イベントで進めると、予約送信の後に手元だけ進んだ位置の先の行を読んだ時の PUT が、見ていない未読を
    飛び越える。返信 (`also_in_channel` を含む) はチャンネルの位置を動かさない (サーバも同じ)。
    タイムラインを最下部へ移すのも、この端末のトップレベル投稿 (仮表示の行が出た時) だけ。返信 (`also_in_channel` を
    含む)、他端末からの投稿、予約送信は、他人の行と同じく最下部にいた時の追従に従う (返信で最下部へ飛ぶと、途中の
    未読を飛び越える)。
    アンケート (M14b) はアウトボックスを通らず専用の送信で作るが、この端末のトップレベル投稿として同じに扱う: 応答
    (2xx) で既読位置を進め、タイムラインを最下部へ移す (応答とイベントのどちらが先に届いても)。以前は他端末からの
    投稿と同じ扱いで、途中を読んでいるとアンケートが画面に出なかった (テスター、2026-09-29)。
12. **ローカルで数える未読**: ライブの `message.created` で `unread_count` に 1 足すのは、サーバが数える行 (§4.1 の
    `first_unread_at` と同じ条件) だけ: 他人の、`type == "user"` の、タイムラインの行 (トップレベルか
    `also_in_channel`) で `seq > last_read_seq`。システム行を数えると、次にサーバの値が届くまで未読数とバナーの
    「… 以降」がサーバとずれる。

### 10.2 スレッドの既読 (M17)

スレッドにも同じ問題がある。手元の返信は一部 (ライブで届いた新しい返信だけ) のことがあり、
`GET /messages/{id}/replies` (スレッド全体を返す) が終わる前に見えた返信で既読を送ると、読み込まれていない
古い未読返信を飛び越える。最下部で開いて最大 seq を送ると、画面より上の未読返信を飛び越える。

- エンジンはスレッドごとに「全体を取得済み」をメモリに持つ。replies の取得が成功したら立て、そのチャンネルの
  ローカルのメッセージを消した時に下ろす: §7.3 の読み直し、チャンネルを手元から消すすべての経路 (除外の
  `channel.member_removed`、自分で抜けた時、公開チャンネルの一覧から消えた時、非公開化、bootstrap に無い)、
  サインアウト。取得済みでないスレッドへの表示範囲による既読 (markThreadRead) は何もしない。一度取得すれば、
  欠けるのは切断中に届いた新しい返信だけで、それは見えている最大 seq より大きいので飛び越えない。
- 開いているスレッドの「全体を取得済み」が下りたら (オンラインのまま §7.3 の読み直しがあった)、その画面は replies
  を取り直す (接続状態が変わるのを待たない。待つと空のまま既読も進まない)。
- 最初の未読返信 = `seq > ThreadState.last_read_seq` かつ他人の最初の返信。anchored はチャンネルと同じ規則 (§10.1 2.
  の true になる条件、false にする 1・2・4、着地) で、`read_range_ready` の代わりに「全体を取得済みで
  `ThreadState` を持っている」を使う (画面を開いた時と、それが満たされない間は false。満たされた状態で最初の未読返信が
  画面に出るか、それが無いと true)。既読は anchored の間だけ送る。取得前の一部の返信だけを見て「未読返信が無い」と
  判断しないため。
- 開いた時の位置: 検索結果・パーマリンクはその返信を中央。最初の未読返信があれば「新しい返信」の区切りとその返信を
  上端 (区切りも画面に出す。着地で anchored)。それ以外は最下部。位置合わせは返信と `ThreadState` が揃った時に 1 回
  だけ行う。揃うまでは手元の行を最下部に出しておき、その間に利用者がスクロールしたら位置合わせは省く。「利用者が
  スクロールした」は利用者の入力 (ドラッグ、ホイール、キー、スクロールバー、iOS 18 の scroll phase) で判定し、
  キーボードの表示や上への返信の挿入などで最下部から離れたことは数えない (数えると位置合わせが省かれ、最初の未読
  返信が見えないまま既読が進まない)。着地した位置・最下部は §10.1 4. の「着地した位置を保つ」と同じ規則で保つ
  (親や上の返信の写真・リンクカードが後から伸びても最初の未読返信は画面上の位置を変えない。最下部にいる間は上へ
  スクロールするまで最下部に留まり、届いた返信にも追従する。全体の取得で手元の返信より上に返信が入っても、画面の
  一番上の行は動かない)。参加前のプレビュー (§7.6.1) の会話とスレッドも同じ。
- **最新の返信へのボタン** (テスター、2026-10-07：長いスレッドで古い返信を読んでいると最新へ戻る手段が無かった)：
  スレッドにも会話と同じ最下部へのボタンを出す。最下部から離れている間 (Desktop / Web は最下部から 240 px より上、
  Android は画面の一番下の行より下に 2 行より多くある時。会話の「最新のメッセージへ」と同じ基準) は「最新の返信へ」、
  他人の新しい返信が下にあれば「新しい返信 N 件」(Android は会話と同じ「新着 N 件」) を出す。数え方は §10.1 7. と
  同じで、seenSeq は位置合わせした時にスレッドの既読位置、その後は最下部にいる間だけ最大 seq に進める。古い返信を
  読んでいる間に他人の返信が届いても、画面の行は動かさずボタンが件数を出す (会話と同じ)。最下部で入力欄にフォーカスが
  あっても (キーボード表示中も) 届いた返信には追従し、自分の返信を送るとどこにいても最新の返信へ移る。どちらも
  1 フレームで移り、途中の行を流すアニメーションはしない (Desktop は scrollTop を直接、Android は
  requestScrollToItem / scrollToItem)。
- 一度も読んでいないスレッドは `last_read_seq` 0 (フォロー行が無い) なので、最初の他人の返信から開く。既読 API は
  `following=false` の行を作るので、一度読めば位置は残る (THREADS.md §3)。
- **スレッドの既読位置は下げない**: `thread.updated`、`GET /messages/{id}/thread`、`PUT .../thread/read` とフォロー変更の
  応答で `ThreadState` を置き換える時、`last_read_seq` はこの端末がそのスレッドで既に進めた値 (デバウンス中・送信待ちを
  含む) を下回らせない (max)。サーバでもスレッドの既読位置は単調で下がらない (THREADS.md §3)。デバウンス中の PUT より
  前の位置を運ぶ `reply` のイベントで下げると、開いているスレッドが最初の未読返信をまた画面より上に見つけて anchored を
  落とし、読んだ返信が未読に戻る。

### 10.3 行のキー

リストの行のキーは rowKey (`client_msg_id ?? id`。送信中の行が確定しても同じ行のまま残るため)。メッセージ id から
行を探すとき (位置合わせ、表示された行から seq を引く、最初の未読行が画面にあるかの判定) はメッセージを経由し、
id と rowKey を直接比べない。確定した行は `client_msg_id ≠ id` なので一致しない (Android で開いた時の位置合わせと
スレッドの既読が効かなかった、2026-09-28)。

### 10.4 検証ベクトル (M17)

共通の前提 (行ごとに断りが無ければ): チャンネル C、alice のトップレベル投稿が seq ごとに 1 件 (欠番なし)、読み手は
bob、ページは 50 件、「初めて開く」は `synced_seq` が null (最新ページを読む)、PUT は 1 秒のデバウンス後の
`PUT /channels/C/read`、「表示 X..Y」は X..Y が「表示できた」の基準を満たす (フォーカスがあり前面にある)、「準備
できている」は `read_range_ready` が true。今は 2026-09-28 (月) 15:00 (端末の時刻)、`first_unread_at` は断りが
無ければ今日の 10:23。各端末はこの表の該当行をテストにする (ヘルパーの純関数、FakeServer のエンジンテスト、画面の
テストのうち持っているもの)。

V1〜V31 は M17 の最初の設計で決めたもの、V32 以降はその後の見直しで足したもの。後の規則で期待が変わった行は
現在の §10.1〜10.3 に合わせて書き、末尾の括弧に変更点を記す。

| # | 規則 | 入力 | 期待 |
| --- | --- | --- | --- |
| V1 | 3., 4., 7. | `last_seq` 130、last_read 100、未読 30、初めて開く | 最新ページ 81..130、`oldest_loaded_seq` 81 で準備できている (81 <= 101)。区切りを上端、101 をその直下に着地させて anchored、バナーなし。表示 101..115 で PUT 115。最下部にいない間の最下部へのボタンは「新着 30 件」(V40) (以前の「101 を上端」は 4. で区切りを上端に変更) |
| V2 | 1., 3., 4., 5., 7. | `last_seq` 3000、last_read 1000、未読 2000、初めて開く (M17 の受け入れ条件) | 最新ページ 2951..3000 で準備できていない。表示 2980..3000 の markRead(3000) は何もしない: 手元の last_read は 1000 のまま、PUT なし、サーバも 1000。区切りなし、最下部で開く。バナー「未読 2,000 件 · 10:23 以降」は「既読にする」だけ (2000 > 500)。上へスクロールした時の最下部へのボタンは「最新のメッセージへ」(N = 0) |
| V3 | 1., 5. | V2 の後に「既読にする」 | markRead(3000, force) が PUT `{last_read_seq: 3000}` を送る。サーバは未読 0、`first_unread_at` null。バナーは消えて anchored、区切りなし |
| V4 | 4., 5., 6. | `last_seq` 1300、last_read 1000、未読 300、初めて開いて「最初の未読へ」 | 最新ページ 1251..1300 (準備できていない)。GET `before_seq=1251&limit=200` で 1051..1250、GET `before_seq=1051&limit=200` で 851..1050、`oldest_loaded_seq` 851 で届く。リクエストはちょうど 2 回、手元は 450 行。押す前はバナー「未読 300 件 · 10:23 以降」に「最初の未読へ」と「既読にする」、読み込みから着地までは「読み込み中…」。着地後: mark 1000、区切りを上端、1001 をその直下、anchored、バナーは消える。表示 1001..1012 で PUT 1012 (以前の「1001 を上端」は 4. で区切りを上端に変更。着地までの扱いは V39) |
| V5 | 定義, 6. | seq 1..100 がトップレベル、101..103 が返信、104..153 がトップレベル。last_read 100、未読 50、初めて開く | 最新ページ 104..153 (has_more)。`covers(100)` は false (104 > 101) なので準備できていない。markRead(153) は何もしない。バナー「未読 50 件 · …」に 2 つのボタン。「最初の未読へ」は GET 1 回 (`before_seq=104`) で届き、区切り (104 の前) を上端へ着地させる |
| V6 | 2.-4, 3., 6. | V4 でボタンを押さずに上へスクロールし、「以前を読み込む」(50 件) が 5 回走って `oldest_loaded_seq` 1001 | 5 ページ目で準備できる (1001 <= 1001) が、1001 は画面より上 (画面は 1045..1060 付近) なので PUT なし。区切りは 1001 の前に出る。バナーは残り、「最初の未読へ」はリクエストなしで区切りを上端へ着地させるだけ。読み手が 1001 を画面に出すまでスクロールすれば anchored になり、PUT は表示の最大 |
| V7 | 2., 6. | V2 の状態で他端末が読む: `read.updated (advance)` last_read 2990、未読 10 | 準備できる (2951 <= 2991)。2991 が画面にあれば (表示 2980..3000 のまま) anchored、PUT 3000。2995..3000 だけなら 2991 は画面より上で一部も出ていない (2.-4) ので PUT なし、バナー「未読 10 件 · …」に 2 つのボタン。「最初の未読へ」はリクエストなしで mark を 2990 にし、区切りを上端、2991 をその直下に着地させる (以前の「2991 を上端」は 4. で区切りを上端に変更) |
| V8 | 8., 12. | V2 の状態で alice が 3001 を投稿 (最下部に出る) | 未読 2001、PUT なし。バナー「未読 2,001 件 · 10:23 以降」(`first_unread_at` は変わらない) |
| V9 | 11. | V2 の状態で bob がトップレベルに 3001 を投稿 | サーバは bob の既読を 3001 にする。この端末から送った時は POST の 2xx で手元も last_read 3001、未読 0、`first_unread_at` null (範囲に関係なく効く、1.)。別の端末から送った時は自分の `message.created` では動かさず、続く `read.updated` で同じになる。バナーは消えて anchored (以前は自分の投稿のイベントでも進めていた。11. で POST の応答だけに変更、V41 / V42) |
| V10 | 2.-1, 2.-2, 5. | V1 を最後まで読んで anchored。オフラインの間に alice が 6,000 件 (`last_seq` 6130)。再接続: bootstrap で未読 6000、§7.3 の読み直しで手元を消して 6081..6130 を読む | 準備できないので anchored は false、表示範囲からの PUT なし。バナー「未読 6,000 件 · …」は「既読にする」だけ。bootstrap から読み直しが終わるまでは、追いつき中で最初の未読行が手元に無いのでバナーは出ない (5.。以前はこの条件が無かった) |
| V11 (訂正) | 2.-3 | V1 で anchored (130 まで読んだ)、`oldest_loaded_seq` 81、`last_seq` 1130。他端末が `read.updated (set)` 500 / 未読 630 | anchored は false (位置が下がった)。この評価では PUT なし。501 が画面にあれば次のスクロールで anchored になり PUT、画面より上なら「未読 630 件」のバナー (2 つのボタン)。以前の「covered の間は set でも anchored のまま」という注記は誤り |
| V12 | 2.-3, 5. | last_read 1000、手元は 1400..1500 (`oldest_loaded_seq` 1400)。`read.updated (set)` で 900 に下がる | 準備できないので anchored は false、表示範囲の既読は何もしない。バナー「未読 N 件 · …」の N はサーバの値。「最初の未読へ」は N <= 500 のときだけ |
| V13 | 3., 5., 10. | V1 で anchored (last_read 115)、行 110 で「ここから未読にする」 | PUT `{last_read_seq: 109, mode: set}` (110 - 1。後ろへ戻すので範囲に関係なくできる)。表示範囲の既読は止まる (保留)。区切りは 110 の前。保留の間バナーは出ない |
| V14 | 定義, 12. | last_read 100、101..160 はシステム行 (`type` が user でない)、未読 0、`oldest_loaded_seq` 111 | 未読 0 なので準備できている。表示 150..160 で PUT 160。バナーなし |
| V15 | 6. | last_read 1000、`last_seq` 2200。1001..2200 は alice の投稿 300 件と user でない行 900 件が混ざる、未読 300。初めて開いて「最初の未読へ」 | 最新ページ 2151..2200。1 回目: GET 4 回 (limit 200) で `oldest_loaded_seq` 1351、届かないので false。バナーとボタンはそのまま、エラーは出さない。2 回目: さらに GET 2 回 (`before_seq=1351`、`before_seq=1151`) で 951 まで読んで届く。区切り (mark 1000) を上端、その直下に最初の未読行 (1000 より後の他人の最初の行。システム行でもよい) (以前の「最初の alice の行の前」は、type を問わない現在の「最初の未読行」の定義に変更) |
| V16 | 5. | V4 でオフライン | リクエストなし。バナーは出て、2 つのボタンは無効 |
| V17 | 4., 10.3 | C (未読 300) を検索結果・パーマリンクから開く | PUT なし。バナーも区切りもなし。その行を中央。Android でも行が見つかる (§10.3) |
| V18 | 5. | `bannerText(300, null)` | 「未読 300 件」 |
| V19 | 5. | `bannerText(n, …)`、n = 12、999、1234、1000000 | 「未読 12 件」「未読 999 件」「未読 1,234 件」「未読 1,000,000 件」(どのロケールでも半角カンマ) |
| V20 | 5. | `sinceLabel`、今は 2026-09-28 15:00。入力 (端末の時刻) 2026-09-28T10:23、2026-09-27T23:05、2026-09-26T09:07、2025-12-31T10:23 | 「10:23」「昨日 23:05」「9月26日 (土) 09:07」「2025年12月31日 (水) 10:23」。バナー全体は「未読 2,000 件 · 10:23 以降」 |
| V21 | 5., 6. | `jumpButtonShown(ready, n)`: (false, 500)、(false, 501)、(true, 501) | 出す、出さない、出す |
| V22 | 定義 | `covers(oldest_loaded_seq, m)`: (0, 5)、(null, 5)、(6, 5)、(7, 5) | true、false、true、false |
| V23 | 3. | `dividerMark(保留の位置, 開いた時の mark, oldest_loaded_seq)`: (null, 1000, 2951)、(null, 1000, 851)、(109, null, 81) | null (区切りなし)、1000、109 |
| V24 | 10.2 | 親 P は seq 500、返信 r1..r30 は 501..530。`ThreadState.last_read_seq` 510。手元には r29 と r30 だけ (ライブで届いた)。スレッドを開く | replies の取得前: 表示 r29、r30 の markThreadRead(530) は何もしない (全体を取得済みでない)、PUT なし、手元の行を最下部に出す。取得が成功し `ThreadState` が揃ったら 1 回だけ位置合わせ: 「新しい返信」の区切りと r11 を上端に着地させて anchored。表示 r11..r18 で `PUT /messages/P/thread/read {518}` |
| V25 | 10.2 | V24 で取得済みの後、C の §7.3 読み直しでメッセージが消える | P の「全体を取得済み」は下りる。replies の取得がまた成功するまで markThreadRead は何もしない (開いている画面は取り直す、V49) |
| V26 | 10.2 | `last_read_seq` 530 (未読返信なし) のスレッドを開く | 最下部で開いて anchored。既読は変わらない (530 は今の値より大きくない) |
| V27 | 10.2 | replies の取得が失敗 (オフライン) | スレッドの PUT なし。手元の行を最下部に出す。オンラインで取得できたら 1 回だけ位置合わせ (その間に利用者がスクロールしていたら省く。V50) |
| V28 | 1. | ChannelState `{未読 60, last_read 0, oldest_loaded_seq 11, has_older true}` (追いついている): markRead(60)、続いて markRead(60, force) | 1 回目は何もしない (手元も動かさず PUT なし)。2 回目は PUT 60、未読 0、`first_unread_at` null |
| V29 | 8. | `first_unread_at` の保持: bootstrap で未読 0 / null。alice の 11:00 の投稿がライブで届く。markRead が `last_seq` に届く | 0 → 1 でそのメッセージの `created_at` (11:00)。`last_seq` まで読むと null。行 X で「ここから未読にする」なら数え直した最初の行の `created_at`。`read.updated`、PUT の応答、read-all の応答はサーバの値で置き換える |
| V30 | 10.3 | 実際の形の行 (`client_msg_id` ≠ id) で V1 を開く、V24 のスレッド、検索結果 (Android で見つかった不具合) | チャンネルは 101 の位置で開く (区切りを上端。index 0 の最新行ではない)。検索結果はその行を中央 (見つかった index が -1 でない)。スレッドは表示された行が返信に解決されて markThreadRead が呼ばれる |
| V31 | 13. の 11 | 契約フィクスチャ 11 (alice が 60 件、ページ 50) | `client.read 60` の後: last_read 0、未読 60。`client.load_first_unread` の後: 60 件 (先頭は m1)。`client.read 30` の後: last_read 30、未読 30。force 付きの `client.read 60` の後: last_read 60、未読 0 |
| V32 | 定義 | `{unread 300, last_read 130, oldest 81, synced 130, last 430}` / 同じで synced 430 / `{unread 0, synced 130, last 430}` | `read_range_ready` は false / true / true |
| V33 | 1., 2.-2, 5. | 130 まで読んで anchored、最下部 (116..130 を表示)。アプリが離れている間に alice が 300 件 (131..430)。再接続: bootstrap で last 430 / 未読 300、差分はまだ (再起動して保存済みのストアで先に開いていた場合も同じ) | 差分が届くまで: 準備できていないので anchored は false、markRead は何もしない。バナーは出ない (追いつき中で未読行が手元に無い) |
| V34 | 2.-4 | V33 の続き。差分 131..430 が届き、最下部へ追従して 416..430 を表示 | 最初の未読行 131 は画面より上で一部も出ていない: anchored は false、PUT なし。バナー「未読 300 件 · …」(2 つのボタン)。「最初の未読へ」はリクエストなしで区切り (131 の前) を上端へ着地させ、その後は表示した行だけが PUT される。Desktop は追従の代わりに 131 を上端に置いてもよい (区切りがあればそれを上端) |
| V35 | 4. | V33 の状態 (bootstrap 済み、差分はまだ) で、C を開いていなかった端末が C を開く (オンライン) | 位置合わせは差分を待つ (最大 3 秒)。バナーは出ない。差分の後、区切り (mark 130) を上端、131 をその直下に着地させ、表示した行だけ PUT。3 秒以内に利用者がドラッグしたら位置合わせしない |
| V36 | 2.-3 | `last_seq` 1130、81..1130 を読み込み済み、1100 まで読んで anchored、上へ遡って 495..510 を表示中。他端末が `read.updated (set)` 500 | その評価では PUT なし (501 は画面にある)。次のスクロールで 501 が表示できた行に入ると anchored、PUT は表示の最大 |
| V37 | 2.-3 | 「ここから未読にする」で保留中 (V13)、読み手はその会話の画面のまま別の会話が開かれて保留が解けた (iOS の検索シート) | anchored は false。保留した行 (110) が画面に出るまで PUT なし |
| V38 | 10. | V2 の状態 (last_read 1000、2951..3000 を読み込み) で行 2990 のメニュー / エンジンに `markUnread(2990)` | 「ここから未読にする」は出ない。エンジンは PUT なし、last_read 1000、保留 1000。V1 の状態 (last_read 115、範囲が届いている) で行 125 なら PUT `{124, set}` |
| V39 | 4., 5., 6. | V4 の「最初の未読へ」。読み込みが終わってから着地するまでの間、画面の枠はまだ最下部の行 | その間は PUT なし、バナーは隠れ「読み込み中…」は着地まで。着地後: 区切りが上端、1001 がその直下、PUT は表示の最大 (約 1012)。seenSeq 1000 なので最下部へのボタンは「新着 300 件」 |
| V40 | 7. | V1 (未読 30) を開く。リストの初期位置は最下部 | 区切りへ位置合わせする前に seenSeq を進めない。最下部へのボタンは「新着 30 件」 |
| V41 | 11. | V1 で 130 まで読んだ (未読 0)。alice が 131、bob が別の端末から 132 を投稿 (`message.created` 132 の後に `read.updated` 132) | 131 で未読 1。132 のイベントでは last_read 130 / 未読 1 のまま。`read.updated` で 132 / 0。この端末から送った場合は POST の 2xx で直ちに seq / 0、保留も解ける |
| V42 | 11. | V2 の状態 (last_read 1000、未読 2000)。bob の予約送信が 3001 で送られ、続いて alice が 3002 (画面に出る) | 3001 のイベントで手元は 1000 / 2000 のまま。3002 で未読 2001、範囲が届かないので PUT なし (イベントで進めていると 3002 の PUT が 1001..3000 を飛び越える) |
| V43 | 11. | 130 まで読んで anchored、400 件の会話。スレッドから `also_in_channel` の返信を送る | タイムラインは動かない。チャンネルの既読位置は手元もサーバも変わらない |
| V44 | 12. | 未読 0。alice の `type: "system"` の行が届き、続いて alice の通常の投稿 | システム行では未読 0 / `first_unread_at` null のまま。通常の投稿で未読 1、`first_unread_at` はその `created_at` |
| V45 | 2.-1 | anchored、未読あり。バックグラウンドで §7.3 の読み直し (範囲が空の間に評価が無かった)。新しいページは既読位置に届く | 前面に戻った最初の評価で anchored は false。最初の未読行が画面に出るまで PUT なし |
| V46 | 2. | V6 の 5 ページ目が届いた直後、描画前の行 (1051..) で評価 | 行とチャンネル状態を同じ時点で取るので anchored にならない (古い先頭 1051 を最初の未読行と取り違えない) |
| V47 | 6. | V4 の「最初の未読へ」で本文に URL を持つ 400 行が加わる | リンクプレビューのリクエストは画面の近くの行だけ (400 件を一度に送らない) |
| V48 | 4. | 検索結果から C (未読 30、最新ページ 81..130) を開き、「最新の会話へ」で戻る | 開いた時と同じ: mark 100 を取り直し、区切りを上端に着地。最下部に固定しない |
| V49 | 10.2 | V24 で完了して開いたまま。オンラインのまま C の §7.3 読み直し | 完了フラグが下り、画面は replies を取り直す。取り直すまで markThreadRead は何もしない |
| V50 | 10.2 | V24 の読み込み中にキーボードが出る / 上に 28 件の返信が入る | 利用者のスクロールとみなさない。揃った時に位置合わせする |
| V51 | 10.2 | 完了したスレッドを最下部で表示して anchored。再接続で画面より高い 10 件の返信が届き、最下部へ追従 | 最初の未読返信が画面より上で一部も出ていない: anchored は false、スレッドの PUT なし |
| V52 | 10.2 | スレッドの last_read 510、表示で 518 まで進めた (PUT はデバウンス中)。`thread.updated (reply)` が last_read 510 で届く | 手元は 518 のまま。anchored も落ちない |
| V53 | 10.2 | 完了したスレッドを持つチャンネルを自分で抜ける (`member_removed` を取りこぼした)、公開チャンネルの一覧から消える | そのチャンネルのスレッドの完了フラグは下りる。参加し直しても replies を取り直すまで markThreadRead は何もしない |

## 11. エッジケース

| 状況 | 挙動 |
| --- | --- |
| 端末の再起動 / アプリの強制終了 | ローカルストアの `synced_seq` から §7.2 の手順で再開する。切断時刻の記録は不要 |
| サインアウト / セッション失効 | サーバのセッションを失効させる (access token が切れていたら更新して送り直す)。その後ローカルストア (メッセージ・下書き・送信キュー) を消し、バッジと表示中の通知を消す。ローカルストアの名前はサーバ URL とユーザー名のハッシュから作る (似た名前の別アカウントと混ざらない) |
| アプリがバックグラウンドで WS が切られた (iOS / Android) | フォアグラウンド復帰で §7.5。プッシュ受信時は PUSH_NOTIFICATIONS.md の手順 |
| プッシュ通知を取りこぼした / 遅れて届いた | 影響なし。次にアプリを開いた時の同期で回復する。通知タップ時は同期後に表示する |
| チャンネルから除外された | `channel.member_removed` (本人宛) → ローカル削除。以後 API は `403 not_a_member` |
| チャンネルがアーカイブされた | `channel.archived`。閲覧のみ可。送信は `409 channel_archived` |
| ユーザーが無効化された | `user.deactivated`。表示名は残す。当人の全セッションは `session.revoked` |
| access token 期限切れ | REST は `401 token_expired` → refresh → リトライ (1 回)。WS は影響なし |
| refresh 失敗 (`401 session_revoked`) | ローカルストアを消してログイン画面へ |
| `must_change_password` が true | パスワード変更画面を先に出す。他の書き込みは `403 password_change_required` |
| WS イベントが REST 差分より先に届いた | マージ規則で吸収。`synced_seq` はギャップ検知に従う |
| 同じイベントが 2 回届いた (Relay 再処理) | `updated_seq` が同じなので 2 回目は無視 |
| 端末の時計がずれている | 影響なし。表示時刻はサーバの `created_at` |
| 長期オフライン | §7.3 の打ち切り規則で最新ページから読み直す |

## 12. 例: 切断中に 3 件の変更があった場合

```
ローカル: synced_seq = 100
切断中にサーバで:
  seq 101: A が "hi" を投稿 (msg X: seq 101, updated_seq 101)
  seq 102: B が msg X に 👍       (msg X: updated_seq 102)
  seq 103: A が msg W (seq 90) を削除 (msg W: updated_seq 103, deleted)

再接続 → GET /channels/c/sync?since_seq=100
  → messages: [ X (seq 101, updated_seq 102, reactions [👍]), W (seq 90, updated_seq 103, deleted) ]
  → next_since_seq = 103
ローカル: X を upsert、W を削除、synced_seq = 103
```

X の作成と 👍 は 1 行にまとまって届く (状態ベース)。イベントを 1 つずつ再生する必要はない。

## 13. 契約テスト

`server/tests/contract/` に JSON フィクスチャで「サーバ操作列 → 期待されるローカル状態」を書き、
サーバ側テストと各クライアントの同期ロジックのテストで同じフィクスチャを使う。最低限のシナリオ:

1. 初回ロード → 50 件 + `synced_seq = last_seq`
2. ライブで連続イベント (ギャップなし)
3. ギャップ検知 → 差分取得で回復
4. 切断中の作成 / 編集 / 削除 / リアクション → 差分 1 回で回復 (§12)
5. 同じ `client_msg_id` で 2 回送信 → 1 件
6. WS イベントが REST 応答より先に来る
7. 2 端末の既読が単調に収束する
8. 差分打ち切り (5000 件超)
9. 再起動後に永続化した `synced_seq` から再開して欠落しない
10. (予約) スレッドの既読収束 (THREADS.md §6)
11. 未読が 1 ページを超える会話を初めて開く → 表示範囲の既読は送られない → 「最初の未読へ」で範囲が既読位置に
    届く → 既読が進む。「既読にする」は範囲に関係なく末尾まで進める (§10.1、M17)。
    §10.1 のそれ以外の規則 (追いつき中の既読の拒否 `caught_up`、自分の投稿のイベントで既読位置を動かさない、
    「ここから未読にする」の範囲、システム行の数え方) はフィクスチャの操作では作れない (各端末の `client.receive` は
    届いているフレームをすべて適用し終えるまで進めるので、イベントと後続の `read.updated` の間の状態を見られない。
    予約送信・システム行・追いつきの途中は操作が無い)。参照クライアント (`contract_client.py`) はこれらの規則どおりに
    動き、各端末は §10.4 のベクトルをテストにする

## 14. キャンバス (M41・M42、CANVAS.md §4.4・§4.6・§4.8〜§4.14)

キャンバスは会話に属する Markdown の文書。書き込みは REST だけで、WS の `canvas.*` は「新しい版がある」ことだけを
知らせる (本文は載せない)。channel の seq は使わない (未読を増やさない)。3 端末は同じ手順に従う。
マージのコードはサーバにしかなく、端末は「送った本文」と「サーバが返した本文」を比べるだけでよい。

### 14.1 状態と読み込み

- メタ (`CanvasMeta`) は「`version` が大きい方が勝つ」。会話を開いたとき・再接続の後に `GET /channels/{id}/canvases` を
  読み直す (取りこぼした `canvas.*` はこれで回復する)。一覧全体は `GET /canvases?cursor=` (更新の新しい順)。
- 会話のタブは bootstrap の `ChannelOut.canvas_tab_id` (bootstrap だけが埋める。ほかの応答では null)。その後は
  `canvas.*` の `is_channel_tab` で追う。
- 本文は `GET /canvases/{id}`。ETag は `"v<version>"` で、`If-None-Match` が一致すれば 304。
- `channel.member_removed` で自分が外れたら、その会話のキャンバスと保存待ちを手元から消す。アーカイブされた会話は閲覧だけ。

### 14.2 保存

端末の状態 (キャンバスごと): `base_rev_id`、`editor_text`、`dirty`、`in_flight {client_save_id, sent, base} | null`。
Tauri・iOS・Android は保存待ちを端末のストアに持つ (落ちても・オフラインでも同じ key で再送する)。

```
編集したら dirty。入力が 2 秒止まったとき、画面を閉じるとき、背面に回るときに save()
save():
  送信中なら終わってからもう一度。sent = editor_text。in_flight を保存
  PUT /canvases/{id}/content {base_rev_id, body: sent, client_save_id (新しい UUIDv4), on_conflict: "fail"}
  200 {canvas, submitted_rev_id, merged}:
    editor_text == sent なら: base_rev_id = canvas.head_rev_id。canvas.body が sent と違えば (他の人の変更が
      マージされた) エディタを canvas.body に差し替える (カーソルは前後で共通する先頭・末尾の長さで保つ)
    そうでなければ (送信中に入力が続いた): base_rev_id = submitted_rev_id (送った本文そのものの版)。次の保存でマージされる
  409 canvas_conflict: details.head (今の版) と details.conflicts [{base, ours, theirs, ours_line, theirs_line}] で
    競合パネル (自分の版 / 相手の版 / 両方残す) → 同じ base_rev_id・新しい key・on_conflict = ours | theirs | both で再送
    (details.timed_out なら文書全体が 1 つの競合)
  409 canvas_base_expired: 元の版が無い (整理された・消去された)。details.head と手元の本文を並べて見せる
  403 (canvas_edit_restricted / guest_restricted / posting_restricted / not_a_member) / 404: 編集を止めて理由を出す
    (手元の本文は残す)。409 channel_archived も同じ
  401 token_expired: refresh して 1 回だけ再試行
  429 / 5xx / 通信エラー: in_flight を保ったまま、バックオフして同じ key で再送 (版は増えない)
閲覧中 (dirty でない) に canvas.updated で大きい version が来たら GET /canvases/{id} (0.5 秒デバウンス、If-None-Match)
編集中に来たら何もしない。次の保存でマージされ、入力が止まった時点で相手の変更が現れる
```

- **チェックの切り替え**に専用の API は無い。表示中の版の該当行の `[ ]` を `[x]` にして、その版を base に `PUT` する。
  隣り合う項目を 2 人が同時にチェックしても両方残る。`edit_policy = owners` でもメンバー (guest 以外) はチェックだけは
  変えられるが、その保存では `on_conflict` に `ours` / `both` を使えない (`403`)。
- **冪等**: 同じ `client_save_id` の再送は、その保存が作った版を `submitted_rev_id` に、今の状態を `canvas` に入れて 200 を返す
  (もう一度マージはしない)。別のキャンバスで使った key は `409 idempotency_conflict`。作成 (`POST
  /channels/{id}/canvases`) と版の復元も `client_save_id` を取り、再送は最初の結果を返す (作成の再送は 200)。
- 本文が変わらない保存では版もイベントも作らない (`submitted_rev_id` は head)。

### 14.3 マージの規則 (サーバ、CANVAS.md §4.4)

保存は `canvases` の行ロックで 1 つずつ処理する。`base_rev_id` が head ならそのまま新しい版にする。そうでなければ
base・送られた本文・head を 3-way マージする。

1. 行単位で base↔自分、base↔相手を対応させる (共通の先頭・末尾を除き、小さい区間は difflib、大きい区間は 1 回だけ
   現れる行 (無ければ両側で同じ回数だけ現れる行) を目印に分割)。
2. 片側だけが変えた区間はその側、両側が同じに変えた区間は 1 回。
3. 同じ位置への挿入は両方 (相手 → 自分)。片方がもう片方を先頭か末尾に含むなら長い方だけ。
4. 両側が変えた区間は、行数が同じなら 1 行ずつ、違えば区間全体を、語句に分けて同じ規則で比べる。語句は改行、空白の並び、
   区切りの記号 1 字 (。、，．！？「」『』()[] など)、同じ文字種 (漢字 / ひらがな / カタカナ / 英数字 / その他) の並び。
   日本語は空白が無くても文字種の境目で分かれるので、同じ文の別の句を 2 人が直してもマージできる。
   語句の単位で同じ位置に別々の語句を足した場合は、どちらも前後の語句から空白・記号で離れているときだけ両方を残す
   (`@` の直後に別々の名前を入れた、のような「くっつく」挿入は競合)。
5. それでも重なる箇所が競合。`on_conflict` は競合した区間 (1 行、または区間全体) ごとに効く: `ours` は自分の版、`theirs` は
   相手の版、`both` は相手の版の後に自分の版を `> ` で引用して残す。
6. 所要時間は 200 ms まで (スレッドプールで実行)。超えたら文書全体を 1 つの競合として扱う (`timed_out`)。

規則は `server/tests/fixtures/canvas_merge/*.json` のフィクスチャで固定している。

### 14.4 画像・共有・検索・整理 (M42、CANVAS.md §4.8〜§4.14)

- **画像**: `POST /attachments` でアップロード (pending) し、本文に `![説明](attachment:<id>)` を入れて保存する。サーバは保存
  (作成・版の復元も) のたびに、本文が指す**自分の** pending をそのキャンバスに bind する。bind できなかった id (他人の
  アップロード、別のキャンバスやメッセージの添付) は本文に残るが、読めない端末では「表示できない画像」になる。
  読むのは既存の `GET /attachments/{id}` (`/thumbnail`、`/content?inline=1`)。キャンバスの画像は会話のメンバーだけが読め、
  それ以外は 403 (公開チャンネルでも)。1 キャンバス 100 件を超える保存は `400 too_many_canvas_images` (編集を止めて理由を出す。
  再送しない)。
- **共有とコメント**: 作成時の `share_to_channel: true`、または `POST /canvases/{id}/share` で、題名とパーマリンク
  `<server>/c/<id>` の普通のメッセージが会話に投稿され (`message.created`、seq を使う)、`share_message_id` に入る
  (`POST …/share` は `canvas.updated` (change=settings) も出す)。コメントはこのメッセージのスレッド。
  コメントを開くとき `share_message_id` が null (または、そのメッセージが消えている) なら先に `POST …/share` を呼ぶ。
  呼び直しても共有メッセージが残っていれば何も起きない。
- **パーマリンク** `<server>/c/<canvas_id>`: `/m/` と同じく、ログインしている server のものだけを本文中で認識し、
  `GET /canvases/{id}` で開く (題名・会話・更新者・進捗のカード)。403 / 404 なら「表示できないキャンバス」。ブラウザで
  開いたときの `/c/` のページは中身を出さない。
- **検索**: `GET /search/canvases?q&channel_id&from_user_id&after&before&sort&tz_offset_minutes&limit&offset`。
  応答は `hits[] {canvas (メタのみ), snippet (プレーンテキスト), score}`・`keywords` (端末が抜粋を強調する)・`filters`・`total`。
  自分がメンバーの会話だけが対象 (参加していない公開チャンネルのキャンバスは出ない)。
- **整理**: 24 時間を過ぎた版は整理され (side と、同じ作者の 10 分以内の続き)、30 日ゴミ箱にあったキャンバスは消える。
  イベントは出ない。24 時間以上オフラインで編集した端末の保存は、元の版が無ければ `409 canvas_base_expired` (§14.2)。
  消えたキャンバスは `GET /channels/{id}/canvases?trashed=true` から外れ、`GET /canvases/{id}` は 404。

### 14.5 Phase 2 (M72、CANVAS.md §18)

- **メンション**: 保存 (直接・マージ) と作成で、前の head に無かったメンション (グループは展開) の相手のうち会話のメンバー
  (本人以外) に `canvas.mentioned` (user) が 1 回届く。再送 (`client_save_id`) では増えない。版の復元・チェックだけでは出ない。
  端末は表示を変えず、開いていれば通知だけ出す (押すとそのキャンバス)。取りこぼしても回復はしない (プッシュと同じく知らせるだけ)。
- **編集中**: WS の `canvas_presence` (§5.2)。状態はサーバのプロセス内と端末のメモリだけ。再接続の後は、編集中なら端末が
  `editing: true` を送り直す (次の入力か 20 秒ごとの送り直し)。受けた側は 45 秒で消すので、取りこぼしても残り続けない。
- **チェックリストからタスク**: `POST /tasks` の `source_canvas_id` + `source_canvas_line` (TASKS.md §10)。端末は送る前に
  キャンバスの手元の入力を保存する (サーバは保存済みの本文に行があるかを見る)。タスクの `canvas_source` は作った時の写しで、
  キャンバスの変更では `task.updated` は出ない (完全に消えたときだけ、次に読んだ `canvas_id` が null)。

## 15. カレンダー (M51、CALENDAR.md §5)

予定はチャンネルの seq を使わない。端末は予定を長く保存せず、画面ごとに期間を読む。

- **読む**: 画面 (カレンダーの月・週・一覧、チャンネルの「予定」タブ) が期間を開くたびに `GET /calendar/events?from&to[&channel_id]`
  (最長 100 日)。`from` / `to` は端末のタイムゾーンの 0:00 を offset 付きで渡す (終日の予定はこの offset の日付で重なりを見る)。
  チャンネルの見出しの件数は `GET /calendar/upcoming?channel_id&days=2&tz` (今日・明日のまだ終わっていない予定、最大 10 件)。
- **イベント**: `calendar.event.updated` は予定を、開いている期間それぞれについて「重なれば入れ替え (無ければ足す)、重ならなければ
  外す」。`can_edit` は `editor_ids` (作成者・チャンネルのオーナー・メンバーの管理者。アーカイブ済みなら空、自分用は本人) に
  自分がいるか。`alarm` はイベントに無いので手元の値を残す (変わるときは `calendar.alarm.updated` が別に届く)。そのチャンネルの
  件数を読んでいれば読み直す。`calendar.event.deleted` は外す。重ならないイベントは捨ててよい (次に開いたときに読む)。
- **再接続**: 開いている期間と件数を全部読み直す。取りこぼしたイベントはこれで埋まる。チャンネルから抜けた (channel.member_removed が
  自分) ら、そのチャンネルの予定を手元から外す。
- **自分の変更**: POST / PATCH / PUT alarm の応答 (`CalendarEventOut`) をそのまま手元に入れる。後から届く自分の変更のイベントは
  同じ内容なので二重にならない。作成の再送は `client_event_id` で同じ予定が返る (201 の代わりに 200)。
- **繰り返し (M68、CALENDAR.md §10.4)**: 繰り返しの予定は回ごとに 1 件 (`id` は回の id、`series_id` は親、`occurrence_start` は回の鍵)。
  展開はサーバだけがする。`recurring: true` の `calendar.event.updated` (親・例外・分割のどれが変わっても親の内容で届く) と、自分の
  繰り返しの変更の応答では、開いている期間 (そのチャンネルと全部の窓) と件数を**読み直す**。`calendar.event.deleted` は `series_id` が
  一致する回を全部外す。単発に戻った予定 (`recurring: false`) は、同じ `series_id` のほかの回を外して入れる。通知 (`calendar.alarm.updated`)
  は系列に 1 つで、`alarm.occurrence_start` がどの回の通知か。手元のその系列の回すべてに当てる。

## 16. タスク (M55、TASKS.md §4)

タスクはチャンネルの seq を使わない。端末はタスクを長く保存せず、画面ごとに読む (カレンダーと同じ)。

- **読む**: チャンネルの「タスク」タブは `GET /tasks?channel_id` (未完了の全部と、完了の最近 100 件。`include_done=all` で全部)。
  「自分のタスク」は `GET /tasks/mine` (自分用と、参加しているチャンネルの自分が担当のもの。完了は最近 50 件)。カレンダーは表示中の
  期間について `GET /tasks/due?from&to` (日付。`to` は含まない、最長 100 日。完了も含む)。
- **並び**: 列 (`status`) の中は `position` の小さい順、同じなら id 順。端末は手元の順番ではなく、いつもサーバの `position` で並べる
  (移動で列が振り直されると、動いたカードそれぞれの `task.updated` が届く)。ドラッグの移動は `POST /tasks/{id}/move
  {status, after_id?, before_id?}` (`after_id` = すぐ上に来るカード、`before_id` = すぐ下)。手元で先に動かしてよいが、応答
  (`TaskOut`) とイベントの `position` で置き換える。
- **イベント**: `task.updated` はタスクを、開いている画面それぞれについて「載るなら入れ替え (無ければ足す)、載らなければ外す」
  (ボード: そのチャンネル。自分のタスク: 自分用か、`assignee_ids` に自分がいる。カレンダー: `due_on` が期間の中)。`can_delete` は
  `deleter_ids` (作成者 (メンバーなら)・担当者・チャンネルのオーナー・メンバーの管理者。アーカイブ済みなら空、自分用は本人) に
  自分がいるか。`task.deleted` は外す。`task.assigned` / `task.due` は表示を変えず、アプリを開いている端末が通知を出す。
- **再接続**: 開いているボード・自分のタスク・カレンダーの期間を全部読み直す。チャンネルから抜けた (channel.member_removed が自分) ら、
  そのチャンネルのタスクを手元から外す。
- **自分の変更**: POST / PATCH / move の応答をそのまま手元に入れる。作成の再送は `client_task_id` で同じタスクが返る (201 の代わりに 200)。

## 17. ドキュメント（M120、docs/WIKI.md §10・§14）

ページはチャンネルの seq を使わない。木は変更のフィード（`wiki_change_seq`）で、本文はキャンバスと同じ保存（§14.2）で同期する。

- **起動**：bootstrap の `wiki.change_seq`（無ければサーバがドキュメントを持たない）。手元の木が無い・`reset` なら `GET /wiki/tree`
  （読めるページのメタ全部と `cursor`。ETag で 304）。行（`kind = row`）は木に入らない。
- **差分**：`GET /wiki/changes?since=<cursor>` → `{pages, removed, cursor, reset}`。`pages` は読めるページで変わったもの（新しい・題名・
  アイコン・親・並び・復元・共有された）、`removed` は手元から外す id（ゴミ箱、完全に消えた、読めなくなった）。`cursor` を次の
  `since` にする。`reset: true` なら木を全部読み直す（since が古すぎる・新しすぎる、変わったページが 5,000 を超えた）。本文の保存では
  フィードは進まない（2 秒ごとの保存で全員が読み直さないように）。`removed` に知らない id が来たら無視する。
- **並び**：親の中は `position` の文字列のバイト順（同じなら id）。端末は前後のページの id を送るだけ（`before_id` / `after_id`）、
  キーはサーバが作る。親を読めないページは `parent_id: null` で届く（最上位に出す）。
- **イベント**：`wiki.changed {seq}` が来たら 300 ms まとめて差分を読む。`wiki.page.updated` は開いているページを読み直す
  （`GET /wiki/pages/{id}`、If-None-Match）。`wiki.mentioned` / `wiki.shared` は表示を変えず、アプリを開いている端末が通知する。
- **再接続**：`GET /wiki/changes?since=`、開いているページは `GET /wiki/pages/{id}`（If-None-Match）。`group.updated` と自分の
  ロールの変化（`user.updated`）では読める範囲が変わりうるので木を読み直す（グループの変化はフィードを進めない）。
- **保存**：`PUT /wiki/pages/{id}/content`（キャンバスと同じ `base_rev_id`・`client_save_id`・`on_conflict`、409 `page_conflict` /
  `page_base_expired`）。閲覧（view）の人はチェックも付けられない（403 `page_edit_restricted`）。
- **読めないページ**：どの経路でも 404 `page_not_found`（存在ごと隠す）。手元にあれば外す。
- **データベース（M123、WIKI.md §5・§18）**：行は木にもフィードにも入らない。開いている表・カレンダーは
  `POST /wiki/databases/{id}/query` で読み、`wiki.rows.changed {database_id, seq, schema_version}`（データベースを読める人、送る時点で
  解決）が来たら 300 ms まとめて読み直す。`schema_version` が手元と違えば `GET /wiki/databases/{id}` も読み直す。再接続の後も読み直す
  （イベントは失われうる）。マスの変更は `PATCH /wiki/rows/{id}/props {set, client_op_id}`（マスごとの後勝ち、同じ `client_op_id` の
  再送は 1 回だけ効く）。行のページは `wiki.page.updated`（`change: "props"`）でも読み直す。
- **テンプレート（M145、WIKI.md §22.3・§24）**：ページのテンプレート（`is_template`）は木にもフィードの `pages` にも入らない。
  ページがテンプレートになると、フィードの `removed` にその id が来る（戻すと `pages` に来る）。一覧は `GET /wiki/templates` で読み、
  一度読んだら `wiki.changed` のたびに（300 ms まとめて）読み直す。行のテンプレートは問い合わせに入らず、`GET /wiki/databases/{id}` の
  `templates`・`default_template_id` にある。その変更（作成・解除・名前・ゴミ箱・既定）は `wiki.rows.changed` で知らせ、
  `schema_version` は進めない（端末は `templates` と `default_template_id` も比べて読み直す）。テンプレートから作る・複製・
  `apply-template` は `client_save_id` で冪等（再送は同じページを 200 で返す）。新しいイベントは無い。
- **ビューの種類（M147、WIKI.md §22.4・§25）**：ボード・リスト・ギャラリーとグループは同じ問い合わせ（`grouped: true` で
  `groups`・`row_groups` が付く）。ボードのカードの移動は `POST /wiki/rows/{id}/move {set, before_id | after_id, client_op_id}`
  （値と行の並び（`position`）を 1 回で書く。値の変更は `client_op_id` で 1 回だけ効き、並びは送り直しても同じ所に置き直すだけ）。
  知らせは今までと同じ `wiki.rows.changed`（と値が変われば `wiki.page.updated`、`change: "props"`）。新しいイベントは無い。
  `grouped` を送らない古い端末には、ビューのグループの順で 1 行ずつ（隠したグループの行は除く）返す。
