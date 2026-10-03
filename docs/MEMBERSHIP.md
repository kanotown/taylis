# MEMBERSHIP (M88 / M89)

チャンネルの参加・退出の表示と、管理者のワークスペース設定 2 つ。利用者の要望 (2026-10-03):
「チャンネルに参加したり抜けたりしたとき、それがわかるように一言表示されるようにしたい。管理者側の設定で、その表示を
ON/OFF できるようにもしたい。管理者側の設定で、入る前にチャンネルの中を見ることができるかどうかも切り替えられるように
(デフォルトは見ることができる)」。M88 でサーバと Desktop / Web、M89 で iOS / Android (§5)。

## 1. 参加・退出の一言 (システムメッセージ)

公開・非公開チャンネルで、メンバーが変わった操作ごとに 1 行。DM・グループ DM には出さない。

| kind | 文 | 出る操作 |
| --- | --- | --- |
| `member_joined` | 「A が参加しました」 | 自分で参加 (`POST /channels/{id}/join`)、招待リンクで作ったアカウントの参加 (M12h)、Google でログインの既定チャンネル (M48)、名簿で指導教員になって学生の times に入る (M24)、自分の times に戻る |
| `member_left` | 「A が退出しました」 | 自分で抜ける (`/leave`)、オーナー・管理者が自分を外す |
| `members_added` | 「A が B、C を追加しました」 | メンバーの追加。1 回の操作で何人追加しても 1 行 (`POST /channels/{id}/members/batch`、`/invite @a @b`)。管理者が times の持ち主を決めて追加したとき |
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
クライアントは bootstrap の `workspace_settings` (`{show_membership_messages, preview_before_join}`) で受け取る。

| 項目 | 既定 | オフにすると |
| --- | --- | --- |
| `show_membership_messages` 「参加・退出の表示」 | オン | 新しい行を書かない。書いた行は残る |
| `preview_before_join` 「参加前にチャンネルの中を見られる」 | オン (M27 のプレビュー) | 下の通り |

**プレビューをオフにしたとき**: 参加していない公開チャンネルについて、一覧 (`GET /channels?include=public`) と
`GET /channels/{id}` の名前・トピック・説明・人数は今まで通り。メッセージの履歴・差分・前後・単体・スレッドの返信・
添付 (メタデータ・本体・サムネイル)・定期投稿の一覧は `403 preview_disabled` (「参加するとメッセージを読めます」)。
判定は `channels.require_readable` の 1 か所 (M27 で読み取りの例外を作った場所)。ピン・ファイル一覧・キャンバス・
カレンダー・タスクは前からメンバーだけ。検索は前から自分のチャンネルだけで、例外だった `is:times` の未参加の公開
times (L8) もオフなら対象外 (`channels.list_public_times_not_member` が空)。`channel_id` で未参加のチャンネルを
指定すると 403。「AI に聞く」(M70) は検索と同じ `search.resolve` を使うので同じ範囲。要約・メンションの返事は前から
メンバーだけ。**管理者も例外にしない** (今のコードに管理者の特別な読み取りは無い。入っていない非公開チャンネルを
読めないのと同じ考え。管理者は参加すれば読める)。ゲストは前から未参加の公開チャンネルを読めない。

## 4. Desktop / Web (M88)

- 管理 → 「設定」タブ (「AI」の隣) に 2 つのスイッチ。切り替えるとすぐ保存 (断られたら戻す)。M88 より前のサーバ (404)
  では「対応していません」と出す。
- システム行は中央寄せの小さい灰色の 1 行 (`SystemMessageRow`): 名簿の名前で作った文と時刻 (ホバーで日時)。アイコン・
  名前の見出し・ホバーのバー・メニュー・長押しのシートは無い。前後の投稿とまとめない。`article` と `data-seq` は持つので、
  位置合わせ・キーボード移動・表示範囲の既読は他の行と同じ。
- プレビューがオフ (bootstrap / イベントの値、またはサーバの 403) なら、未参加の公開チャンネルを開くと見出しと
  「参加するとメッセージを読めます」のパネル (説明・人数・「参加」ボタン) を出し、履歴は取りに行かない。下の
  「#name に参加する」のバーは出さない (ボタンは 1 つ)。開いている間に設定が変わったらすぐ追従する。
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
