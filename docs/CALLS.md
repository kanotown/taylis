# CALLS: 会議リンクの通話（M117）

会話の中から音声・ビデオの通話を始められるようにする。最初は「会議サービスの部屋のリンクを会話に投稿する」だけの
簡単な形にし、通話そのものはアプリの外（ブラウザ・Jitsi Meet のアプリ）で行う（利用者の決定 2026-10-06）。

## 1. 目的

- DM・グループ DM・チャンネルで、ボタン 1 つで「今から話そう」を始められる。
- 相手には通知が届き、メッセージの「参加する」から同じ部屋に入れる。
- サーバ・3 端末に WebRTC・TURN・メディアサーバを足さない。

## 2. なぜ会議リンクから始めるか

- アプリの中の通話（WebRTC）には、メディアサーバ（SFU）・TURN・端末ごとの音声の扱い（CallKit・ConnectionService・
  バックグラウンド）が要り、作るのも運用するのも大きい。数十人の研究室では、まず「すぐ話せる」ことが要る。
- 会議サービス（既定は公開の Jitsi、`https://meet.jit.si/`）は無料で、ブラウザでもアプリでも入れる。
- 部屋の名前はサーバが推測できない乱数で作るので、リンクを知っている人だけが入れる（リンクが鍵）。
- メッセージとして残るので、同期・未読・通知・検索・古いクライアントでの表示は今の仕組みのまま動く。

**meet.jit.si の注意**：公開の meet.jit.si では、部屋に最初に入る人（主催者）がサインイン（Google・GitHub など）を
求められる（2023 年からの meet.jit.si の決まり。後から入る人は不要）。気になるなら自前の Jitsi（Docker で立てられる）
などを設定に入れる（§3）。会議サービスは Taylis の外のサービスで、通話の中身はそのサービスを通る。

## 3. 設定（管理者）

`workspace_settings.meeting_base_url`（移行 0091、DATA_MODEL.md workspace_settings、MEMBERSHIP.md §3）。

| 値 | 意味 |
| --- | --- |
| `https://meet.jit.si/`（既定。行が無いときも） | 公開の Jitsi で部屋を作る |
| ほかの `https://…` | そのサービスで部屋を作る（自前の Jitsi など。部屋の名前を後ろに付けて開ける URL） |
| NULL | 通話はオフ。端末は 📞 を出さず、`POST /channels/{id}/calls` は `409 calls_disabled` |

- 変更：`PATCH /admin/workspace-settings {meeting_base_url}`（管理者だけ）。`""` か `null` を送るとオフ、項目を送らなければ
  そのまま。ほかの設定と同じく監査ログ `workspace.settings_updated`（`{meeting_base_url: {from, to}}`）と
  `workspace.settings_updated` イベント（全員）。
- 確かめること（外れたら `422 meeting_url_invalid`、`details.reason`）：`https` だけ（`http` はサーバが DEBUG のときの
  `localhost` / `127.0.0.1` / `::1` だけ。手元で立てた Jitsi の試験用）、ホストがある、ユーザー名・パスワード・`?`・`#` が
  無い、空白・制御文字が無い、ポートが正しい。末尾に「/」が無ければ足す。長さは 200 文字まで（足した後。超えれば 422）。
- 端末が読む所：bootstrap の `workspace_settings` と `workspace.settings_updated` の `settings` に
  `calls_enabled`（bool）と `meeting_base_url`（文字列か null）。管理者の `GET / PATCH /admin/workspace-settings` にも出る。
  端末は URL を自分で組み立てない（部屋はサーバが作る）。`meeting_base_url` は設定画面の表示用。

## 4. API

`POST /api/v1/channels/{channel_id}/calls`

```json
// 要求
{ "client_msg_id": "<uuid>" }
// 応答 201（作った）/ 200（同じ client_msg_id の再送）
{ "url": "https://meet.jit.si/taylis-k3q7…", "message": { /* MessageOut。message.call = {url, started_by} */ } }
```

