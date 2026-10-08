# PUSH_NOTIFICATIONS

iOS (APNs) と Android (FCM) へのプッシュ通知の設計。Desktop はプッシュを使わず、WS 経由のイベントから
アプリ自身が OS ネイティブ通知を出す (`devices.push_provider = 'none'`)。

## 1. 方針

- **プッシュは「新しいデータがあるかもしれない」という合図であって、同期の手段ではない。**
  欠落・遅延・重複・順序の入れ替わりを前提にする。ユーザーに見せる内容の真実は同期プロトコル
  (SYNC_PROTOCOL.md) で取得する。プッシュが 1 つも届かなくてもシステムは正しく動く。
- 送信の計画は Transactional Outbox の永続ハンドラで行い、送信状態は `push_deliveries` テーブルで管理する
  (at-least-once)。重複は端末側の collapse で無害化する。
- プロバイダ (APNs / FCM) の違いは `PushProvider` の実装に閉じ込める。

```
PushProvider
├── APNsPushProvider
├── FCMPushProvider
├── LogPushProvider    # 開発用 (設定が無い時の既定)
└── FakePushProvider   # テスト用
```

## 2. 構成と流れ

```
message.created (outbox)
   |
   v
OutboxRelay --> PushPlanner.handle(event, session)       [Relay の処理トランザクション内]
                  - 受信者を決める (§4)
                  - 受信者の有効な devices (push_token あり) ごとに push_deliveries を INSERT
                    (UNIQUE (event_id, device_id) で再処理時も 1 行)
   |
   v
PushSender (asyncio ループ。1 秒ごと、または Planner からの起床で)
   - SELECT pending AND next_attempt_at <= now() FOR UPDATE SKIP LOCKED LIMIT 50
   - 行ごとにリース (attempts += 1, next_attempt_at = now() + 60s) して COMMIT   ← ネットワーク I/O 中に行ロックを持たない
   - 送信直前の再判定: expires_at 超過 → skipped / 既読済み (last_read_seq >= message_seq) → skipped
   - provider.send(device, payload) を並列 10 まで
   - 結果で status を更新 (sent / pending+backoff / failed / トークン無効化)
   |
   v
APNs (HTTP/2, .p8 トークン認証)   FCM HTTP v1 (サービスアカウントの OAuth2)
```

メッセージのコミット後にサーバが落ちても outbox 行は残るので、通知イベントは失われない。
送信中にプロセスが落ちた場合、リース期限後に同じ行が再送される。端末側は `collapse_key` で
同一通知に畳むので二重表示にならない。

## 3. 端末とトークンの登録

端末 (`devices`) はログイン時にサーバが作る (DATA_MODEL.md `devices`)。プッシュトークンは後から登録する。

```
PUT /api/v1/devices/current
{ "push_provider": "apns", "push_token": "<hex>", "push_environment": "sandbox", "app_version": "1.0.0", "device_name": "iPhone" }
```

- 対象は現在のセッションに紐付く端末。`push_provider` / `push_token` / `push_environment` / `app_version` /
  `device_name` を更新する。
- 同じ `(push_provider, push_token)` が別の行にあれば、その行のトークンを NULL にしてから付け替える
  (端末を別ユーザーが使い始めた、または再ログインで新しい端末行ができた場合)。
- **ログアウト / セッション失効時に `enabled = false` にする** (ログアウト後の端末に通知を送らない)。
- クライアントはアプリ起動ごと、およびトークン更新 (APNs の `didRegisterForRemoteNotificationsWithDeviceToken`、
  FCM の `onNewToken`) のたびに登録し直す。トークンは変わるものとして扱う。
- 複数のワークスペース (サーバー) にサインインしている場合、同じトークンを各サーバーに登録する。
  トークンが変わったら全ワークスペースに登録し直す (WORKSPACES.md §8)。
- プロバイダから「無効なトークン」が返ったら `push_token = NULL`、`push_token_invalid_reason` を記録する。
  端末行自体は有効のまま。再登録で復活する。
- 1 ユーザーが複数端末・複数トークンを持つ前提。
- Desktop / Web はトークンを持たないが、セッションが最初にオンラインになるたびに `device_name` と `app_version` だけを
  `PUT /devices/current` で送り直す (更新後の版と端末名がログインし直さなくても「ログイン中の端末」に出る。2026-10-04)。
  端末名は `navigator.platform` (どの Mac でも "MacIntel") ではなく、デスクトップ版は「Mac (コンピュータ名)」/
  「Windows (COMPUTERNAME)」(Rust の `computer_name`: macOS は `scutil --get ComputerName`)、ブラウザは
  「Mac (Safari)」「Windows (Edge)」のように user agent から (`apps/desktop/src/platform/deviceName.ts`)。

### iOS の配布形態と APNs 環境

iOS アプリは App Store ではなく Xcode から登録済み実機に直接インストールする (CLAUDE.md)。
この場合の APNs 環境は **sandbox** (development 用プロビジョニングプロファイル) になる。
端末ごとに `push_environment` を持ち、`APNsPushProvider` はその値でホスト
(`api.sandbox.push.apple.com` / `api.push.apple.com`) を切り替える。サーバ側の固定設定にしない。
Ad Hoc / TestFlight / App Store に切り替えた端末は `production` として登録し直す。
プッシュには有料の Apple Developer Program と Push Notifications capability が必要。

## 4. 通知対象の判定 (PushPlanner)

対象イベントは `message.created` のみ (v1)。受信者は次の順で絞り込む。

通知の level (M35) は、チャンネル自身の `notification_preferences.level` があればそれ。無ければ (行が無い、または
NULL) 本人の全体設定 `users.notification_default` (`all` / `mentions` / `none`、初期値 `all`。2026-10-02 の移行 0060 から。それより前に作った人は `mentions` のまま) から:

| 全体設定 | DM / グループ DM | 他の人の times (M24) | ほかのチャンネル |
| --- | --- | --- | --- |
| `all` | `all` | `mentions` | `all` |
| `mentions` | `all` | `mentions` | `mentions` |
| `none` | `none` | `none` | `none` |

全体設定はプッシュだけに効く (未読の規則には入らない。SYNC_PROTOCOL.md §10.5)。クライアントの画面は「既定 (全体設定)
/ すべて / メンションのみ / 通知しない」と「ミュート」(解除するまで) と「8 時間ミュート」(期限つき) を出す。

