# MEMBERSHIP (M88 / M89 / M90)

チャンネルの参加・退出の表示と、管理者のワークスペース設定 2 つ。利用者の要望 (2026-10-03):
「チャンネルに参加したり抜けたりしたとき、それがわかるように一言表示されるようにしたい。管理者側の設定で、その表示を
ON/OFF できるようにもしたい。管理者側の設定で、入る前にチャンネルの中を見ることができるかどうかも切り替えられるように
(デフォルトは見ることができる)」。M88 でサーバと Desktop / Web、M89 で iOS / Android (§5)。

## 1. 参加・退出の一言 (システムメッセージ)

公開・非公開チャンネルで、メンバーが変わった操作ごとに 1 行。DM・グループ DM には出さない。

| kind | 文 | 出る操作 |
| --- | --- | --- |
| `member_joined` | 「A が参加しました」 | 自分で参加 (`POST /channels/{id}/join`)、招待リンクで作ったアカウントの参加 (M12h)、Google でログインの既定チャンネル (M48)、既定のチャンネル (M90 §6、作られたアカウントが入る)、名簿で指導教員になって学生の times に入る (M24)、自分の times に戻る |
| `member_left` | 「A が退出しました」 | 自分で抜ける (`/leave`)、オーナー・管理者が自分を外す |
| `members_added` | 「A が B、C を追加しました」 | メンバーの追加。1 回の操作で何人追加しても 1 行 (`POST /channels/{id}/members/batch`、`/invite @a @b`)。管理者が times の持ち主を決めて追加したとき。「今いる人も全員入れる」(M90 §6、チャンネルごとに 1 行) |
| `member_removed` | 「A が B を外しました」 | オーナー・管理者による除外 |

- **形**: `messages.type = "system"`、`messages.system_event = {kind, actor_id, user_ids}` (JSONB、migration 0071)。
  `MessageOut.system_event` で返す。`sender_id` は操作した人 (actor)。joined / left の `user_ids` は `[actor_id]`。
  クライアントは `system_event` から今の名簿の名前で文を作る (改名に追従、将来の多言語化)。`body` は作った時点の名前の
  平文 (上の表の文) で、M88 より前のクライアント・エクスポート・知らない kind・名簿に無い人の代わりに使う。名前は
  `<@id>` のトークンにしない (古いクライアントが「@名前」と出し、メンションに見えるため)。
- **seq**: ふつうのメッセージと同じく 1 つ取る (`message.created`、差分同期 `/sync` にも乗る)。`last_message_at` は
  動かさない (サイドバーの「最近」の順を参加・退出で変えない)。
- **未読にならない**: 未読数・メンション数・`first_unread_at`・バッジは `type = "user"` だけを数える (前からの規則。
  SYNC_PROTOCOL.md §10.1 12.)。プッシュしない (PushPlanner が type を見て捨てる)。メンションしない
  (`mentioned_user_ids` / `keyword_user_ids` は空)。アプリ内の通知もしない (`apps/shared/notify-rules.json` の
  `system_messages`)。
- **既読位置**: 参加した本人・追加された人の既読位置はその行の seq にする (自分が入った行を未読扱いの「最初の未読行」に
  しない)。操作した人 (追加した人) と他のメンバーの既読位置は動かさない。
- **変更できない**: 編集・リアクション・ピン留め・スレッドの返信は `400 system_message_readonly`。削除は管理者だけ
  (操作した本人も `403 not_message_owner`)。
- **検索・AI**: 検索には出ない (`type = "user"` だけ、M19 からの規則)。AI の要約・メンションへの返事・「AI に聞く」の
  文脈にも入れない。Times フィード (L8) にも出ない。DM 一覧の最後のメッセージ (M49) には出うる (クライアントは
  `type != "user"` なら抜粋をそのまま出す、前からの規則)。
- **出さないもの**: 移行 (Mattermost・Slack の取り込みはメンバーシップを直接書く)、ボット (受信 Webhook・定期投稿・
  締切・AI のボット) が入る・抜ける・操作するとき (配線であって会話の出来事ではない。AI のボットを人が追加しても出さない)、
  年度更新 (L7、まとめて動かす操作で取り消しもある)、アーカイブ済みのチャンネル、チャンネルを作った時の作成者と times を
  作った時の指導教員 (作成そのもの)。