- 始められる人：その会話にトップレベルのメッセージを投稿できる人と同じ（メンバー。公開チャンネルでも参加していなければ
  `403 not_a_member`。アナウンスのチャンネルはオーナーと管理者（`403 posting_restricted`）。DM は DM の送信と同じ
  （`403 dm_unavailable`）。DM・グループ DM・公開・非公開チャンネルのどれでも）。スレッドの中では始めない（`parent_id` は無い）。
- `409 channel_archived`：アーカイブされた会話。`409 calls_disabled`：設定がオフ。`404 channel_not_found`。
  `422 validation_error`：`client_msg_id` が無い・UUID でない。`429 rate_limited`：メッセージの投稿と同じ上限を数える。
- 冪等：`client_msg_id` はメッセージの冪等キーそのもの（`messages.client_msg_id`）。同じキーの再送は、その後に会話や設定が
  変わっていても同じメッセージと同じ URL を 200 で返す（メッセージが削除されていても `url` は返し、`message.deleted = true`）。
  ふつうのメッセージに使ったキーを送ると `409 idempotency_conflict`。
- 部屋の名前：`taylis-` + 小文字の base32（`a-z2-7`）24 文字（120 ビットの乱数、`secrets`）。会話や人の id からは作らない。
  通話のたびに新しい部屋になる（同じ会話でも前の部屋は使い回さない）。
- 投稿はふつうのメッセージの経路（seq・outbox の `message.created`・プッシュ・既読を進める・検索）を通る。

## 5. メッセージの形

- `type = "user"`、送った人は始めた人、`body` は `📞 通話を始めました` + 改行 + URL（ワークスペースの言語の日本語のまま。
  docs/I18N.md §1。M117 より前のクライアントはこの本文を出し、URL は自動でリンクになる）。
- `MessageOut.call`：`{ url, started_by }`（`started_by` = `sender_id`）。通話のメッセージでなければ null。削除すると null
  （本文も空）。`messages.call_url` に保存する（移行 0091）。
- 編集はふつうのメッセージと同じにできる（`call` は残る）。リアクション・スレッド・ピン留めも同じ。
- 未読・メンション・通知キーワード・検索（本文）・DM 一覧のプレビュー（`last_message.excerpt` は本文の 1 行）は
  ふつうのメッセージと同じ。

## 6. 通知

- プッシュの対象はふつうのメッセージと同じ規則（PUSH_NOTIFICATIONS.md §4。DM・グループ DM はいつもどおり届き、チャンネルは
  その人の通知の設定に従う）。
- 本文は本文の抜粋の代わりに「📞 〇〇 さんが通話を始めました」（受け手の言語：en `📞 〇〇 started a call`、
  zh-Hans `📞 〇〇 发起了通话`。`server/app/i18n/messages.json` の `push.call.started`）。題（DM なら相手の名前、
  チャンネルなら `#名前`）は今までどおり。URL は入れない（タップで会話を開き、そこの「参加する」で入る）。
  `PUSH_INCLUDE_CONTENT=false` でも同じ文（本文の中身を含まないため）。
- Desktop / Web のアプリ内の通知（`message.created` から作るもの）も同じ文にする。

## 7. 端末の動き（期待すること）

- **📞 ボタン**：会話の見出し（DM・グループ DM・チャンネル）に置く。`workspace_settings.calls_enabled` が true で、
  その会話に投稿できるとき（アーカイブされていない。アナウンスのチャンネルはオーナーと管理者）だけ。押すと確認
  （「通話を始めますか？メンバーに通知が届き、会議のリンクが投稿されます。」→「通話を始める」/「キャンセル」）。
