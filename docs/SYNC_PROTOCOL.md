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
      "read_state":   { "last_read_seq": 1520, "unread_count": 9, "mention_count": 1 },
      "notification": { "level": "mentions", "muted_until": null },
      "dm_user_ids": null
    }
  ],
  "limits": { "max_message_length": 20000, "max_attachment_bytes": 104857600, "max_attachments_per_message": 10 },
  "threads": { "unread_count": 2, "mention_count": 1 },
  "presence": [ { "user_id": "...", "status": "online" } ],
  "bookmarks": [ "<message_id>", "..." ],
  "favorites": [ "<channel_id>", "..." ],
  "custom_emoji": [ { "id": "...", "name": "party_parrot", "content_type": "image/gif", "width": 64, "height": 64, "created_by": "...", "created_at": "..." } ],
  "groups": [ { "id": "...", "name": "design", "description": "デザイン担当", "member_ids": ["..."], "created_by": "...", "created_at": "...", "updated_at": "..." } ],
  "sidebar_sections": [ { "id": "...", "name": "プロジェクト", "position": 0, "channel_ids": ["..."] } ]
}
```

- `channels` は自分が所属するチャンネルのみ (public のブラウズは `GET /channels?include=public`)。
- ユーザー数・チャンネル数は数十なので全件返す。増えたらページングを足す。
- `read_state` / `notification` は M8 / M5 で追加される。それまでは省略される。
- `threads` は未読の返信があるフォロー中スレッドの数 (THREADS.md §3)。一覧そのものは `GET /threads` で取る。
- `presence` は今つながっているユーザー (§5.2)。載っていないユーザーは offline。以後の変化は `presence` フレームで届く。
- `bookmarks` は自分が保存したメッセージの id (新しい順)。本文つきの一覧は `GET /bookmarks`。変化は `bookmark.updated` で届く。
- `favorites` は自分がお気に入りにしたチャンネルの id (`channels` に含まれるものだけ、M12a)。変化は `favorite.updated` で届く。

### 4.2 `GET /api/v1/channels/{id}/messages?before_seq=&limit=50`

履歴を新しい順に返す (上スクロール用)。カーソルは `seq` (offset は使わない)。
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
トゥームストーン (`deleted: true`) とスレッド返信を含む。

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
`read.updated (reason=advance)` を出す。応答は `{ channel_id, last_read_seq, unread_count, mention_count }` の配列。

```json
{ "last_read_seq": 1532 }
```

サーバは `GREATEST(現在値, 1532)` で更新し、変化があれば `read.updated` を自分の全端末に送る。
応答は現在の `{ last_read_seq, unread_count, mention_count }`。

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

サーバ → クライアント:

| type | 内容 |
| --- | --- |
| `hello` | 上記 |
| `pong` | `{ server_time }` |
| `event` | `{ id, event, ts, channel_id?, seq?, data }`。`event` がイベント名 (§6)、`id` は outbox の id |
| `typing` | `{ channel_id, parent_id, user_id }`。揮発 (M11b)。送った本人以外のメンバーに届く。クライアントは 5 秒で消す |
| `presence` | `{ user_id, status: "online" \| "away" \| "offline" }`。揮発 (M11b)。接続 / 切断、`ping` の `active: true`、5 分間 active な ping が無いときの away 判定 (30 秒ごとの sweep) で、接続中の全員に届く。プロセス内の状態なので、複数プロセス化するときは Redis に移す (ARCHITECTURE.md §12) |
| `error` | `{ code, message }`。`auth_required` / `invalid_token` / `invalid_frame` / `already_authenticated` など |

### 5.3 ハートビートと再接続

- クライアントは 30 秒ごとに `ping`。60 秒 `pong` が無ければ切断扱いにして再接続する。
- サーバは 90 秒 `ping` が無ければ切る。
- 再接続はジッター付き指数バックオフ (1s, 2s, 4s, ... 最大 30s)。ネットワーク復帰やフォアグラウンド復帰の
  通知を受けたら即座に試す。
- close code: `4000` reconnect 要求、`4001` 認証失敗、`4003` セッション失効、`1012` サーバ再起動。

## 6. イベント一覧

`event` フレームの `type` と `data`。seq 列が「消費」のものは、チャンネルの seq を 1 つ持つ。

| type | audience | seq | data |
| --- | --- | --- | --- |
| `message.created` | channel | 消費 | `{ message }` (reactions, attachments 込み。返信の場合は `parent_thread: { id, reply_count, last_reply_at, updated_seq, participant_ids }`。`participant_ids` はスレッドのフォロワー (THREADS.md §2) で、プッシュ対象の判定に使う) |
| `message.updated` | channel | 消費 | `{ message, change: "body" \| "reactions" \| "pin" }`。`pin` は `pinned_at` / `pinned_by` の変化 (M11c) `change` は `body` / `reactions` / `pin` / `poll` (M14b) |
| `message.deleted` | channel | 消費 | `{ message }` (`deleted: true`、`body` は空。返信の削除は親の `parent_thread` も含む) |
| `read.updated` | user | — | `{ channel_id, last_read_seq, unread_count, mention_count }` |
| `bookmark.updated` | user | — | `{ message_id, channel_id, bookmarked }` (M11c)。自分の他端末が保存 / 解除したときに届く |
| `favorite.updated` | user | — | `{ channel_id, favorite }` (M12a)。自分の他端末が星を付けた / 外したときに届く |
| `scheduled.updated` | user | — | `{ scheduled: ScheduledOut }` (M12d)。予約送信の作成 / 送信済み / 失敗 / 取消。`status` で一覧の行を置き換える (pending 以外は一覧から外す) |
| `emoji.updated` | all | — | `{ emoji: CustomEmojiOut, deleted }` (M12f)。カスタム絵文字の追加 / 削除。クライアントは名前の表を差し替える |
| `group.updated` | all | — | `{ group: GroupOut, deleted }` (M12k)。ユーザーグループの作成 / 変更 / 削除。クライアントは id の表を差し替える (`@name` の候補と `<@group:id>` の表示に使う) |
| `sidebar.updated` | user | — | `{ sections: [SidebarSectionOut] }` (M14f)。自分のサイドバーのセクション一覧全体。クライアントは差し替える |
| `reminder.updated` | user | — | `{ reminder: ReminderOut }` (M12e)。作成 / 発火 (fired) / 完了 / 取消。fired の行は「リマインダー」一覧の先頭に出し、アプリ内でも通知する |
| `thread.updated` | user (フォロワー) | — | `ThreadState` + `reason: "reply" \| "deleted" \| "read" \| "follow"` (THREADS.md §4)。一覧の行と「スレッド」バッジはこの値で置き換える。`read` / `follow` は本人の全端末にだけ届く |
| `notification_preference.updated` | user | — | `{ channel_id, level, muted_until }` |
| `channel.created` | channel (public は all)。参加・追加された本人には user 宛てにも送る | — | `{ channel, member_ids }`。`channel` は bootstrap と同じ形だが `membership` は null。受信者は `member_ids` に自分が含まれるかで所属を判定する (public は非メンバーにも届く) |
| `channel.updated` | channel。公開 ↔ 非公開の変換 (M15b) だけは all (guest を除く) | — | `{ channel, member_ids }`。`channel.posting_policy` (M15a) を含む。メンバーでない受信者は、public ならブラウズ用に保持し、public でなくなった (非公開に変換された) 会話は手元から消す |
| `channel.archived` | channel | — | `{ channel_id }` |
| `channel.member_added` | channel | — | `{ channel_id, user_id }`。追加された本人には `channel.created` も送る。クライアントは保持している `member_count` を +1 (`member_removed` は −1) して、次の一覧取得までの表示に使う (M11h) |
| `channel.member_removed` | channel + 本人 (outbox 行を 2 つ書く) | — | `{ channel_id, user_id }` |
| `user.created` / `user.updated` / `user.deactivated` | all | — | `{ user }` |
| `session.revoked` | session | — | `{ reason }` |

`message` オブジェクトの形は REST と同一 (`openapi/openapi.json` の `MessageOut` スキーマ)。フレームと各イベントの
`data` の JSON Schema は `openapi/ws-events.json` に生成される。

## 7. クライアントの同期手順

### 7.1 状態

チャンネルごとに `synced_seq` (nullable) を持つ。`null` は「このチャンネルのメッセージをまだ 1 件も
ローカルに持っていない」。加えて `channel.last_seq`、`last_read_seq`、`unread_count`、`mention_count`。
これらはローカルストア (SQLite) に永続化し、端末の再起動やアプリの再インストール以外では失わない。

### 7.2 起動 (コールドスタート / ウォームスタート共通)

保存済みの本人情報と refresh token がある場合は、ローカルストアを先に読み込み画面を表示する。
接続前に access token を更新し、通信エラーならキャッシュと下書きを保持してバックオフ付きで再試行する。
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

大きく遅れている場合の打ち切り: `channel.last_seq - synced_seq > 5000` なら差分を追わず、ローカルの
メッセージを捨てて `synced_seq = null` として最新ページから読み直す。長期間オフラインだった端末が
数千件の差分を引く無駄を避けるため。

### 7.4 ライブ (WS 接続中) のイベント処理

seq を消費するイベント (`message.*`) を受け取った時:

```
if channel.synced_seq is null:
    # ローカルにタイムラインが無い。チャンネル一覧の情報だけ更新する
    channel.last_seq = event.seq
    if type == message.created and not own and top-level: unread_count += 1 (+ mention_count)
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