- **実装**: `channels.announce_membership_in_tx` が判定 (種類・アーカイブ・ボット・設定) し、書くのは `messages` の
  `post_membership_in_tx` (channels は messages に依存しないので、messages が import 時に
  `channels.set_membership_writer` で登録する。ARCHITECTURE.md §5)。`add_member_in_tx` は `announce=True` を
  渡した呼び出しだけが出す。

## 2. 古いクライアント (M88 時点の配布版)

- iOS (ビルド 71 まで) / Android: `type` を文字列で持ち、知らない値でも落ちない (iOS は Codable、Android は
  `ignoreUnknownKeys`)。システム行はふつうの投稿の形 (操作した人のアイコン・名前・時刻の下に `body`) で出る。前後の
  投稿とはまとめない (`type == "user"` 同士だけをまとめる規則が既にある)。未読にも数えない (§10.1 12. を実装済み)。
  `body` は「A が参加しました」のように主語から書くので、送信者名の下に出ても読める。
- 長押しのリアクション・返信・編集などは出てしまうが、サーバが `400 system_message_readonly` で断る (エラーの文言は
  M88 の表に入れたので、新しいビルドでは日本語で出る。古いビルドは汎用のエラー)。
- アプリを開いている間の通知: 古い iOS / Android は `message.created` を通知の規則に通すので、レベル「すべて」の
  チャンネルでは参加・退出がアプリ内の通知 (と Android のローカル通知) になる。プッシュは出ない。M89 で直す。
  気になる場合は管理者が「参加・退出の表示」を M89 の配布まで切っておける。
- 参加前のプレビューを切ったサーバ: 古いクライアントは `GET /channels/{id}/messages` の 403 で落ちない。iOS は
  「読み込めませんでした」と 403 の汎用の文言 (古い表に `preview_disabled` は無い) と「再読み込み」、Android は読み込みの
  失敗と「再読み込み」を出し、どちらも下の「#name に参加する」はそのまま使える (参加すれば読める)。Desktop は M27 から
  403 を「参加するとメッセージを読めます」として扱う。M89 で iOS / Android もパネルにする。
- `workspace.settings_updated` イベントは知らない種類として無視される。bootstrap の `workspace_settings` も無視される。

## 3. ワークスペースの設定 (管理者)

`workspace_settings` (1 行、migration 0071。行が無ければ既定値) と `GET / PATCH /admin/workspace-settings`
(管理者のみ。PATCH は送った項目だけを変える。未知の項目は 422)。変更は監査ログ `workspace.settings_updated`
(`{項目: {from, to}}`) に残し、`workspace.settings_updated` (audience all、`{settings}`) で全端末に届ける。
クライアントは bootstrap の `workspace_settings` (`{show_membership_messages, preview_before_join, icon_version,
in_app_calls, calls_enabled, meeting_base_url}`) で受け取る (`icon_version` は M93 のワークスペースのアイコン。WORKSPACES.md §3.4。
`in_app_calls` = `{enabled, video, screen_share}` は M130 のアプリ内通話。M117 の `calls_enabled` / `meeting_base_url` は
M130 からいつも false / null。docs/CALLS.md)。

| 項目 | 既定 | オフにすると |
| --- | --- | --- |
| `show_membership_messages` 「参加・退出の表示」 | オン | 新しい行を書かない。書いた行は残る |
| `preview_before_join` 「参加前にチャンネルの中を見られる」 | オン (M27 のプレビュー) | 下の通り |
| `in_app_calls_enabled` 「アプリ内通話」 (M130) | オン | 新しい通話を始められない (通話中のものは続く)。サーバに LiveKit の設定が無ければオンでも使えない (`in_app_calls.enabled = false`)。M117 の `meeting_base_url` は PATCH すると `409 meeting_links_retired`。docs/CALLS.md |