- 確かめたら `client_msg_id` を作って `POST /channels/{id}/calls`。失敗の再送は同じ `client_msg_id` で（二重に始めない）。
  成功したら返ってきた `url` をアプリの外で開く：Desktop は既定のブラウザ（Tauri の opener）、Web は新しいタブ、
  iOS / Android はシステムのブラウザ（`UIApplication.open` / `Intent.ACTION_VIEW`。Jitsi Meet のアプリが入っていれば
  ユニバーサルリンク / アプリリンクでそちらが開く）。アプリの中の WebView では開かない（カメラ・マイクの許可が要るため）。
  `409 calls_disabled` なら設定を読み直して 📞 を隠す。
- **通話のメッセージ**：`message.call` があれば、本文の代わりに（または本文の上に）通話のカード「📞 〇〇 さんが通話を
  始めました」と「参加する」ボタン（`call.url` を上と同じように外で開く）。時刻はメッセージの時刻。本文の URL は
  繰り返さない（リンクのプレビューも出さない）。通話が終わったかはサーバは知らないので、カードはいつまでも
  「参加する」を出す。
- **通知**：プッシュ / アプリ内の通知をタップすると会話を開く（自動で通話には入らない）。
- 設定：Desktop / Web の管理画面「ワークスペースの設定」に「通話の会議サービス」（URL の欄、空にするとオフ、既定に戻す
  ボタン、meet.jit.si の主催者のサインインの注意書き）。
- 用語：「通話」= Call / 通话（apps/shared/i18n/glossary.json）。
- **Android**（2026-10-06）：📞 は会話の上のバーの検索の左（`ui/Calls.kt` の `Calls.canStart`）。部屋は `Intent.ACTION_VIEW`
  で開く（Custom Tab は使わない）。再送の鍵は答えが分からない失敗（ネットワーク・5xx・429）のときだけ 10 分残す（`CallKeys`）。
  管理画面は無い。

**Desktop / Web の実装（2026-10-06）**：

- 📞 は会話の見出しの右のボタン（スマホの幅でも出す）。`calls_enabled` が true のときだけ（`calls_enabled` を送らない M117 より前の
  サーバでは出さない）。確認のダイアログを開いたときに `client_msg_id` を作り、閉じるまで同じものを使う（失敗して「通話を
  始める」をもう一度押しても同じ id。二重に始めない）。Web では押したときに空のタブを先に開き、URL が返ってきたらそこへ
  移る（リクエストの後で開くタブはブラウザに止められるため。失敗したら閉じる）。`409 calls_disabled` は手元の
  `calls_enabled` を false にして 📞 を隠す。
- 通話のカードは本文の代わりに出す。本文がサーバの決まった文（`📞 通話を始めました` + 改行 + URL）のままなら本文は出さず、
  編集して変えた本文はカードの下に出す。部屋の URL のリンクのプレビューは取らない。削除したメッセージはふつうの削除と同じ。
- アプリ内の通知（`message.created` から作るもの）は「📞 〇〇 さんが通話を始めました」。チャンネルでも「〇〇: 」を前に付けない。
- 管理 → 設定「通話の会議サービス」：URL の欄と「保存」（Enter でも）、既定でないときは「既定（meet.jit.si）に戻す」。空で
  保存するとオフ。`422 meeting_url_invalid` は `details.reason`（`scheme`・`host`・`query`・`credentials`・`characters`・
  `malformed`・`length`）を言葉にして欄の下に出す。meet.jit.si のときは主催者のサインインの注意書きを出す。

## 8. 今後（今はやらない）

- **アプリの中の通話**：LiveKit（自前の SFU）などで、会話の中で通話する。その時は `message.call` に `provider` などを
  足し、会議リンクの通話はそのまま読めるようにする。
- **着信の画面**：iOS の CallKit・Android の ConnectionService / 全画面の通知での「着信」（VoIP プッシュが要る）。
- 通話の終わり・参加者の表示（会議サービスからの webhook が要る）。
- 予定（カレンダー）に会議のリンクを付ける。