| 条件 | 判定 | 実装時期 |
| --- | --- | --- |
| 送信者本人 | 除外 | M5 |
| 受信者が送信者をブロックしている (M104、docs/MODERATION.md §4) | 除外 (メッセージ・メンション・スレッドの返信のすべて。`reaction.added` はリアクションした人、`canvas.mentioned` は `by_user_id` で同じく除外。開いているアプリの通知も 3 クライアントで同じ) | M104 |
| `type = system` のメッセージ (M88 の参加・退出の一言、docs/MEMBERSHIP.md) | 除外 (PushPlanner が `message.type` を見て捨てる。アプリ内の通知も同じ: `notify-rules.json` の `system_messages`) | M5 (表) / M88 (実装。それまで system のメッセージは作られなかった) |
| `level = none`、`muted` (M35、解除するまで)、または `muted_until > now()` | 除外 | M5 / M35 |
| 本文に本人の `notify_keywords` のどれかが含まれる (大文字小文字を区別しない部分一致、送信者自身は除く、M12g) | `messages.keyword_user_ids` に入り、`level = mentions` でも通知され、未読の mention_count と `GET /mentions` にも数えられる。この列はクライアントに送らない (他のメンバーに本人のキーワードが分かってしまうため。M16a)。PushPlanner は行から読む | M12g / M16a |
| `reaction.added` (M39、自分の投稿へのリアクション) | 本人が `notify_reactions` をオンにしているときだけ `kind = reaction` (タイトル「〇〇 がリアクションしました」、サブタイトルはチャンネル、本文は絵文字と投稿の抜粋。ラベルのあるカスタム絵文字 (テキスト絵文字・パック絵文字) は `:name:` ではなく「【ラベル】」、`channel_id` / `message_id` でその投稿を開く)。その会話の level が none・ミュート中・DND・別端末でアクティブなら出さない。既読の再判定はしない (seq が無い) | M39 |
| `reminder.updated` (status=fired、M12e) | 本人の端末へ `kind = reminder` (タイトル「リマインダー」、本文はメモ + 設定時の本文、`channel_id` / `message_id` で該当メッセージを開く)。DND 中は出さない | M12e |
| `calendar.alarm.updated` (alarm.status=fired、M51) | 本人の端末へ `kind = calendar` (タイトル「予定」、本文「14:00 ゼミ (#m2-進捗)」、終日は「終日 学会 (#…)」、前日の通知は先頭に「明日 」(2 日以上前なら「10/3 」)、自分用はチャンネル名なし。時刻は通知を付けた端末の `tz` で書く)。`channel_id` (自分用は null) と `event_id` で予定を開く。`collapse_key = calendar:<event_id>`。本文は送る時点の予定から作る。DND 中は出さない (リマインダーと同じく、後で送り直さない)。`PUSH_INCLUDE_CONTENT=false` なら本文は「予定の時間です」 | M51 |
| `task.assigned` (M55、ほかの人が自分をタスクの担当に加えた) | 本人の `notify_tasks` (既定オン) がオンのときだけ `kind = task` (タイトル「タスク」、本文「〇〇 がタスクを割り当てました: 題名 (#チャンネル)」)。`channel_id` と `task_id` でそのタスクを開く。`collapse_key = task:<task_id>`。リアクションと同じく、その会話の level が none・ミュート中・DND・別端末でアクティブなら出さない。計画の時点でタスクが消えている・完了していれば出さない。自分で自分を加えたときはイベント自体が無い | M55 |
| `task.due` (M55、担当のタスクの期限の日の 8:00) | `notify_tasks` がオンのときだけ本人の端末へ `kind = task` (タイトル「タスク」、本文「今日が期限: 題名 (#チャンネル)」、自分用はチャンネル名なし)。worker (リマインダー・予定と同じループ) が `task_due_alarms` の時刻 (期限の日の 8:00、本人のゾーン: 変更した端末の `tz` → おやすみ時間のゾーン → Asia/Tokyo) に 1 回だけ発火する。予定の通知と同じく、会話の level・ミュートは見ず、DND 中は出さない (後で送り直さない)。未完了・担当のまま・メンバーのまま・アーカイブされていないことを送る直前に確かめる。`PUSH_INCLUDE_CONTENT=false` なら本文は「タスクが割り当てられました」/「今日が期限のタスクがあります」。M81: 時刻付きの期限 (`due_at`) はその時刻に 1 回、本文「14:00 が期限: 題名」(時刻は通知の行のゾーン、隠すときは「期限のタスクがあります」) | M55 |
| `canvas.mentioned` (M72、キャンバスの保存で新しくメンションされた。CANVAS.md §18.1) | `kind = canvas` (タイトル「キャンバス」、サブタイトル「#チャンネル」(DM は無し)、本文「〇〇 が「題名」であなたをメンションしました」)。`channel_id` と `canvas_id` でそのキャンバスを開く。`collapse_key = canvas:<canvas_id>`。メッセージのメンションと同じく、その会話の level が none・ミュート中・DND・別端末でアクティブなら出さない (level が mentions なら出す)。計画の時点でキャンバスがゴミ箱にある・本人が会話から抜けていれば出さない。`PUSH_INCLUDE_CONTENT=false` なら本文は「キャンバスでメンションされました」。アクティビティには入れない (CANVAS.md §18.1) | M72 |
| `reservation.notice` (M112、共有枠の予約の知らせ。RESERVATIONS.md §5) | 本人の端末へ `kind = reservation` (タイトル「予約」、本文は知らせの 1 行 (担当者の作業ならアドレスを含む)、`pool_id` で「予約」のページを開く)。`collapse_key = reservation:<item_id>`。DND 中・別端末でアクティブ (開いている端末がバナー / 通知を出す) なら出さない。計画の時点で項目が済んでいれば (ほかの担当者が対応した) 出さない。チャンネルの level・ミュートは見ない (会話のものではない)。`PUSH_INCLUDE_CONTENT=false` なら本文は「予約のお知らせがあります」。M99 のボットからの DM はやめた | M99 → M112 |
| `wiki.mentioned` / `wiki.shared`（M120、ドキュメントのページで新しくメンションされた / 名前を挙げて共有された。docs/WIKI.md §9.3） | 本人の端末へ `kind = page`（タイトル「ドキュメント」、本文「〇〇 が「題名」であなたをメンションしました」/「〇〇 が「題名」を共有しました」）。`page_id` でそのページを開く。`collapse_key = page:<page_id>`。計画の時点で本人がそのページを読めない（権限が変わった・ゴミ箱）なら出さない。DND 中・別端末でアクティブ・`by_user_id` をブロックしていれば出さない。`PUSH_INCLUDE_CONTENT=false` なら本文は「ドキュメントでメンションされました」/「ドキュメントが共有されました」。アクティビティには `page_mention` / `page_shared`（`include` で頼んだ端末だけ） | M120 |
| 本人の `dnd_until > now()`、または quiet hours の時間帯 (本人のタイムゾーン、`users.quiet_hours_*`) | 除外 (M12c 「通知を一時停止」。バッジは次のプッシュ / 起動時に追いつく) | M12c |
| `level = all` | 対象 | M5 |
| `level = mentions` | `mentioned_user_ids` か `keyword_user_ids` に含まれる、または `mention_all` の時だけ対象 | M8a (実装済み) |
| スレッドだけの返信 (チャンネルにも送信したものを除く) | `level = all` でも、フォロワー (下の行) とメンションされた人だけ (2026-10-02: 既定を `all` にしたので、参加していないスレッドの他人同士のやり取りでは起こさない。Slack と同じ) | 2026-10-02 |
| スレッド返信 | 上記に加え、スレッドのフォロワー (`thread_follows.following`: 親の投稿者、返信者、スレッド内でメンションされた人。手動で外した人は含まない) を対象 (level が `none` でなければ) | M8c → M11a (実装済み。`message.created` の `parent_thread.participant_ids` から判定、THREADS.md §4) |
| 既に既読 (`last_read_seq >= message.seq`) | 除外。スレッドの返信 (チャンネルにも送信したものを除く) は `thread_follows.last_read_seq` で判定する (Desktop でスレッドを読んだ返信がスマホに届いていた。M28a) | M8b (実装済み。送信直前にも再判定し `skipped / already_read`。返信の再判定のために `push_deliveries.payload` に `parent_id` を添える) |
| 有効なセッションの無い端末 (期限切れ) | 送信直前に除外 (`skipped / session_expired`)。1 時間ごとの掃除がその端末を無効にする (DATA_MODEL.md devices) | M28a |
| 別端末でアクティブ (§4.1) | 除外 | M5 |
| `push_token` を持つ有効な端末が無い | 除外 (Desktop のみのユーザー) | M5 |

### 4.1 アクティブ判定

WS の `ping` フレームに `{ "active": true|false }` を持たせ、クライアントはウィンドウがフォーカスされている /
アプリがフォアグラウンドの時に `true` を送る。Hub は**接続ごとに**「最後に active だった時刻」を
メモリに持ち、**接続中の端末のどれかが 60 秒以内に active なら「ユーザーは今画面を見ている」と見なしてプッシュを出さない**
(Slack の「デスクトップで操作中はモバイルに通知しない」に相当)。

クライアントはアプリがバックグラウンドになった / ウィンドウがフォーカスを失った瞬間に `active: false` の `ping` を
送り (次のハートビートを待たない)、その接続の活動はその場で終わる。接続が切れた端末の活動も数えない。
以前は user ごとの時刻を切断後も残していたため、iPhone でアプリを閉じてから 60 秒間は、閉じた iPhone 自身の
操作のせいで DM の通知が届かなかった (2026-09-28 修正)。

Desktop / Web はウィンドウにフォーカスがあっても、5 分間キー・ポインタ・ホイール・タッチの操作が無ければ使っていない
(離席) と見なし、その時点で `active: false` を送る (platform/idle.ts)。以前はフォーカスがあるだけで使用中とされ、
開いたまま机に置いた PC がスマホへのプッシュを止め続けていた (2026-09-29)。離席中は開いている会話を既読にせず
(Desktop の通知も出る)、操作が戻った時に画面の会話を既読にし直す。

Hub は接続した時点を使用中と数える。使っていない状態で接続したクライアント (バックグラウンドのウィンドウがスリープ
明けに再接続した、プッシュで起こされたアプリなど) は `hello` の直後に `active: false` の `ping` を送る (3 端末)。
以前は最初のハートビートまでの 30 秒間、その人へのプッシュが止まっていた。

この状態はプロセスローカル (ARCHITECTURE.md §7)。Redis 導入時に外出しする。

### 4.2 バッジ (iOS)

`badge` = 受信者の「DM の未読数 + チャンネルのメンション数」の合計を計画時に数える (M8b で実装。受信者ごとに payload を作る)。
近似値でよい。アプリは起動時に bootstrap の値でバッジを上書きする。
アクティビティ (MOBILE_UI.md §6.4) の未読の数は含めない (3 クライアントのアイコンのバッジも会話の数だけ。メンションは
会話のメンション数に入っていて、二重に数えないため)。会話の既読位置で数えるので、会話・スレッドで読んだメンションは
アクティビティのバッジと同じく次のプッシュの `badge` からも消える (2026-10-06、`tests/test_activity_read_rule.py`)。
未読数は受信者ごとに 1 つのクエリでまとめて数える (`reads.counts_for_user`、bootstrap と同じ)。以前はチャンネルごとに
1 クエリで、`@channel` の 1 通が outbox リレーのトランザクションの中で 受信者 × チャンネル 回のクエリになっていた (M28a)。
複数のワークスペースを使う端末では各サーバーが自分の分だけの値を付けるので、アプリは全ワークスペースの
合計で上書きする (WORKSPACES.md §6)。

## 5. ペイロード

`push_deliveries.payload` に格納する共通形式。プロバイダ実装がそれぞれの形式に変換する。

```json
{
  "kind": "message",
  "workspace_id": "…",                 // 送ったデプロイ (WORKSPACES.md §3.3)。タップをワークスペースに振り分ける
  "channel_id": "…", "message_id": "…", "seq": 1533,
  "title": "#general",                 // DM なら相手の表示名
  "subtitle": "Alice",                 // チャンネルの場合の送信者。DM では省略
  "body": "本文の先頭 200 文字",         // PUSH_INCLUDE_CONTENT=false なら "新しいメッセージ"。重要度 (M15e) があれば先頭に "[重要] " / "[緊急] "
                                        // 本文が無く添付だけなら、送ったもの (2026-09-30): すべて画像 → "画像を送信しました" / "画像を n 枚送信しました"、
                                        // すべて動画 → "動画を送信しました" / "動画を n 本送信しました"、ほか → "ファイルを送信しました" / "ファイルを n 件送信しました"。
                                        // クライアントの通知と一行の抜粋 (スレッドの親など) も同じ言葉を使う
                                        // 通話を始めたメッセージ (message.call がある) は本文の代わりに "🎧 <送った人> さんが通話を始めました" (M130 の LiveKit の通話。M117 は 📞)
                                        // (受け手の言語。URL は入れない。PUSH_INCLUDE_CONTENT=false でも同じ。届け先はふつうのメッセージと同じ。参加・退出・終了は送らない。docs/CALLS.md §6)
  "badge": 3,
  "collapse_key": "<channel_id>",
  "sent_at": "2026-09-25T13:00:00Z",
  // §16 (2026-10-06): 送った人と会話。sender_avatar_path は PUSH_INCLUDE_CONTENT=true のときだけの署名つきのパス
  "sender_id": "…", "sender_name": "Alice", "sender_avatar": "<avatar_updated_at>",
  "sender_avatar_path": "/api/v1/users/…/avatar/signed?v=…&exp=…&sig=…", "channel_type": "public"
}
```

行にはこの他に `expires_at` (有効期限) と、スレッドの返信なら `parent_id` (送信直前の既読の再判定に使う。M28a) を
payload と並べて保存する。プロバイダは `parent_id` も端末へ送り (APNs の本体、FCM の data)、返信の通知をタップすると
そのスレッドが開く (M28d。以前はチャンネルだけが開いた)。`kind = calendar` (M51) は `event_id` も送る (APNs の本体、FCM の
data)。`kind = task` (M55) は `task_id` を送る (同じく。自分用のタスクは `channel_id` が null)。`kind = canvas` (M72) は `canvas_id`
を送る (同じく)。`kind = reservation` (M112) は `pool_id` を送り (同じく、`channel_id` は null)、タップで「予約」のページを開く。
`kind = page`（M120）は `page_id` を送り（同じく、`channel_id` は null）、タップでドキュメントのページを開く（M122）。
`kind = test` (§15) は会話を持たず、タップでアプリを開くだけ。クライアントは知らない項目を無視する。

| 項目 | APNs | FCM (Android) |
| --- | --- | --- |
| 種別 | `apns-push-type: alert`、`apns-priority: 10`、`apns-topic: <bundle id>` | data-only メッセージ、`android.priority: HIGH` |
| 表示 | `aps.alert = {title, subtitle, body}`、`aps.sound = default`、`aps.badge`、`aps.thread-id = channel_id`。人のメッセージは `aps.mutable-content = 1` で Notification Service Extension が送った人のアイコンの通信の通知にする (§16) | アプリが `onMessageReceived` で通知を組み立てる。`tag = channel_id`。人のメッセージは MessagingStyle と会話のショートカット (§16) |
| 畳み込み | `apns-collapse-id = channel_id` | `android.collapse_key = channel_id` |
| 有効期限 | `apns-expiration = expires_at (unix)` | `android.ttl = 残り秒数` |
| データ | `aps` の外に上記 JSON をそのまま | `data` に文字列化して格納 |

Android を data-only にする理由: 通知の見た目・グルーピングをアプリで制御し、受信時に軽い同期を
走らせるため。iOS は APNs を直接使い、Firebase SDK に依存しない。

サイレントプッシュ (`kind = silent`、既読同期による通知消去など) は
APNs `content-available: 1` / `apns-push-type: background` / priority 5、FCM data-only / priority NORMAL。
v1 では使わない (§12)。

**言語 (M115)**: 題と本文 (「グループ DM」「添付ファイル」「誰か」などの補いも) は端末ごとに `users.locale` → `devices.locale`
(その端末がログイン・トークンの更新・`PUT /devices/current` で送った `Accept-Language`) → ja で作る。同じ通知でも端末ごとに
言語が違いうるので、ペイロードは (受け手, 言語) ごとに作る。チャンネル名・送った人の名前・本文の抜粋は訳さない (docs/I18N.md §1)。

## 6. 送信・再試行

| 項目 | 値 |
| --- | --- |
| 有効期限 | 計画時刻 + 10 分 (`PUSH_ALERT_TTL_SECONDS`)。過ぎたら `skipped`。10 分後に届く通知は役に立たない |
| 再試行間隔 | 30 秒 → 2 分 → 10 分 (有効期限に収まる範囲で)。それ以上は `failed` |
| 同時送信数 | 10 |
| 送信前の再判定 | 既読済み (返信はスレッドの既読位置) ならスキップ。端末が無効 / トークン無し、有効なセッションが無い (`session_expired`) ならスキップ |

## 7. 重複・欠落・遅延への対応

| 問題 | 起こる場面 | 対策 |
| --- | --- | --- |
| 同じ通知が 2 回計画される | Relay が outbox を再処理 | `UNIQUE (event_id, device_id)` で 1 行に |
| 同じ通知が 2 回送られる | Sender が送信後・状態更新前に落ちる | `collapse_key` (チャンネル単位) で端末側が 1 つに畳む |
| 通知が届かない | プロバイダ側の破棄、端末オフライン、トークン失効 | アプリ起動 / 復帰時に必ず同期する。未読はサーバに残っているので失われない。失効トークンは NULL にして再登録を待つ |
| 遅れて届く | 端末のスリープ、プロバイダの遅延 | `expires_at` で古いものは送らない。既読済みなら送らない。届いた通知のタップ時は必ず最新を同期してから表示する |
| 順序が入れ替わる | プロバイダは順序を保証しない | 通知の順序に意味を持たせない。畳み込みで最新だけ見せる |
| 別端末で既に読んだ | Desktop で読んでいる間にモバイルに来る | 計画時と送信直前の既読チェック。アクティブ判定 (§4.1)。届いてしまった分の消去はサイレントプッシュで将来対応 (§12) |
| プロセス障害で送信が止まる | app プロセスの再起動 | `push_deliveries` は永続。再起動後に pending から再開 |

## 8. プロバイダ抽象

```python
class PushProvider(Protocol):
    provider: Literal["apns", "fcm"]

    async def send(self, device: Device, notification: PushPayload) -> PushResult: ...

@dataclass
class PushResult:
    outcome: Literal["sent", "retry", "invalid_token", "failed"]
    detail: str | None = None
    retry_after: timedelta | None = None
```

| 実装 | 用途 |
| --- | --- |
| `APNsPushProvider` | HTTP/2 + JWT (ES256, `.p8` キー)。`httpx` の HTTP/2 で直接叩く。端末の `push_environment` で sandbox / production のホストを切り替える。M5 |
| `FCMPushProvider` | FCM HTTP v1。サービスアカウント鍵 (JSON) から JWT bearer grant で OAuth2 アクセストークンを取得する (PyJWT の RS256。`google-auth` は不要)。data-only メッセージ、`android.priority` HIGH / NORMAL、`ttl`、`collapse_key`。M7 |
| `LogPushProvider` | 開発用。ログに出すだけ。設定が無い時の既定 |
| `FakePushProvider` | テスト用。呼び出しを記録する |

### プロバイダ応答の対応表

| プロバイダ応答 | outcome |
| --- | --- |
| APNs 200 | `sent` |
| APNs 400 `BadDeviceToken` / 410 `Unregistered` | `invalid_token` → `push_token = NULL` |
| APNs 403 (認証トークン不正) | `retry` (Provider が JWT を再生成) + エラーログ (設定ミスの可能性) |
| APNs 429 / 5xx | `retry` |
| APNs 413 (payload 大きすぎ) | `failed` (実装バグ) |
| FCM 200 | `sent` |
| FCM 404 `UNREGISTERED` / 400 `INVALID_ARGUMENT` (token) | `invalid_token` |
| FCM 401 / 403 | `retry` + エラーログ |
| FCM 429 `QUOTA_EXCEEDED` / 500 / 503 | `retry` (`Retry-After` を尊重) |

Provider の選択は起動時に設定から決め、`notifications` モジュール内のレジストリ
(`push_provider → PushProvider`) に登録する。設定が無いプロバイダは `LogPushProvider` になる。

## 9. クライアント側の挙動

| 場面 | iOS | Android |
| --- | --- | --- |
| 通知受信 (バックグラウンド) | OS が表示。`thread-id` でチャンネルごとにグループ化 | `onMessageReceived` で通知を表示 (`tag = channel_id`、チャンネルの通知チャネル)。可能なら軽い同期 (WorkManager) |
| 通知受信 (フォアグラウンド) | 開いている会話の通知は表示しない (WS で受信済み)。同じワークスペースの他の会話と、他のワークスペースの通知は表示する (WORKSPACES.md §7) | アクティブなワークスペースのプッシュは表示しない (WS から自前で通知を出すため)。他のワークスペースの通知は表示する |
| 通知タップ | `workspace_id` のワークスペースに切り替え、該当チャンネルを開き、通常の起動同期 (WS → bootstrap → catch_up) の後に表示 | 同左 |
| アプリ起動 / 復帰 | トークン登録 (§3)、バッジを bootstrap の値で更新、当該チャンネルの通知を消去 | 同左 |
| ログアウト | 何もしなくてよい (サーバがセッション失効時に端末を無効化) | 同左 |

アプリ内・OS の通知 (Desktop の通知、Android の WS からの通知、iOS の判定) も §4 と同じ規則で決める。スレッドだけの返信は
`level = all` でもフォロワー (`parent_thread.participant_ids`) とメンション・キーワード・`@channel` の相手だけ、手動でフォローを
外したスレッドは何も出さない (端末は「メンション・キーワードに当たったのに participant_ids にいない」ことから手動の解除と
判断する。メンションされた人は自動でフォローされるため。`@channel` だけのときは区別できず通知する)。共通のケースは
`apps/shared/notify-rules.json` (サーバの `tests/test_notify_rules.py` と 3 端末のテストが読む。2026-10-02)。

### 9.1 Desktop の OS 通知の出し方 (2026-10-04)

`apps/desktop/src/platform/notify.ts` の `notify()` / `notificationPermission()` / `requestNotificationPermission()` /
`clearNotifications()` をすべての呼び出し (新着・リマインダー・予定・タスク (M55 のクリックで開く)・キャンバス・リアクション・
テスト通知) と設定の「この端末の通知」が通る。

- **macOS のアプリ (Taylis.app)**: Rust の `native_notification_*` (`src-tauri/src/mac_notify.rs`) で
  **UNUserNotificationCenter** を使う。tauri-plugin-notification は macOS で notify-rust → mac-notification-sys の
  非推奨の NSUserNotificationCenter を使い、その delegate に `shouldPresentNotification:` が無いため、Taylis が前面の
  間はバナーを出さず通知センターに入れるだけだった (v0.1.33 で「テスト通知が 1 度だけ出て、その後出ない」)。また許可の
  確認・要求はデスクトップでは常に「許可」を返していた。いまは delegate の `willPresentNotification:` がバナー + 一覧 +
  音を返し、許可は UN の `authorizationStatus` (未決定 → `default`、拒否 → `denied`、それ以外 → `granted`) をそのまま
  設定に出し、「通知を許可」は `requestAuthorization` (初回は macOS の確認)。設定はウィンドウが前面に戻るたびに読み直す
  (システム設定で変えた後)。通知のクリックはウィンドウを前に出し、`notification-clicked` (通知の id) で画面の
  `onClick` を実行する (新着はそのメッセージ (返信ならスレッド)、リアクションは自分のメッセージ、タスク・キャンバス・予約はそれぞれの画面を開く。他のワークスペースの通知は先にそのワークスペースへ切り替える (WORKSPACES.md §7)。古い id は窓を出すだけ)。ログアウトで配信済みの通知を消す
  (`removeAllDeliveredNotifications`)。
- **それ以外** (Windows、Linux、アプリのバンドル外で動く macOS の `tauri dev`、macOS 10.13): UN はバンドルが無いと
  例外になるので使わず (`available()` が偽 → `"unavailable"`)、これまでどおり tauri-plugin-notification。
  コマンドが失敗したときもプラグインに戻る。
- UN は署名の無い / ad-hoc 署名のビルドでは許可を拒まれることがある (その場合は「ブロック中」と出るだけで落ちない)。
  配布する Developer ID 署名のビルドでは問題ない。

### 9.2 Desktop：ウィンドウを閉じてもバックグラウンドで動かす (2026-10-07)

デスクトップ版の通知はアプリが自分で出す (プッシュではない) ので、アプリが終了していると届かない。v0.1.38 までは macOS で
ウィンドウを閉じるとアプリまで終了していた (利用者の報告)。Slack と同じく、ウィンドウを閉じてもアプリは動き続け、
WebSocket・通知・バッジはそのまま働く。実装は `apps/desktop/src-tauri/src/background.rs`。

- **閉じる**：メインウィンドウの `CloseRequested` (閉じるボタン、⌘W、Alt+F4、Windows の自前の閉じるボタン) を
  `prevent_close` してウィンドウを隠すだけ。位置と大きさは隠す前のまま戻る。macOS でフルスクリーンのときは空の
  操作スペースが残らないようアプリごと隠す (`AppHandle::hide`)。
- **戻す**：macOS は Dock のアイコンのクリック、Taylis をもう一度開く (Finder・Spotlight・`open`) (どちらも
  `RunEvent::Reopen`)、メニューの「Window」→「ウィンドウを表示」、通知のクリック。Windows は通知領域 (システムトレイ) の
  アイコン (アプリのアイコン) の左クリック・ダブルクリック、そのメニューの「Taylis を開く」、もう一度起動する
  (tauri-plugin-single-instance が既存のウィンドウを出す。ディープリンクのために以前から入っている)。
- **終了**：終了は横取りしない。⌘Q・アプリのメニューの終了・Dock の「終了」・ログアウトやシステムの終了
  (macOS はウィンドウに尋ねずにアプリを終える)、トレイの「終了」 (`AppHandle::exit`)、アプリ内アップデートの再起動
  (`relaunch` → `AppHandle::restart`) はどれも終了コード付きの終了要求になり、そのまま通る。止めるのはウィンドウの
  `CloseRequested` だけ。Windows のインストーラはアップデーターがプロセスを終えてから動く。
- **初回の案内 (Windows)**：初めてトレイに隠れたとき、1 回だけ「Taylis は通知領域で動き続けます」の通知を出す
  (Slack と同じ。済んだことは下のファイルに記録)。
- **設定**：設定 →「通知」→「この端末の通知」の「ウィンドウを閉じてもバックグラウンドで動かす」 (既定はオン、両 OS)。
  端末ごとの設定で、アプリの設定フォルダの `window.json` (`runInBackground`、`trayHintShown`) に Rust 側が保存する
  (ページが読み込まれる前の閉じる操作にも効く)。オフにすると閉じる操作はそのまま通り、最後のウィンドウが閉じて
  アプリが終了する (macOS も Windows も)。
- **言語**：トレイのメニュー・macOS の「ウィンドウを表示」・初回の案内の文言は、ページが起動時と言語の変更のたびに
  `shell_labels_set` で送る (`src/platform/background.ts`)。それまでは日本語。
- **隠れている間の WebView**：macOS (14 以降) の WKWebView は、見えないビューの処理を約 5 分後に止める (既定の
  suspend)。隠したウィンドウでも WebSocket と 30 秒ごとの `ping` が止まらないよう、`tauri.conf.json` のウィンドウに
  `"backgroundThrottling": "disabled"` を指定する。Windows (WebView2) にはこの設定が無いが、隠れたページもタイマーが
  間引かれるだけで止まらず、WebSocket の受信は遅れない (最小化と同じ扱い)。

試験 (macOS、2026-10-07)：識別子を変えたビルド (`identifier` と `productName` を別の `--config` で上書き) で、閉じる
ボタン・⌘W → プロセスは残りウィンドウは消える、Dock のクリック・`open`・「ウィンドウを表示」→ 同じ位置と大きさで戻る、
フルスクリーンで閉じる → アプリごと隠れて Dock で戻る、隠れている間に `osascript -e 'tell application "…" to quit'`
→ 終了する、設定をオフ → 閉じるとプロセスが終わる、を確かめた。Windows はデスクトップの CI でビルドし、次を手で確かめる：
閉じるボタン・Alt+F4 → タスクバーから消えて通知領域にアイコン、初回だけ案内の通知、アイコンの左クリック・ダブル
クリック・「Taylis を開く」→ 戻る、隠れている間も新着の通知が出る、通知のクリックで戻る、もう一度起動 → 既存の
ウィンドウが出る (2 つ目のプロセスは残らない)、「終了」→ アイコンもプロセスも消える、設定をオフ → 閉じると終了、
アプリ内アップデートの「更新して再起動」が止まらない。

## 10. 設定

```
PUSH_APNS_ENABLED=false
PUSH_APNS_KEY_PATH=/run/secrets/apns_key.p8     # 秘密鍵はコミットしない
PUSH_APNS_KEY_ID=
PUSH_APNS_TEAM_ID=
PUSH_APNS_BUNDLE_ID=
PUSH_FCM_ENABLED=false
PUSH_FCM_SERVICE_ACCOUNT_PATH=/run/secrets/fcm_service_account.json
PUSH_INCLUDE_CONTENT=true          # false で本文をプッシュに含めない
PUSH_ALERT_TTL_SECONDS=600
PUSH_ACTIVE_WINDOW_SECONDS=60
```

Team ID、Key ID、Bundle ID、鍵の場所はすべて環境変数または秘密ファイルから読む。

## 11. テストと運用

- `PushPlanner` の判定はユニットテスト (ルール表 §4 を 1 行 1 ケースで)。
- `PushSender` は `FakePushProvider` で at-least-once とリース、backoff、トークン無効化を検証。
- 実機確認: `uv run python -m app.cli push-test --user <username>` でテスト通知を送る。利用者は設定の「通知」の
  「テスト通知を送る」で自分の端末に送れる (§15)。
- iOS は Apple Developer Program と実機が必要 (シミュレータは APNs を受け取れない)。
  Android は Google Play services 入りのエミュレータで確認できる。
- 監視: `push_deliveries` の `failed` 件数と `attempts` の分布をログに出す。

## 12. 将来の拡張 (今はやらない)

- 既読同期による通知の消去: `read.updated` からサイレントプッシュを計画し、端末側で当該チャンネルの
  通知を消す。`push_deliveries.kind = silent` の置き場所だけ用意してある。
- 通知の詳細設定 UI (quiet hours、キーワード通知)。判定ルール (§4) と `notification_preferences` の列追加で済む。
- Desktop への Web Push: Web クライアントを作る時に検討。

## 13. 実装メモ (M5)

- サーバ: `app/modules/notifications/` (planner / sender / providers / service / router)。Planner は `OutboxRelay` の
  永続ハンドラとして `main.py` で注入され、Sender は lifespan の背景タスク。設定は `PUSH_*`。
- `push-test` CLI: `uv run python -m app.cli push-test --user <username>` (compose では `docker compose exec app python -m app.cli push-test --user <username>`)。
- iOS: `AppDelegate` がトークンを受け取り `PushCenter` が `PUT /devices/current` で登録する。`aps-environment` は
  `ChikuwaChat.entitlements` で development (= sandbox)。埋め込みプロビジョニングプロファイルから環境を判定する
  (Xcode から入れたビルドは sandbox、Ad Hoc は production)。App Store / TestFlight のビルドには埋め込みプロファイルが
  無いので production とする (以前は sandbox と判定し、TestFlight の端末に通知が届かないところだった。2026-09-27 修正)。
  シミュレータは sandbox。
- M8 で追加するもの: メンション時の通知 (`level = mentions`)、既読チェック、バッジの正確な数。

## 14. 実装メモ (M7)

- サーバ: `FCMPushProvider` (`providers.py`)。`build_providers` は `PUSH_FCM_ENABLED=true` のとき
  `PUSH_FCM_SERVICE_ACCOUNT_PATH` の JSON から生成する。アクセストークンは有効期限の 60 秒前に更新、
  401 / 403 ではトークンを捨てて `retry` (設定ミスをエラーログ)。`Retry-After` を尊重する。
  応答の対応表 (§8) を `tests/test_fcm_provider.py` で固定している。
- Android: `ChikuwaMessagingService` (`onNewToken` → `PushCenter.tokenReceived`、`onMessageReceived` →
  `AppController.handlePush`)。`PushCenter` はセッション開始時と復帰時にトークンを取得し、変わったときと
  新しいセッションのときだけ `PUT /devices/current` (`push_provider = fcm`) を送る。
  data-only メッセージはフォアグラウンドかつ WS 接続中なら表示しない (WS で届く)。それ以外は
  `Notifier` がチャンネルごとの通知 (id = channel_id) を出し、タップで該当チャンネルを開く。
  `google-services.json` が無いビルドでは Firebase が初期化されず、登録は静かにスキップされる。
- 未確認: 実際の Firebase プロジェクトでの受信 (infra/README.md の手順でユーザー側が設定する)。

## 15. テスト通知 (「テスト通知を送る」、2026-10-04)

利用者の要望「通知をテストで送信する機能が欲しい」: 自分の端末に通知が届くかを、設定の「通知」から確かめる。

### サーバ: `POST /api/v1/users/me/test-notification`

- 自分の端末 (`devices`) ごとに結果を返す。有効で push_token のある iOS / Android の端末には、**その場で** (リクエストの中で)
  通常のプロバイダ (`app.state.push_providers`、§8) から送る。`push_deliveries` は作らない (再試行も無い。結果をすぐ返すため。
  失敗はそのまま `failed` と理由で返す)。並列に送り、1 台の例外が他の結果を隠さない。
- ペイロード (§5): `kind = test`、`title = "Taylis"`、`body = "テスト通知です。この端末に通知が届いています。"`、`channel_id` などは無し、
  `collapse_key = "test"`、`badge` は §4.2 の今の数 (テストでアイコンの数字を変えない)、`expires_at` は §6 と同じ。
- **無視するもの**: 会話のミュート、通知のレベル (全体の「なし」も)、おやすみモード / 通知を止める時間帯 (DND)。押した本人が
  求めた通知なので送る。DND 中だったことは応答の `dnd_active` で知らせ、クライアントが「通知を一時停止中ですが、テスト通知は送りました」と出す。
- **守るもの**: 端末が有効であること。ログアウトした端末 (`enabled = false`) と有効なセッションが無い端末 (§6 の `session_expired`) には送らない。
- APNs の `invalid_token` は Sender と同じく `push_token = NULL` (`push_token_invalid_reason`)、結果は `failed`。
- 応答 `TestNotificationOut`:

  ```json
  {
    "apns_configured": true, "fcm_configured": false,   // PUSH_APNS_ENABLED / PUSH_FCM_ENABLED (LogPushProvider でないか)
    "dnd_active": false, "sent_count": 1,
    "devices": [
      {"device_id": "…", "device_name": "Mac", "platform": "desktop", "push_provider": "none", "current": true,
       "status": "in_app", "detail": null, "last_seen_at": "…"},
      {"device_id": "…", "device_name": "iPhone", "platform": "ios", "push_provider": "apns", "current": false,
       "status": "sent", "detail": null, "last_seen_at": "…"}
    ]
  }
  ```

  | status | 意味 |
  | --- | --- |
  | `sent` | プロバイダが受け付けた (端末に表示されたかまではわからない) |
  | `failed` | プロバイダが拒否した / つながらなかった / 例外。`detail` に理由 (`Unregistered`、`UNREGISTERED`、`transport: …` など) |
  | `no_token` | iOS / Android の端末でトークンが未登録 (OS の通知がオフ、またはアプリをまだ開き直していない) |
  | `not_configured` | このサーバでその端末のプロバイダ (APNs / FCM) が無効。ログに出すだけで送っていない |
  | `in_app` | Desktop / Web: プッシュは無い。開いていれば `notification.test` で OS の通知を出す |
  | `disabled` | ログアウト済み (`detail` = `disabled_reason`: `logout` など) か有効なセッションが無い (`session_expired`) |

  並びは押した端末 (`current`) → 有効な端末 (最終利用の新しい順) → 無効な端末。無効な端末は最終更新が 30 日以内のものだけ、全体で 20 台まで。
- 同じトランザクションで outbox に `notification.test` (audience = 本人、`{title, body, device_id, sent_at}`、`device_id` は押した端末)。
  WS で自分の開いているアプリ全部に届く (SYNC_PROTOCOL.md §6)。
- 速度制限: 1 人 5 回まで続けて、その後は 2 分に 1 回 (トークンバケット、プロセス内)。超えると `429 test_notification_rate_limited`
  (`details.retry_after_seconds`、`Retry-After`)。日本語は errors.json。
- 記録: 監査表には書かず (自分の端末への通知で、ほかの人に影響しない)、`app.push` のログに 1 行 (`user_id`、端末ごとの status)。
- CLI の `push-test` (§11) は管理者用にそのまま残す (任意のユーザー、本文を指定できる)。

### クライアント

- **Desktop / Web** (設定 → 通知 → 「この端末の通知」の下): 「テスト通知を送る」は、まずこの端末の OS の通知を `notify()` で
  すぐ出し (一時停止中でも)、それからエンドポイントを呼んで端末ごとの結果を並べる。上に注意書き: 「このサーバはプッシュ通知が設定されていません」
  / 「iOS のプッシュ (APNs) はこのサーバでは無効です」/「Android のプッシュ (FCM) はこのサーバでは無効です」/「プッシュ通知を受け取れる端末
  (iPhone・Android のアプリ) はありません」/ DND の一文。OS の通知の許可が無ければ、場所の案内 (Web は「通知を許可」かサイト設定、
  macOS は「システム設定」→「通知」→「Taylis」、Windows は「設定」→「システム」→「通知」)。`notification.test` を受けたら OS の通知を出す
  (ほかの端末で押したとき)。自分で押してから 30 秒の間に届いたものはこだまなので出さない。
- **iOS** (自分 → 通知 → 「テスト通知」): ボタンと結果の一覧 (同じ言葉)。通知の許可がオフなら一文で知らせる (上の「設定アプリで変更」)。
  フォアグラウンドで届いた `kind = test` のプッシュは必ずバナーで出す (`Workspaces.shouldPresent`)。タップはアプリを開くだけ (会話を持たない)。
  WS の `notification.test` は無視する (プッシュが届くため)。
- **Android** (自分 → 通知 → 「テスト通知」): 同じ。`kind = test` の data メッセージは、フォアグラウンドで WS がつながっていても通知を出す
  (ほかの kind は WS 側が知らせるので出さない)。通知のキーは `test` で、押すたびに前のものを消してから出す
  (同じキーの更新は `setOnlyAlertOnce` で鳴らないため)。WS の `notification.test` は無視する。
- 結果の言葉は 3 端末で同じ (`testDeviceStatus` / `TestNotificationText`)。

### 試験

サーバ `tests/test_test_notification.py` (トークンのある端末だけに送り他人の端末は触らない・Desktop / トークン無し / ログアウト済み、
APNs が無効なサーバ、プロバイダの失敗と失効トークン、DND とミュートを無視、速度制限と本人ごと、未ログイン、セッションの無い端末、
実サーバの WS で本人にだけ `notification.test`)。Desktop `tests/testNotification.test.tsx`、iOS `TestNotificationTests`、Android `TestNotificationTest`。
実機での APNs / FCM の受信は未確認。

## 16. 送った人のアイコンを出す通知 (Slack / LINE のように、2026-10-06)

利用者の要望: 人からのメッセージの通知は、送った人のアイコンを大きく、アプリのアイコン (リス) を隅に小さく出したい。
それまではどの通知もアプリのアイコンだけだった。

### サーバ: ペイロード

`kind = message` の行 (§5) に足す (古いアプリは知らない項目を無視する):

| 項目 | 内容 |
| --- | --- |
| `sender_id` | 送った人の id |
| `sender_name` | 送った人の表示名 (120 文字まで。DM では題と同じ) |
| `sender_avatar` | アイコンの版 (`avatar_updated_at`)。無ければ null |
| `sender_avatar_path` | アイコンの**署名つきの短命な**パス (下)。`PUSH_INCLUDE_CONTENT=true` でアイコンがあるときだけ。行に入れておき、APNs のプロバイダが端末の `base_url` を前に付けて `sender_avatar_url` として送る |
| `channel_type` | `public` / `private` / `dm` / `group_dm` |

| | APNs | FCM |
| --- | --- | --- |
| 送るもの | `aps.mutable-content = 1` (`kind = message` で `sender_id` があるとき)、`sender_id`・`sender_name`・`channel_type`・`sender_avatar_url` (端末の `base_url` が分かり、パスがあるとき) | data に `sender_id`・`sender_name`・`sender_avatar` (版)・`channel_type`。**署名つきの URL は送らない** (アプリが自分のセッションで取る) |

- 大きさ: 題・小見出し・名前 120 文字、本文 240 文字がすべて日本語 (UTF-8 で 3 バイト) でも 4 KB に収まる
  (`tests/test_push_avatars.py` の最悪の場合の試験)。
- `devices.base_url` (移行 0088): その端末がこのサーバに届くアドレス。`PUT /devices/current` のたびに、`PUBLIC_BASE_URL` が
  あればそれ、無ければ要求の来た URL (リバースプロキシの転送ヘッダーで公開の https のアドレスになる) を入れる。拡張機能は
  資格情報もサーバの一覧も持たないので、絶対 URL が要る。複数のワークスペースでも端末行はサーバごとなのでそのまま正しい。
  NULL (移行の直後、アプリが次に登録するまで) なら URL を送らず、拡張機能はアイコンなしで出す。

### 署名つきのアイコンの URL

`GET /api/v1/users/{user_id}/avatar/signed?v=<版>&exp=<期限 (unix 秒)>&sig=<署名>` はセッション無しで画像を返す。

- 署名: `HMAC-SHA256(SECRET_KEY, "avatar-push\n{user_id}\n{v}\n{exp}")` を base64url (パディングなし)。`v` は
  `avatar_updated_at` のマイクロ秒。期限は計画の時刻 + 24 時間 (プッシュの有効期限は 10 分なので十分)。
- 署名が合わない・期限切れ・別の人・**アイコンが変わった / 消えた** (版が今のものでない) は、どれも 404 `avatar_not_found`
  (違いを教えない)。比較は定数時間。ふつうの `GET /users/{id}/avatar` は今までどおりセッションが要る。
- 発行するのは、その人がメッセージを送った会話のメンバーへのプッシュだけ (ゲストの見える範囲 M13e の内側)。
- `PUSH_INCLUDE_CONTENT=false` では発行しない (URL は Apple を通り、持っている人は期限まで画像を取れるため)。
  名前は今も題 (DM) / 小見出し (チャンネル) に入っているので変えない (この設定は本文を隠すもの)。iOS はそのとき
  アイコンの代わりに既定のアバター（名前の頭文字、§16.1）を出す。Android はアプリのセッションでサーバから直接取るので (Google を通らない)
  設定にかかわらずアイコンを出す。

### iOS: Notification Service Extension と通信の通知 (Communication Notifications)

- ターゲット `NotificationService` (`jp.chikuwachat.ios.NotificationService`、iOS 17、アプリに埋め込み)。
  `mutable-content` の付いたプッシュで動き、`CommunicationNotification.update` (`ChikuwaChat/Platform/CommunicationNotification.swift`、
  アプリと拡張機能の両方に入れ、アプリのテストから確かめる) が:
  1. `kind = message` で `sender_id` と `channel_id` があるときだけ (それ以外はそのまま返す)。
  2. `sender_avatar_url` (http / https のみ) を 5 秒・1 MB・`image/*` の制限で取る。URL が無い・取れないときは
     既定のアバター（§16.1）を描いて使う（2026-10-08）。
  3. `INSendMessageIntent` を作る: 送り手は `INPerson` (表示名、`customIdentifier` = 送った人の id、画像)、
     `conversationIdentifier` = チャンネルの id。チャンネルとグループ DM は `speakableGroupName` = 題 (「#general」/
     「グループ DM」) と受け手 2 人 (自分と会話) でグループとして、1:1 の DM は送った人の会話として。
  4. `INInteraction` (incoming) を寄贈し、`content.updating(from: intent)` を返す。
- どれかが失敗したら (画像が取れない、iOS が断る、時間切れの `serviceExtensionTimeWillExpire`) サーバが書いたままの通知を出す。
  拡張機能は資格情報を持たない (Keychain の共有も App Group も無い)。
- アプリ: `com.apple.developer.usernotifications.communication` の entitlement と Info.plist の
  `NSUserActivityTypes = [INSendMessageIntent]` (拡張機能の Info.plist にも)。
- 拡張機能の版とビルド番号はアプリと同じにする (`NotificationService/Info.plist` と `project.yml` の 2 つ目の
  `CFBundleVersion`)。`StoreReleaseTests` と `release-ios.sh` が食い違いを止める (STORE_RELEASE.md §1)。
- 自分の通知の設定 (「設定」→「通知」→ Taylis) に「通信の通知」が出る。集中モードの「許可された人」にも効く。

### Android: MessagingStyle と会話のショートカット

- data の `sender_id` があるメッセージのプッシュと、アプリが WS から出す新着の通知 (§9) は `Notifier.notifyConversation`:
  `NotificationCompat.MessagingStyle` (自分 = 「自分」/ You / 我、送った人ごとに `Person` (key = id、名前、アイコン))、
  チャンネルとグループ DM は `setGroupConversation(true)` と会話名、`CATEGORY_MESSAGE`、小さいアイコンは今までどおり。
- 長く使う会話のショートカット (`ShortcutInfoCompat`、id = `conv:<ワークスペースの要約>:<channel_id>`、`setLongLived`、`Person`、
  アイコン、タップでその会話を開く `jp.chikuwachat.android.OPEN_CONVERSATION`) を `pushDynamicShortcut` して通知に付ける
  (Android 11 以上の「会話」の欄と見た目)。ショートカットに失敗しても通知は出す。Android 10 以下はアイコンを large icon に。
- アイコン: そのワークスペースのサインイン済みのクライアントで `GET /users/{id}/avatar?v=<版>` を取り (3 秒まで)、128px の丸に
  切ってキャッシュのディレクトリ (`notification-avatars/`、ファイル名は (ワークスペース, 人, 版) の SHA-256) に置く。無い・失敗・遅いときは
  既定のアバター（§16.1、丸に切る）。会話の通知は 1 つずつ順に出す (2 通目が 1 通目を追い越さない)。
- 同じ会話の通知が出ている間は新しい 6 件までを並べる (同じメッセージが WS と FCM の両方から来ても 1 行)。会話を読んだ・
  通知を消したら最初から。サインアウトでショートカット・並べた行・アイコンのキャッシュを消す (そのワークスペースの分だけ、最後の 1 つなら全部)。

### 試験

サーバ `tests/test_push_avatars.py` (署名の往復・改ざん・別の人・期限・別のサーバ、認証なしの取得と 404、アイコンの変更・削除で
古い URL が無効、`base_url` の記録、DM / チャンネル / グループ DM のペイロード、`PUSH_INCLUDE_CONTENT=false` で URL なし、
APNs の `mutable-content` と絶対 URL・URL なし・他の kind、4 KB の最悪の場合、FCM に署名つきのパスを入れない)。
iOS `CommunicationNotificationTests` (DM / チャンネル / グループ DM の intent、画像、他の kind・古いサーバ、名前の補い、
http(s) 以外の URL、失敗時に元の通知)、`StoreReleaseTests` (拡張機能が埋め込まれ版が同じ)。Android `ConversationNotificationTest`
(ペイロード → 会話、MessagingStyle の Person・グループ・会話名、行の重複と上限、ショートカットの id、キャッシュの名前、頭文字)。
**実機での見た目は未確認** (シミュレータは APNs を受け取れない。iOS のグループの見た目 (会話名とアイコンの並び) は iOS の版で違う)。

### 16.1 アイコンの無い人：既定のアバター（2026-10-08）

利用者の要望：アイコン（プロフィール写真）の無い人からの通知は、iOS ではアプリのアイコンしか出なかった。アプリの中と同じ
既定のアバター（名前の頭文字を人ごとの色の上に）を出す。

- **共通の規則**（`apps/shared/avatar-initials.json`、Desktop・iOS・Android の試験が読む）：
  - 文字：名前の前後の空白を除いた最初の 1 文字を大文字に。最初の 2 語（区切りは全角の空白を含む空白）がどちらも ASCII の
    英字で始まるときは 2 語の頭文字（「Toru Kano」→「TK」、「かのう」→「か」、「Toru 2」→「T」）。空なら「?」。
  - 色：利用者の id の UTF-16 の各単位 c について h = (h × 31 + c) mod 2^32、色相 = h mod 360。背景は
    hsl(色相, 55%, 45%)、文字は白の太字（辺の 42%）。
  - これに合わせて、iOS のアプリ内のアバターの色を HSB (0.55, 0.72) から他の端末と同じ hsl(色相, 55%, 45%) に、iOS と
    Android の「2 語目が数字・記号でも 2 文字」を Desktop と同じ「2 語目も英字のときだけ」に揃えた。Android の通知の丸は、
    それまで独自の 8 色（id の SHA-256）と独自の頭文字だったのを、アプリ内と同じ規則にした。
- **iOS**：`InitialsAvatar`（`ChikuwaChat/Platform/InitialsAvatar.swift`、アプリと拡張機能の両方に入れる）が 180 × 180 px の
  PNG（正方形。通信の通知の画像は iOS が丸く切る）を `UIGraphicsImageRenderer` で描く。拡張機能は
  `CommunicationNotification.senderPicture` で、`sender_avatar_url` が無い（アイコンが無い・`PUSH_INCLUDE_CONTENT=false`・
  `base_url` が未記録）か取れないとき、これを送り手の `INPerson` の画像にする。必要なのは `sender_id` と `sender_name` だけで、
  §16 のペイロードにすでにあるのでサーバは変えていない。チャンネル・グループ DM でも画像は送った人のもの（会話の画像は今まで
  どおり無し）。アプリ内の `AvatarView` も同じ `InitialsAvatar` を使う。
- **Android**：`NotificationAvatars` は前から写真が無い・失敗・遅いときに頭文字の丸を描いていた。色と文字を
  `ConversationStyle.colorFor`（hsl(`Timeline.hue`, 55%, 45%)）と `Timeline.initials` に替え、文字を太字・辺の 42% にした。
- **Desktop / Web**：OS の通知（§9.1）は題と本文だけで、送った人の写真をどこにも出していないので変えていない。
- 試験：`apps/shared/avatar-initials.json` を Desktop `avatarInitials.test.ts`、iOS `CommunicationNotificationTests`
  （規則、PNG の大きさと色、写真があればそれ・無い / 取れなければ頭文字）、Android `ConversationNotificationTest` が読む。
  シミュレータで、拡張機能と同じ `CommunicationNotification.update`（写真なし）を通したローカル通知に頭文字のアバターが出る
  ことを確かめた（`xcrun simctl push` では拡張機能が動かないため）。