**プレビューをオフにしたとき**: 参加していない公開チャンネルについて、一覧 (`GET /channels?include=public`) と
`GET /channels/{id}` の名前・トピック・説明・人数は今まで通り。メッセージの履歴・差分・前後・単体・スレッドの返信・
添付 (メタデータ・本体・サムネイル)・定期投稿の一覧は `403 preview_disabled` (「参加するとメッセージを読めます」)。
判定は `channels.require_readable` の 1 か所 (M27 で読み取りの例外を作った場所)。ピン・ファイル一覧・キャンバス・
カレンダー・タスクは前からメンバーだけ。検索は自分のチャンネルと未参加の公開チャンネル (アーカイブ済みも、2026-10-10。その前は
`is:times` の times だけが例外だった) で、オフなら未参加の分は対象外 (`channels.list_public_searchable_not_member` が空)。`channel_id` で未参加のチャンネルを
指定すると 403。「AI に聞く」(M70) は検索と同じ `search.resolve` を使うので同じ範囲。要約・メンションの返事は前から
メンバーだけ。**管理者も例外にしない** (今のコードに管理者の特別な読み取りは無い。入っていない非公開チャンネルを
読めないのと同じ考え。管理者は参加すれば読める)。ゲストは前から未参加の公開チャンネルを読めない。