### 7.5 再接続

```
1. WS 切断を検知 → 指数バックオフで再接続
2. 接続成功 (hello) 後は起動時 (§7.2) と同じ: イベントをバッファ → bootstrap → バッファ適用
3. 表示中のチャンネルを catch_up。他は開いた時
4. 未送信キュー (§9) の送信を再開
```

切断中の変更はすべて `updated_seq` で拾えるため、切断時刻を記録する必要はない。

### 7.6 チャンネル一覧の変化

`channel.*` イベントはデータを伴うのでそのまま反映する。取りこぼしは次回 bootstrap で回復する。
`channel.member_removed` が自分宛てなら、そのチャンネルのローカルデータを削除する。

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
```

同じ `updated_seq` のメッセージが 2 回来た場合は 2 回目を無視してよい (内容は同じ)。

## 9. 送信の冪等性と楽観的 UI

```
send(channel, body):
    client_msg_id = uuid4()
    store.outbox.add({client_msg_id, channel, body, attachment_ids, created_at})
    store.messages.put(pending message: id = "local:" + client_msg_id, seq = null)   # 末尾に仮表示
    flush_outbox()

flush_outbox():                                   # 直列。1 件ずつ順に送る
    for item in outbox (順に):
        r = POST /channels/{id}/messages (item)
        if 2xx:  reconcile(item.client_msg_id, r.message); outbox.remove(item)
        elif 401 token_expired: refresh して 1 回だけ再試行
        elif 4xx (429 以外): 失敗として表示。outbox.remove(item)。ユーザーに再送か破棄を選ばせる
        else (429 / 5xx / network / timeout): 中断。バックオフ後または再接続後に先頭から再開

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
- 検索結果から開いた前後の会話は独立した表示ウィンドウであり、既読位置を進めない。
  通常の会話へ戻ると表示範囲に基づく更新を再開する。