**メッセージから作る個人タスク (Review v0.1.22 #1)**: `POST /tasks` の `source_message_id` は、その人がそのメッセージを
読めるか (`channels.require_readable`。上の判定そのもの) で決める。読めなければ、読めないメッセージと同じく
`404 message_not_found` (抜粋は返さない)。以前はタスク側に「公開チャンネルならゲスト以外は読める」という別の判定があり、
プレビューをオフにしても、ID を知っていれば個人タスクの `source.excerpt` で本文を読めた。元のメッセージが編集されたときの
抜粋の追従 (`TaskSourceHandler`) も同じ判定で、オフにした後・退出した後の編集は、もう読めない人のタスクには配らない
(抜粋は null、リンクは残る)。オフにする前に作った抜粋はその時の写しとして残る。

## 4. Desktop / Web (M88)

- 管理 → 「設定」タブ (「AI」の隣) に 2 つのスイッチ。切り替えるとすぐ保存 (断られたら戻す)。M88 より前のサーバ (404)
  では「対応していません」と出す。
- システム行は中央寄せの小さい灰色の 1 行 (`SystemMessageRow`): 名簿の名前で作った文と時刻 (ホバーで日時)。アイコン・
  名前の見出し・ホバーのバー・メニュー・長押しのシートは無い。前後の投稿とまとめない。`article` と `data-seq` は持つので、
  位置合わせ・キーボード移動・表示範囲の既読は他の行と同じ。
- プレビューがオフ (bootstrap / イベントの値、またはサーバの 403) なら、未参加の公開チャンネルを開くと見出しと
  「参加するとメッセージを読めます」のパネル (説明・人数・「参加」ボタン) を出し、履歴は取りに行かない。下の
  「#name に参加する」のバーは出さない (ボタンは 1 つ)。開いている間に設定が変わったらすぐ追従する。
- Review v0.1.22 #6: オフに変わる前に出した履歴・古いページ・スレッドの要求の応答は、あとで届いても書き戻さない
  (本文も `refused: false` も、失敗のトーストも出さない)。プレビューごとの読み込みの世代を、開く・閉じる・オフになる・
  サーバが 403 で断るたびに進め、各 await のあとで世代・今の設定・対象のチャンネルを確かめる (`engine.ts` の `previewCurrent`)。
  スマホも同じ規則にする (応答を保留して設定を切り替えるテスト: Desktop の `tests/membership.test.tsx`)。
  - Android: `sync/SyncEngine.kt` の `previewGen` (プレビューを入れ替える `replacePreview` のたびと、403 `preview_disabled` の
    `refusePreview` で進む) と `previewCurrent` を、最初のページ・古いページ・スレッドの各 suspend のあとで確かめる。古い応答の
    失敗は投げない (トーストなし)。テストは `MembershipTest` (応答を保留してオフにし、成功・失敗で返す 3 種類 × 2、403 のあとの
    スレッド、オフ → オンで古い応答が新しい行を消さない)。
  - iOS (ビルド 80): プレビューの行と、そこから開いたスレッドの読み込みを `ChannelPreviewModel` (`UI/ChannelPreviewView.swift`)
    に移した。世代はオフになる・サーバが 403 で断るたびに進め (画面は `.id` でチャンネルごとに作り直すので、開く・閉じるは
    新しいモデル)、最初のページ (permalink の前後を含む)・古いページ・スレッド (親を読んだ後と返信を読んだ後の両方) の各
    await のあとで世代・今の設定・チャンネルを確かめる。古い応答は成功でも失敗でも行・エラー表示・トーストを出さない。
    テスト: `PreviewRaceTests` (`ChikuwaChatTests/MembershipTests.swift`)。
- メンバーの追加ダイアログと `/invite @a @b` は `POST /channels/{id}/members/batch` で 1 回に送る (405 を返す古い
  サーバでは 1 人ずつ)。

## 5. iOS / Android (M89 の仕様)

サーバは M88 のまま (API の追加は無い)。両方とも次をそろえる。

1. **モデル**: `MessageOut.systemEvent: {kind, actorId, userIds}?` (null 可)。ローカル DB / スナップショットにも保存する
   (再起動後も名前を作り直せるように。無ければ `body`)。`BootstrapOut.workspaceSettings: {showMembershipMessages,
   previewBeforeJoin}` (無いサーバでは両方 true)。イベント `workspace.settings_updated` (`{settings}`) で置き換える。
   永続化はしなくてよい (オフライン起動は既定値、次の bootstrap で直る)。
2. **文**: Desktop の `systemMessageText` と同じ規則 (`apps/desktop/src/ui/systemMessage.ts`): kind ごとに
   「A が参加しました」「A が退出しました」「A が B、C を追加しました」「A が B を外しました」。名前は手元の名簿の
   `display_name`、区切りは「、」。`system_event` が無い・kind を知らない・名簿に無い人がいるときは `body`。
   テストは Desktop の `tests/membership.test.tsx` の `systemMessageText` の行を移す。
3. **表示**: タイムラインの 1 行を中央寄せの小さい灰色の文 + 時刻にする (アイコン・名前の見出し・リアクション・
   スレッドの行は無い)。前後とまとめない (既存の `continues` の規則のまま)。iOS の反転したリスト (D23) でもふつうの行と
   同じく 1 行として並べる。行のタップ・長押しでは何も開かない (操作シート・スレッド・リアクションを出さない)。
   「ここから未読にする」も出さない。プレビュー (§7.6.1) の行も同じ。
4. **未読と通知**: 未読は今まで通り数えない (§10.1 12.)。アプリ内の通知 / ローカル通知 (`maybeNotify`) で
   `type != "user"` を捨てる。`apps/shared/notify-rules.json` の `system_messages.cases` をテストで読む (iOS
   `ChannelRulesTests`、Android `NotificationLevelsTest`。`type` を事実に足して `notifies` が false)。
5. **プレビューのオフ**: `workspaceSettings.previewBeforeJoin == false` なら、未参加の公開チャンネルを開いたとき履歴を
   取りに行かず、「参加するとメッセージを読めます」と説明・人数・「参加」ボタンを出す (下の参加バーとボタンを重ねない)。
   サーバの `403 preview_disabled` (オフラインの間に設定が変わった) でも同じ表示にする (今の 403 の扱いを流用)。開いて
   いる間に `workspace.settings_updated` が来たら、オフなら行を捨ててパネル、オンなら読み込む。パーマリンク・検索から
   未参加のチャンネルの行を開いて 403 になったら、エラーの文言 (errors.json `preview_disabled`) を出す。
6. **追加**: メンバーの追加画面で複数選んだら `POST /channels/{id}/members/batch {user_ids}` を 1 回 (405 なら
   1 人ずつ)。
7. **管理**: iOS / Android に管理画面がある所 (無ければ不要。Web の管理を使う) には 2 つのスイッチを足してよいが必須では
   ない。
8. **エラー**: `preview_disabled`・`system_message_readonly` は M88 で生成済みの表 (`ErrorMessages.swift` /
   `ErrorMessages.kt`) に入っている。
9. **確認**: シミュレータ / エミュレータで、参加・退出・複数追加・除外の行が名前付きで 1 行に出ること、未読・バッジ・
   通知にならないこと、プレビューのオフで未参加のチャンネルがパネルになり参加で読めること、設定を変えると開いている
   画面が追従すること。

### M89 iOS (ビルド 79、2026-10-03)

§5 を iOS で実装した。サーバ・API は M88 のまま。

- **モデル**: `MessageOut.systemEvent` (`SystemEvent {kind, actorId, userIds}`、kind は文字列のまま。壊れた値は nil) と
  `BootstrapOut.workspaceSettings` (`WorkspaceSettings`、項目が無ければ true)。ローカルのメッセージは SQLite に JSON で
  持つので、`MessageState.systemEvent` を足すだけで移行は要らない (前のビルドで保存した行は nil で読み、`body` を出す)。
  設定は `Store.workspaceSettings` (保存しない。起動直後と M88 より前のサーバは既定値)、bootstrap と
  `workspace.settings_updated` で置き換える。
- **文**: `SystemMessage.text` (`UI/SystemMessage.swift`) が Desktop の `systemMessageText` と同じ規則で、名簿
  (`store.users` の `displayName`) から作る。区切りは「、」、event が無い・知らない kind・名簿に無い人なら `body`。
- **表示**: `MessageRow` は `type != "user"` なら `SystemMessageRow` (中央寄せの caption の灰色 1 行 + 時刻) だけを出す。
  アイコン・名前・リアクション・スレッドの行・タップ・長押し・VoiceOver の操作は無い (操作シートを開かないので
  「ここから未読にする」も出ない)。反転したリスト (D23) の 1 行として他の行と同じく並び、表示範囲の既読
  (`VisibleMessageFrames`) も他の行と同じ。まとめない規則は既存の `Timeline.continues` のまま。参加前のプレビューと
  スレッドの画面も `MessageRow` なので同じ。
- **通知**: `NotificationRules.NotifyFacts.type` を足し、`notifies` は `type != "user"` なら false。アプリ内の通知
  (`SyncEngine.maybeNotify`) はこれを通る。未読は前から数えない (`countsAsUnread`)。`ChannelRulesTests` が
  `notify-rules.json` の `system_messages.cases` を事実からと届いたメッセージからの両方で読む。
- **プレビューのオフ**: `ChannelPreviewView` は設定がオフ、または履歴が `403 preview_disabled` なら、履歴を取りに
  行かずに「参加するとメッセージを読めます」のパネル (説明 (`purpose`、無ければトピック)・メンバー数・「参加」) を出し、
  下の参加バーは出さない (アーカイブ済みなら参加の代わりに注記)。開いている間に設定がオフになれば行を捨ててパネル、
  オンになれば読み込む。パーマリンク・検索から開いた未参加のチャンネルも同じパネルになる。
- **追加**: `ApiClient.addMembers` が 2 人以上なら `POST /channels/{id}/members/batch` を 1 回 (405 なら 1 人ずつ)。
  メンバーの追加画面と `/invite @a @b` (名前を全部確かめてから送る) が使う。
- **管理のスイッチ**: 足していない (Web の管理を使う、§5 7.)。
- **テスト**: `MembershipTests` (文・保存・まとめない・エンジンでの未読と通知・設定の bootstrap とイベント・
  パネルの判定・batch と 405・行の描画) と `ChannelRulesTests.testSystemMessagesNeverNotify`。
  `LiveBackendTests.testMembershipLinesAndSettings` (`TEST_RUNNER_LIVE_MEMBERSHIP_URL` /
  `TEST_RUNNER_LIVE_MEMBERSHIP_USERS="admin:pass,a:pass,b:pass"`) は 0071 の開発サーバで通した。シミュレータで
  実際の `ChannelView` (追加・除外・参加・退出の 4 種が名前付きの 1 行、未読 3 件は人の投稿だけ) と
  `ChannelPreviewView` (オフでパネル → オンで読み込み → オフでパネル) を開発サーバの相手に描いて確かめた。
- **残り**: 開いている間に追加されたチャンネルは、次の bootstrap まで手元の既読位置が 0 のまま (サーバは追加の行に
  置く) なので、「新着メッセージ」の線が追加前の行の上に出ることがある (M89 より前からの、イベントで届いたチャンネルの
  既読位置の扱い。未読数はサーバと同じ)。

### M89 Android

- **モデル**: `MessageOut.systemEvent` (`SystemEventOut {kind, actorId, userIds}`)、`BootstrapOut.workspaceSettings`
  (`WorkspaceSettingsOut`、無いサーバでは両方 true)。ローカルの行 `MessageState.systemEvent` に持つ。Room の messages は
  行の JSON を 1 列に入れる形なので、項目を足すだけで移行は要らない (スキーマは 2 のまま。前の行は `systemEvent` が無く
  `body` を出す)。設定は `Store.workspaceSettings` (保存しない)。`workspace.settings_updated` で置き換える
  (`SyncEngine.applyWorkspaceSettings`)。
- **文**: `ui/SystemMessages.kt` の `SystemMessages.text` (Desktop の `systemMessageText` と同じ規則)。名前は
  `store.users` と自分の `display_name`。
- **表示**: `MessageRow` の先頭で `type != "user"` を `SystemMessageRow` (中央寄せの小さい灰色の文 + 時刻) に分ける。
  チャンネル・スレッド・プレビュー・Times フィード (前から出さない) のどれもこの 1 か所を通る。タップ・長押しは無し
  (操作シート・「ここから未読にする」・スレッドが開かない)、まとめない (`Timeline.continues` の既存の規則)。
- **未読・通知**: `NotificationLevels.Facts.system` (`type != "user"`) を `messageNotifies` が最初に見て false。
  アクティビティの印 (`ActivityRules.isActivity`) にもしない。ライブの行で `lastMessageAt` を動かさない (サーバと同じ、
  「最近」の順を変えない)。
- **プレビューのオフ**: `ChannelPreview.disabled`。設定がオフなら `loadPreview` は履歴を取らずに `disabled` にする。
  `403 preview_disabled` も同じ。画面は `PreviewJoin.refused` (preview の `disabled` か設定のオフ) で「参加すると
  メッセージを読めます」のパネル (`#name`・目的 (無ければトピック)・「メンバー N 人」・「参加」。アーカイブ済みは注記) を
  出し、下の参加バーは出さない。開いている間に設定がオフになれば行を捨ててパネル、オンになればその場で読み込む。
  パーマリンク・検索からの 403 は前からの `describe` で errors.json の文言が出る。
- **追加**: メンバーの追加ダイアログを複数選択 (チェック + 「N 人を追加」) にし、`/invite @a @b` も全員を名前解決して
  から送る。`sync/AddMembers.kt` が `POST /channels/{id}/members/batch` を 50 人ずつ送り、405 なら 1 人ずつ。
- **管理画面**: Android には無いので 2 つのスイッチは足していない (Web の管理を使う)。
- **テスト**: `MembershipTest` (13: 文・まとめない・デコードと保存・ライブの行が未読・通知にならない・設定の bootstrap と
  イベント・プレビューのオフとライブの追従・403・パネルの文言・batch と 405)、`NotificationLevelsTest.sharedSystemMessageRules`
  (notify-rules.json の `system_messages`)。
- **エミュレータ (ChikuwaChat_Pixel_9、開発サーバ 0071)**: 複数追加・退出・参加・除外の 4 種が名前付きの 1 行で出て
  (開いている間のライブの行も)、チャンネルは未読にならず、システム行の長押し・タップで何も開かないこと、プレビューの
  オフで未参加のチャンネルがパネルになり、オン・オフの切り替えに開いている画面が追従し、「参加」で読めて
  「android1 が参加しました」が出ること、追加ダイアログが batch を 1 回送ること (「android1 が android2 を追加しました」)
  を確認した。レベル「すべて」での通知の無さはユニットテストだけ (エミュレータの android1 は既定のレベル)。

## 6. 既定のチャンネル (M90)

利用者の要望 (2026-10-03): 「「全体連絡」チャンネルと「談話スペース」をデフォルトで作成し、新規ユーザ（ゲストを除く）は
必ずそこに入るようにしようかな。デフォルトチャンネルは、管理者側で設定できるようにも」。サーバと Desktop / Web。

### 6.1 設定

- `workspace_settings.default_channel_ids` (`uuid[]`、順序付き、migration 0073)。**NULL = 一度も保存していない**、
  `[]` = 保存したが空。
- `GET / PATCH /admin/workspace-settings` (§3、管理者のみ) に足した項目:
  - PATCH `default_channel_ids`: 一覧の全体 (並び順のまま)。空にするには `[]`。20 個まで (21 個以上は 422)。重複は
    黙って落とす。各チャンネルは公開で、アーカイブされていないこと。違えば 422 で、`details.channel_id` に問題の
    チャンネル:
    `default_channel_not_found` (無い)、`default_channel_not_public` (非公開・DM・グループ DM)、
    `default_channel_archived` (アーカイブ済み)。文言は `apps/shared/errors.json`。
  - GET / PATCH の応答: `default_channel_ids`、`default_channels: [{id, name}]` (名前付き。今も公開・未アーカイブの
    ものだけを、並び順で)、`default_channels_set` (一度でも保存したか)、`legacy_sso_default_channels`
    (保存していない間だけ、環境変数 `SSO_DEFAULT_CHANNELS` の名前。保存後は `[]`)。
- 変更は他の項目と同じく監査ログ `workspace.settings_updated` (`{"default_channel_ids": {from, to}}`。from は保存前なら
  null) とイベント `workspace.settings_updated` (audience all)。イベントと bootstrap の `workspace_settings` は全員向けの
  2 つのスイッチだけで、一覧は入れない (クライアントが使わないため)。
- **アーカイブ・非公開にしたとき**: `POST /channels/{id}/archive`、年度更新 (L7) の times のアーカイブ
  (`set_archived_in_tx`)、`PATCH /channels/{id}` で非公開に変えたとき、同じトランザクションで一覧からそのチャンネルを外す
  (`workspace.drop_default_channel_in_tx`)。監査ログ `workspace.settings_updated` に `{default_channel_ids: {from, to},
  reason: "channel_archived" | "channel_made_private"}` (操作した人。年度更新は actor なし)、イベントも出す。
  アーカイブを戻しても公開に戻しても**一覧には戻さない** (管理者が選び直す)。
- **使う時にも確かめる**: アプリの外で消えた・変わったチャンネル (チャンネルの削除の API は無い。DB を直接触った、古い
  バックアップの復元) は、アカウントを作る時と「今いる人も全員入れる」で飛ばす。GET にも出さない。保存された配列は
  次の PATCH (またはそのチャンネルのアーカイブ) まで残るが、使われることはない。

### 6.2 新しいアカウントが入る

- **1 か所**: `admin.create_user_in_tx` の最後で `workspace.default_channels.join_in_tx` を呼ぶ。人のアカウントを作る
  経路は全部ここを通る:
  - 管理者の作成 (`POST /admin/users`)
  - CLI の `create-user` / `create-admin`
  - 招待リンクの受諾 (既定のチャンネルの後に招待のチャンネル。重なったチャンネルは 1 回だけ入る)
  - Google でログインの自動作成 (案B)
- **入らない人**: ゲスト (`role = guest`)、ボット (`create_bot_in_tx` は別の関数。`role = bot` は弾く)、無効の
  アカウント。移行 (Mattermost・Slack の取り込み) は `join_default_channels=False` を渡す (メンバーシップは移行元から)。
  M91 の Slack の取り込みが有効なアカウントとして作った人も同じ。既定のチャンネルにも入れたいときは、取り込みの後で
  管理者が「設定」の「今いる人も全員入れる」を押す (有効な admin / member 全員が対象。冪等)。
- **入り方**: ふつうのメンバーシップの道 (`channels.add_member_in_tx(announce=True)`): `channel.member_added` /
  `channel.created` のイベント、既読位置、M88 の設定がオンなら「〇〇 が参加しました」(`member_joined`、actor は本人。
  管理者が作っても「参加しました」で、招待・Google と同じ文)。オフなら行は無い。順は一覧の並び。
- **環境変数からの移行**: 一覧が NULL (一度も保存していない) の間だけ、Google でログインの自動作成は従来どおり
  `SSO_DEFAULT_CHANNELS` の名前で入れる (無い名前・非公開・アーカイブ済みは飛ばしてログに警告)。管理者の作成・CLI・
  招待はこれまでも環境変数を使っていなかったので、NULL の間は既定のチャンネルなし (今までどおり)。一覧を一度保存すると
  (空でも) 環境変数は使わない。起動時やマイグレーションで環境変数を一覧に写すことはしない (データを勝手に書かない)。
  管理の「設定」タブは、保存前に環境変数の値を注記として出す。`SSO_DEFAULT_CHANNELS` は非推奨 (SSO.md §2、
  `infra/.env.example`)。
- **無効にして戻した人**: 戻しても既定のチャンネルに入れ直さない (作った時だけ。抜けたチャンネルに勝手に戻さない)。
  入れたいときは「今いる人も全員入れる」。
- 既定のチャンネルを抜けるのは自由 (「必ず入る」は作った時に入れるという意味で、抜けられないチャンネルは作らない)。

### 6.3 今いる人も全員入れる

- `POST /admin/workspace-settings/apply-default-channels` `{dry_run?: bool}` (管理者のみ。未知の項目は 422)。
  有効な `admin` / `member` 全員を、入っていない既定のチャンネルに入れる。ゲスト・ボット・無効の人は入れない。
  使うのは保存した一覧だけ (`SSO_DEFAULT_CHANNELS` は使わない)。
- 応答 `DefaultChannelsApplyOut`: `{dry_run, users (1 つ以上に入った / 入る人の数), memberships (のべ), channels:
  [{id, name, added}]}`。`dry_run: true` は数えるだけで何も変えない (確認の文に使う)。
- **冪等**: 2 回目は誰も入らず、行も監査も増えない。
- **行**: チャンネルごとに 1 行 `members_added` (actor は管理者、`user_ids` は入れた人全員)。M88 の設定に従う。
  名前が 10 人を超えたら最初の 10 人と「ほか N 人」にする (「Admin が A、B、… J ほか 25 人 を追加しました」)。
  `system_event.user_ids` は全員を持つ。この規則はサーバの `body` (`membership_names`) と Desktop の `joinNames` に
  ある (M88 の複数追加にも同じく効く)。
- 監査ログ `workspace.default_channels_applied` (`{users, memberships, channels: {id: added}}`、入れた人がいたときだけ)。
- 実装: `workspace.default_channels.apply_to_everyone` → `channels.add_members_in_tx` (1 チャンネルずつ、同時の追加は
  入れ子のトランザクションで飛ばす)。数十人の規模なので 1 トランザクションで全部。
- **非公開化・アーカイブとの競合 (REVIEW-v0.1.30 #1)**: 一括参加 (`dry_run` 以外) と §6.2 の `join_in_tx` は、人を
  入れる前に一覧のチャンネルの行を id 順に `FOR NO KEY UPDATE` でロックし、ロックの下で読み直して公開・未アーカイブの
  ものだけに入れる (`workspace.lock_usable_default_channels`、コミットまで保持)。先にコミットした非公開化・アーカイブは
  読み直しで見えて飛ばす。後から来た非公開化・アーカイブはチャンネルの行で待ち、メンバーシップ (公開の間に入った人) の
  コミットの後に進む。ロックの順: 非公開化・アーカイブはチャンネルの行 → 設定の行 (一覧から外す)。参加の側はチャンネルの
  行だけを取り、設定の行はロックしない (一覧は読むだけ。一覧から外れても、ロックの下でまだ公開なら公開のうちに入れたのと
  同じ) ので、循環して待つことは無い。複数のチャンネルは id 順なので、参加の操作同士も循環しない。

### 6.4 Desktop / Web

- 管理 → 「設定」に「既定のチャンネル」の欄: 選んだチャンネルを順に並べ、行ごとに「上へ」「下へ」「外す」。下の選択欄は
  公開・未アーカイブ・未選択のチャンネル (`GET /channels?include=public`)。選ぶ・並べ替える・外すとすぐ一覧の全体を
  PATCH (断られたら戻してエラー)。空のときは「「全体連絡」と「談話スペース」を既定にする」ボタン (同じ名前の公開
  チャンネルがあればそれを、無ければ作ってから既定にする。利用者の要望の 2 つ)。一度も保存していないサーバでは
  `SSO_DEFAULT_CHANNELS` の注記。
- 「今いる人も全員入れる」: まず `dry_run` で数え、「N 人を既定のチャンネルに追加します (のべ M 件…)」とチャンネルごとの
  人数を出して確かめてから実行。0 人なら「全員がすでに既定のチャンネルに入っています。」とだけ出す。
- M90 より前のサーバ (GET に `default_channel_ids` が無い): 欄に「このサーバは既定のチャンネルに対応していません。」
  M88 より前 (404) はタブ全体が前からの「対応していません」。
- テスト: `tests/defaultChannels.test.tsx`。

### 6.5 iOS / Android

変更は要らない。既定のチャンネルへの参加はふつうのメンバーシップの道なので、新しい人はログイン後の bootstrap に
チャンネルが入っており、「今いる人も全員入れる」で入った今いる人には、メンバーの追加と同じ `channel.created`
(本人宛て) と `channel.member_added` が届き、行は `message.created` で届く (M89 で表示済み)。管理の画面はスマホに無い
(Web の管理を使う)。違いは 1 つだけ: 11 人以上を追加した行を、スマホは「ほか N 人」にまとめず全員の名前で出す
(`system_event` から作るため)。読めるので必須ではないが、合わせるならスマホの文の規則に §6.3 の 10 人の規則を足す。