- 送信前にローカルの `last_read_seq` を先に進めて表示を更新してよい (楽観的)。サーバは単調増加で
  マージするので矛盾しない。
- 「ここから未読にする」は `PUT /channels/{id}/read` に `mode: "set"` を付けて送る。サーバは位置を
  そのまま (`last_seq` で clamp して) 設定し、未読数を再計算して `read.updated` を配る。他端末はこの
  イベントの値で位置を下げる。操作した端末は、その会話を離れるまで表示範囲による既読更新を止める
  (Mattermost と同じ)。既定の `advance` は従来どおり単調。
- `read.updated` には `reason` (`advance` / `set`) が入る。`advance` はクライアント側で max マージする
  (古い PUT のイベントが、その後に進めたローカル位置より遅れて届くことがあるため)。`set` だけが位置を
  下げる。未読数はどちらもサーバの値で置き換える。
- 他端末には `read.updated` が届く。バッジや未読数はその値で置き換える。
- 自分が送信したメッセージは、サーバが送信トランザクション内で既読にする。
  クライアントは自分の `message.created` で `unread_count` を増やさない。
- 既読位置を端末別に持つ要件は現時点では無い (DATA_MODEL.md §6)。

## 11. エッジケース

| 状況 | 挙動 |
| --- | --- |
| 端末の再起動 / アプリの強制終了 | ローカルストアの `synced_seq` から §7.2 の手順で再開する。切断時刻の記録は不要 |
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
