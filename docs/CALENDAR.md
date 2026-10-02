# カレンダー (M51〜M52)

テスターの要望 (2026-09-28、2026-10-01 に再度): 自分用のカレンダー、共有のカレンダー、予定の通知。
設計のもとは IMPLEMENTATION_PLAN.md「カレンダー (設計メモ)」。このあと、調整さん型の日程調整
(決まったら予定にする) とタスク (期限をカレンダーに出す) がこの上に乗る。

**状態**: M51 (サーバと Desktop / Web) は完了 (2026-10-01、移行 0051)。M52 (iOS / Android) も完了 (2026-10-01、iOS build 54)。実装で決めたこと・
直したことは各節の「M51 で決めたこと」と §9。繰り返しと iCal 購読は M68 (サーバと Desktop / Web、移行 0063) で §10、スマホは M69。

## 1. 方針

- **カレンダーは 2 種類だけ**: 自分用 (本人だけ) と、チャンネルの共有カレンダー (そのチャンネルのメンバー)。
  見える範囲と権限はチャンネルのメンバーシップと非公開・DM の規則をそのまま使い、新しい権限の仕組みを作らない。
  研究室全体の予定は、全員が入っているチャンネルに置く。
- **サーバが正**。端末は表示している期間の予定をサーバから読み、WebSocket のイベントで更新する。予定はチャンネルの
  seq とは別に管理する (メッセージの同期規則を複雑にしない)。再接続したら表示中の期間を読み直す。端末に予定を
  長く保存しない (オフラインでの表示は後で検討)。
- **最初は単発の予定だけ**。繰り返し、空き時間の検索、外部カレンダーの取り込みは入れない。書き出し (読み取り専用の
  iCal 購読 URL) は後で検討。→ 繰り返しと iCal 購読は M68 で入れた (§10)。空き時間の検索と取り込みは入れない。
- **通知**は M12e のリマインダーと同じ worker と outbox → プッシュの経路を使う。

## 2. データ

`calendar_events`

| 列 | 型 | 意味 |
|---|---|---|
| id | uuid (v7) | |
| channel_id | uuid NULL | NULL = 自分用 (owner_id の人だけ)。あればそのチャンネルの共有カレンダー |
| owner_id | uuid | 作った人 (自分用では持ち主) |
| title | text (1〜200) | |
| all_day | bool | 終日 |
| starts_at / ends_at | timestamptz | 時刻の予定。ends_at > starts_at (同じ時刻は不可、最長 14 日) |
| start_date / end_date | date | 終日の予定。end_date は含む最終日 (start_date ≤ end_date、最長 60 日) |
| location | text NULL (≤ 200) | 場所または URL |
| description | text NULL (≤ 4000) | Markdown (メッセージと同じ記法) |
| created_at / updated_at | timestamptz | |
| deleted_at | timestamptz NULL | 論理削除 (イベントで端末に消えたことを伝えるため) |
| client_event_id | uuid NULL | 作成の冪等キー (M51 で追加)。(owner_id, client_event_id) で一意。再送は同じ予定を返す |

時刻の予定は `starts_at`/`ends_at`、終日は `start_date`/`end_date` のどちらか一方だけを持つ (CHECK 制約)。
索引: (channel_id, starts_at)、(owner_id, starts_at) where channel_id is null、終日も同様に date で。

`calendar_event_alarms` (予定ごと・人ごとの通知)

| 列 | 意味 |
|---|---|
| event_id, user_id | 主キー。共有の予定でも、通知を付けた人だけに届く |
| minutes_before | 0 / 5 / 10 / 15 / 30 / 60 / 1440 (前日) 。終日は 1440 (前日 8:00) か -480 (当日 8:00) |
| tz | 通知を付けた端末の IANA ゾーン (M51 で追加)。終日の 8:00 と、通知文の「14:00」をこのゾーンで読む。省略時はおやすみ時間のゾーン、それも無ければ Asia/Tokyo |
| fire_at | 計算した送る時刻 (予定の変更で計算し直す) |
| status | pending → fired、または cancelled (取り消し、または計算した時刻が過ぎていた) |

M51 で決めたこと: 終日の「前日」は前日の 8:00 (当日と同じ時刻に揃えた。0:00 に鳴らさない)。予定を終日 ↔ 時刻で切り替えると、
1440 はそのまま、ほかは終日なら -480、時刻なら 60 に置き換える。チャンネルから抜けた人の通知は行ごと消す (戻っても復活しない)。

## 3. 権限

| 操作 | 自分用 | 共有 (チャンネル) |
|---|---|---|
| 見る | 本人 | チャンネルのメンバー (公開チャンネルでもメンバーだけ。ゲストはメンバーなら見られる) |
| 作る | 本人 | 投稿できるメンバー (アーカイブ済み・投稿制限は既存の `require_writable` と投稿ポリシーに従う) |
| 変える・消す | 本人 | 作った人、チャンネルのオーナー、管理者 |
| 通知を付ける | 本人 | 見られる人なら誰でも (自分の分だけ) |

チャンネルから抜けたら、その共有カレンダーは見えなくなり、付けていた通知も止まる (取り消す)。

M51 で決めたこと: 共有カレンダーは公開・非公開チャンネルだけ (DM・グループ DM には置けない: `400 calendar_channel_unsupported`。
自分用がその役をする)。見られない予定はどの操作でも `404 calendar_event_not_found`。アーカイブ済みのチャンネルの予定は読むだけ
(変える・消す・作るは `409 channel_archived`、`can_edit` は false。通知は付けられる)。guest もメンバーなら投稿と同じく作れる。

## 4. API (`/api/v1`)

- `GET /calendar/events?from=<ISO>&to=<ISO>[&channel_id=]` — 期間 (最長 100 日) に重なる予定。自分用と、メンバーの
  チャンネルの共有予定を合わせて返す (`channel_id` を付けるとそのチャンネルだけ)。各予定に自分の通知 (`alarm`) を含める。
  終日の予定は日付で重なりを見る (端末のタイムゾーンで `from`/`to` を渡す)。
- `POST /calendar/events` — `{channel_id?, title, all_day, starts_at?, ends_at?, start_date?, end_date?, location?, description?, alarm_minutes?}`
- `PATCH /calendar/events/{id}` / `DELETE /calendar/events/{id}`
- `PUT /calendar/events/{id}/alarm` `{minutes_before}` / `DELETE /calendar/events/{id}/alarm`
- `GET /calendar/upcoming?days=2&channel_id=` — チャンネルの見出し・ホーム用の今日・明日の予定 (最大 10 件)。

`CalendarEventOut`: 上の列 + `can_edit` (bool) + `alarm` (`{minutes_before, fire_at}` か null) + `channel_name`。

M51 で実装した形:

- `GET /calendar/events?from&to[&channel_id]`: `from` / `to` は offset 付きの日時 (無いものは 422)。`to <= from` や 100 日を超える
  期間は `400 calendar_invalid_range`。1 回 1000 件まで。`channel_id` がメンバーでないチャンネルなら `403 not_a_member`。
- `GET /calendar/events/{id}` を足した (通知から予定を開く、あとで `/e/<id>` のリンク)。
- `POST /calendar/events`: 上の本文に `tz` (通知のゾーン) と `client_event_id` (冪等キー、再送は 200 で同じ予定)。
  題名は空白を 1 つにまとめる。場所・説明は空なら null。時刻と日付の組み合わせが合わない・終わりが始まり以前は
  `400 calendar_invalid_time`、長すぎる予定は `400 calendar_event_too_long`、予定の種類に無い通知は `400 calendar_invalid_alarm`。
- `PATCH`: 送った項目だけ変える。`channel_id` は変えられない (カレンダーは移せない)。終日 ↔ 時刻の切り替えは他方の組を送る。
- `PUT /calendar/events/{id}/alarm {minutes_before, tz?}` は予定 (`CalendarEventOut`) を返す。`DELETE …/alarm` は 204。
- `GET /calendar/upcoming?days=2&channel_id=&tz=`: `days` は 1〜7。今日 (`tz` の日付) から `days` 日の、まだ終わっていない予定を
  始まりの早い順に 10 件まで。
- `alarm` は `{minutes_before, fire_at, status}`。

## 5. 同期

- outbox のイベント: `calendar.event.updated` (作成も含む。予定全体を載せる) と `calendar.event.deleted` (`{id, channel_id}`)。
  M51 で直したこと: `can_edit` と `alarm` は人ごとに違うので、チャンネル全員宛てのイベントには載せられない。
  `calendar.event.updated` は `{event: (上の列と channel_name), editor_ids}` にした。`can_edit` は `editor_ids` (作成者・
  チャンネルのオーナー・メンバーの管理者。アーカイブ済みなら空、自分用は本人) に自分がいるか。`alarm` は端末の手元の値を残し、
  変わるときは `calendar.alarm.updated` (`{event_id, channel_id, alarm}`) が本人に届く (予定の時刻が変わって計算し直した分も)。
  宛先は共有ならそのチャンネルのメンバー、自分用なら本人の端末。チャンネルの seq は使わない。
- 端末は表示中の期間に重なる予定だけを更新する。重ならないイベントは捨ててよい (次に開いたときに読む)。
- 通知の変更 (`alarm`) は本人の端末へ `calendar.alarm.updated`。
- 再接続したら、表示中の期間とチャンネルの「今日・明日」を読み直す (イベントの取りこぼしはこれで埋まる)。

## 6. 通知 (プッシュ)

- worker が `fire_at <= now` の pending を送る (M12e の `fire_due` と同じ流れ)。`kind = calendar`、タイトル「予定」、
  本文「14:00 ゼミ (#m2-進捗)」、`channel_id` があればそのチャンネル、無ければ自分のカレンダーを開く。
- 予定の時刻が変わったら `fire_at` を計算し直す。過去になった通知は送らない。予定が消えたら取り消す。
- M51 で決めたこと: 通知の文はリマインダーと同じく送る時点の予定から作る。前日の通知は「明日 14:00 ゼミ (#…)」(2 日以上前なら
  「10/3 …」)、自分用の予定はチャンネル名なし。プッシュの payload に `event_id` を足した (APNs の本体と FCM の data にも)。
  worker は送る直前に、予定が残っているか・本人がまだ見られるか・予定が終わっていないか (サーバが止まっていた場合) を確かめ、
  駄目なら黙って cancelled にする。1 つの通知は 1 回だけ送る (pending → fired は 1 度、プッシュの計画は outbox のイベントごとに
  1 回)。チャンネルから抜けたときの取り消しは、channels が calendar を呼ばないよう outbox の `channel.member_removed` を受ける
  ハンドラ (CalendarLeaveHandler) でする (ARCHITECTURE.md §5 の「副作用の連鎖はイベントで結ぶ」)。
- アプリを開いている Desktop / Web は `calendar.alarm.updated` の fired でデスクトップ通知を出す (プッシュが届かないため)。
- おやすみ時間・一時停止 (DND) の間は送らない (リマインダーと同じ扱い)。

## 7. 画面

| 場所 | Desktop / Web | iOS / Android |
|---|---|---|
| 入口 | サイドバーの「カレンダー」 | ホームのタイル「カレンダー」 |
| 表示 | 月 (マスに予定の題名)・週 (時間の格子)・予定の一覧 | 予定の一覧 (日ごと、今日から) と月 (点で予定の有無、日を選ぶとその日の一覧) |
| 絞り込み | 「すべて / 自分 / チャンネルごと」 (色分けはチャンネルごとに固定の色) | 同じ |
| 作る・直す | ダイアログ: 題名、終日、日時、カレンダー (自分 / 参加しているチャンネル)、場所、説明、通知 | 全画面のフォーム |
| チャンネル | 見出しの下のタブ列に「予定」(そのチャンネルの一覧と作成)。今日・明日の予定があれば見出しに件数 | 同じ |

予定をメッセージで共有するボタン (予定へのリンク `<base>/e/<id>` を投稿する) は M52 の後で検討。

M51 (Desktop / Web) で決めたこと:

- 週は**日曜始まり** (月のマスも週の格子も)。土曜は青、日曜は赤の数字。
- 月: マスに 3 件まで (終日は色の帯、時刻の予定は色の点と時刻と題名。スマホの幅では時刻を省く)、それ以上は「+N」(その週を開く)。
  マスの空いたところを押すとその日の予定を追加。週: 上に終日の段、下に 0〜24 時の格子 (8 時から見せる)、重なる予定は横に並べる。
  今の時刻に赤い線。一覧: 今日から 60 日の、予定のある日だけ (「今日」「明日」の印)。前後の移動は月・週・60 日単位。
- 色はチャンネル id の FNV-1a ハッシュで 9 色から選ぶ (どの端末でも同じ)。自分用は灰青 (#64748b)。
- ダイアログ: 題名、終日、開始・終了の日付と時刻 (開始を動かすと長さを保って終了も動く)、カレンダー (自分 / 投稿できる
  公開・非公開チャンネル。既存の予定では変えられない)、場所、説明 (テキスト)、通知 (時刻: なし / 開始時 / 5・10・15・30 分前 /
  1 時間前 / 前日 (24 時間前)。終日: なし / 前日 8:00 / 当日 8:00)。`can_edit` が false なら読むだけで、通知だけ変えられる。
  削除は確認してから。
- チャンネルの「予定」タブ (公開・非公開チャンネルだけ): これから 60 日の一覧と「予定を追加」(投稿できる人)。広い画面では見出しの
  「メッセージ | キャンバス | 予定」、スマホではタブの列。今日・明日の予定があればタブの名前に件数 (「予定 2」) を付ける。
- スマホ幅の Web のホームのタイルに「カレンダー」(リマインダーの次)。
- 端末は予定を保存しない (Tauri の SQLite にも入れない)。画面が開いている期間だけを持ち、再接続で読み直す。

M52 (Android) で決めたこと:

- 日付の計算・色・通知の選択肢・フォームの検査は Web の calendarDates.ts と同じ規則 (テストも Web の例を移植。色は同じ id で
  Web と同じ値になることを確かめた)。予定は Room に入れず、画面が開いている期間だけを持つ (Web と同じ)。
- カレンダーの画面: 上に「一覧 | 月」、絞り込みのチップ (すべて / 自分 / #チャンネル、色の点付き)、‹ 期間 › と「今日」。一覧は
  60 日単位で進む。月はマスの下に予定のあるカレンダーの色の点 (最大 3 つ)、選んだ日の一覧を下に出す。右下の「＋」で表示中の日
  (月では選んだ日) に追加し、絞り込み中のチャンネルに投稿できればそのカレンダーを初期値にする。一覧・月の選択は端末に覚える。
- フォームは全画面。日付・時刻は Material の DatePicker / TimePicker。読むだけの予定は題名・日時・カレンダー・場所・説明を出し、
  通知だけ変えて保存できる。フォームは controller が持つので回転しても閉じない。
- アプリを開いている間に `calendar.alarm.updated` (fired) が来たら、スナックバーと端末の通知 (「予定」「14:00 ゼミ (#…)」、
  キー `calendar:<event_id>`、DND 中は出さない) を出す。FCM の `kind = calendar` は同じキーで出す (自分用は `channel_id` が無い)。
  通知を押すと、チャンネルの予定はそのチャンネルの「予定」タブ、自分用はカレンダーを開き、その予定のフォームを開く
  (手元に無ければ `GET /calendar/events/{id}`)。
- 「予定 N」はチャンネルを開いたときと接続が戻ったときに `GET /calendar/upcoming?days=2&tz=` で読む。

## 8. 実装の順番

- **M51**: サーバ (表・API・イベント・通知の worker) と Desktop / Web。**完了 (2026-10-01)**。
- **M52**: iOS と Android。iOS は完了 (2026-10-01): ホームのタイル「カレンダー」(一覧 / 月、すべて / 自分 / チャンネルの絞り込み、
  Web と同じ色)、全画面のフォーム (読むだけの表示でも通知は変えられる)、会話の「予定」タブ (「予定 N」)、`kind = calendar` の
  通知をタップするとチャンネルの「予定」タブ (自分用はカレンダー) で予定を開く。
- **M52**: iOS と Android。Android は完了 (2026-10-01)。
- あとで: 繰り返し、予定の共有メッセージ、iCal 購読、日程調整から予定を作る (日程調整の M)、タスクの期限の表示。
- **M68**: 繰り返しと iCal 購読のサーバと Desktop / Web (§10)。**M69**: 同じものを iOS と Android に (§10.9)。

## 9. M51 で見つけた設計の問題と直し方

1. **人ごとの項目をチャンネル宛てのイベントに載せられない** (§5 は「予定全体を載せる」、§4 の `CalendarEventOut` は `can_edit`
   と `alarm` を持つ)。イベントは人ごとの項目を除いた予定と `editor_ids` にし、通知は `calendar.alarm.updated` で本人に届ける。
2. **終日の予定の 8:00 と通知文の時刻にはタイムゾーンが要る** がサーバは人のタイムゾーンを知らない (おやすみ時間の設定だけ)。
   通知に付けた端末の `tz` を行に持つ。`GET /calendar/upcoming` も `tz` を取る。
3. **終日の「前日」の時刻が決まっていなかった** (`-480` を「開始 − 分」と読むと 1440 は前日 0:00 になる)。前日 8:00 にした。
4. **作成の再送で予定が二重になる** (冪等キーが無かった)。`client_event_id` を足した。
5. **DM の共有カレンダー** は決まっていなかった。置けないことにした (自分用があり、DM に「チャンネル名」も無い)。

## 10. 繰り返しと iCal (M68)

利用者の決定 (2026-10-02、「推奨の案で」): 繰り返しは RFC 5545 の RRULE の一部、例外と編集は Google カレンダーと同じ 3 通り
(この予定 / これ以降すべて / すべての予定)、表示はサーバが期間の中で展開する、iCal は人ごとの秘密の URL で読むだけ。
M68 はサーバと Desktop / Web、スマホ (iOS / Android) は M69。

### 10.1 決めたこと

| 項目 | 決定 |
|---|---|
| 規則の書き方 | RFC 5545 の RRULE の一部を文字列で予定 (親) に持つ: `FREQ=DAILY\|WEEKLY\|MONTHLY\|YEARLY`、`INTERVAL` (1〜99)、`BYDAY` (毎週: 曜日の並び `MO,WE`。毎月: 第 N 曜日を 1 つ `2TU` / `-1FR`、N は 1〜5 と -1)、`BYMONTHDAY` (毎月だけ、1〜31 か -1 = 月末)、`UNTIL` (日付 `YYYYMMDD`、その日を含む) か `COUNT` (1〜999)。ほか (`BYSETPOS`・`BYHOUR`・`WKST`・時刻付きの `UNTIL` など) は `400 calendar_invalid_rrule`。保存は正規化した形 (`FREQ;INTERVAL;BYDAY;BYMONTHDAY;UNTIL\|COUNT` の順、`INTERVAL=1` は省く、`RRULE:` は付けない) |
| 最初の回 | 予定の開始 (DTSTART) はいつも 1 回目 (規則に合わなくても。Google と同じ)。`COUNT` はこの 1 回目を数える |
| 時刻の計算 | 時刻の予定は親の `tz` (IANA) の壁時計で繰り返す (毎週 14:00 は夏時間をまたいでも 14:00)。長さは経過時間で同じ。夏時間で無い時刻 (2:30 など) は zoneinfo の規則 (切り替え前のオフセットで読む = 1 時間後ろ)。終日の予定は日付だけで計算する |
| 無い日 | 毎月 31 日・第 5 曜日・2/29 の毎年は、その日が無い月 (年) を飛ばす (RFC と Google と同じ)。月末は `BYMONTHDAY=-1` |
| 回の鍵 (`occurrence_start`) | その回の**元の**開始。時刻の予定は UTC の `2030-01-10T05:00:00Z`、終日は `2030-01-10`。例外 (上書き) はこの鍵で親に付く |
| 回の id | 1 回目は親の id、2 回目からは `uuid5(親の id, 鍵)` (どの端末でも同じ、重ならない)。古い端末 (M69 より前) が id で並べても重ならないため |
| この予定だけ | 例外の行 (鍵ごと): 取り消し (`cancelled`) か、変えた項目 (`changed` ⊂ {title, time, location, description}) とその値。変えていない項目は親に従う。この予定だけでは終日 ↔ 時刻と規則は変えられない (`400 calendar_invalid_time` / `calendar_invalid_rrule`) |
| これ以降すべて | 系列を分ける: 古い親は `UNTIL` = その回の (親の tz の) 前日にする (`COUNT` は `UNTIL` に置き換える)。送った内容で新しい親を作り、規則はそのまま (`COUNT` は残りの回数に減らす) か送ったもの。分けた回より後の例外は、新しい系列の回の鍵と一致すれば新しい親へ移し、ほかは消す。通知 (人ごと) は新しい親にも写す。分ける回が 1 回目なら「すべての予定」と同じ |
| すべての予定 | 親を変える。回から開いたときは、その回の日付・時刻のずれ (親の tz の日数と新しい時刻) を親の開始に当てる (Google と同じく、系列の始まりの日は動かない)。**例外を残す規則**: 例外の鍵が変更後の系列でもまだ回であれば残し、回でなくなった (開始の時刻・曜日・規則・終日を変えた) ものは消す。残った例外は自分が変えた項目だけ優先し、ほかは新しい親に従う (題名だけ変えた例外は、親の場所の変更を受ける) |
| 単発 ↔ 繰り返し | `PATCH /calendar/events/{id}` で `rrule` を送ると繰り返しにする / `null` で単発に戻す (例外は全部消す)。親の `PATCH` / `DELETE` は「すべての予定」と同じ |
| 通知 | 人ごとの通知は親に 1 つ (分前の値は全回に共通)。worker は「送る時刻がまだ来ていない一番近い回」だけを予約し、送ったら次の回を予約し直す |
| iCal | 人ごとの秘密の URL `GET /api/v1/calendar/ical/{token}.ics` (ヘッダの認証なし)。トークンは 32 バイトの乱数で、DB には SHA-256 だけ。作成の応答に 1 回だけ URL を載せる。範囲は 90 日前〜400 日後。繰り返しは RRULE + EXDATE + RECURRENCE-ID の VEVENT |

### 10.2 データ (移行 0063)

`calendar_events` に足す列:

| 列 | 意味 |
|---|---|
| rrule | text NULL。正規化した RRULE。NULL = 単発 |
| tz | varchar(64) NULL。繰り返しの壁時計のゾーン (`rrule` があれば必須: CHECK)。作成・変更の `tz` (無ければおやすみ時間のゾーン、それも無ければ Asia/Tokyo) |
| series_end | timestamptz NULL。最後の回の終わりの上限 (余裕を持たせた値、`UNTIL` / `COUNT` から計算)。NULL = 終わりなし。期間の検索で親を絞るためだけに使う |

索引: `calendar_events_recurring_idx (owner_id, channel_id) WHERE rrule IS NOT NULL AND deleted_at IS NULL`。単発の索引と検索は
`rrule IS NULL` の行だけを見る。

`calendar_event_overrides` (この予定だけの変更と取り消し):

| 列 | 意味 |
|---|---|
| series_id, occurrence_start | 主キー。親 (ON DELETE CASCADE) と回の鍵 (§10.1) |
| cancelled | bool。true = この回は無い (iCal の EXDATE) |
| changed | text[]。変えた項目 (`title` / `time` / `location` / `description`) |
| title, location, description | `changed` にあるときの値 |
| all_day, starts_at, ends_at, start_date, end_date | `time` が `changed` にあるときのその回の日時 (親と同じ種類。§2 の長さの規則も同じ CHECK) |
| created_at / updated_at | |

`calendar_event_alarms` に `occurrence_start` (varchar NULL) を足す: 繰り返しの予定で `fire_at` がどの回の通知か。NULL は単発、
または「400 日先まで回が無いので、その時刻に予約し直す」だけの目覚まし (送らない)。

`calendar_feeds` (iCal の購読 URL):

| 列 | 意味 |
|---|---|
| id | uuid (v7) |
| user_id | 持ち主 (ON DELETE CASCADE) |
| token_hash | bytea、一意。トークンの SHA-256 |
| scope | `all` (自分用 + 参加しているチャンネルの共有) / `personal` (自分用だけ) |
| created_at / last_used_at | 最後に読まれた時刻 (1 時間に 1 回だけ書く) |

1 人 5 個まで (`409 calendar_feed_limit`)。

### 10.3 API (`/api/v1`)

予定の形 (`CalendarEventData` / `CalendarEventOut`) に足す項目 (足すだけ。単発の予定の今の項目は変わらない):

- `series_id` (uuid): 親の id。単発は自分の id。
- `occurrence_start` (string): その回の鍵 (§10.1)。単発は自分の開始 (同じ形)。
- `recurring` (bool)、`rrule` (string | null、親の規則)、`tz` (string | null、親のゾーン)。
- 回の項目 (`title`・日時・`location`・`description`) は例外を当てた値。`id` は回の id (§10.1)、`can_edit` は親で決まる。
- `alarm` に `occurrence_start` (どの回の通知か。単発は null)。

エンドポイント:

- `GET /calendar/events?from&to[&channel_id]`: 単発の予定に加えて、繰り返しを期間の中で展開した回 (取り消した回は出さない、
  動かした回は動かした先で) を返す。期間の規則 (100 日まで)・1000 件までは同じ。`GET /calendar/upcoming` も展開する。
- `GET /calendar/events/{id}`: 親の id なら 1 回目 (親そのもの)。2 回目以降の回の id は 404 (端末は `series_id` で開く)。
- `POST /calendar/events`: `rrule` (省略 = 単発) を足した。`tz` が繰り返しのゾーンにもなる。`UNTIL` が開始より前は 400。
- `PATCH /calendar/events/{id}`: `rrule` (送れば変える、`null` で単発に) と `tz` (繰り返しのゾーン) を足した。親を変える =「すべての予定」(回からのずらしはしない)。
- `PATCH /calendar/events/{series_id}/occurrences/{occurrence_start}`: 本文は `PATCH` と同じ項目 + `scope` (`this` / `following` / `all`、必須)。
  日時は**その回の**新しい日時で送る。`rrule` は `following` / `all` だけ。応答は `this`: その回、`following`: 新しい系列の 1 回目、`all`: 系列の 1 回目。
- `DELETE /calendar/events/{series_id}/occurrences/{occurrence_start}?scope=this|following|all`: 204。
- 繰り返しでない予定にこの 2 つは `400 calendar_not_recurring`。鍵がその系列の回でない (取り消し済みは回のまま) と `404 calendar_occurrence_not_found`。
  鍵は上の形のほか、オフセット付きの日時も受けて UTC に直す。
- `POST /calendar/ical-feeds {scope}` → 201 `{feed: CalendarFeedOut, url}` (`url` はこの応答だけ)。`GET /calendar/ical-feeds` → `CalendarFeedOut[]`
  (`{id, scope, created_at, last_used_at}`、トークンなし)。`DELETE /calendar/ical-feeds/{id}` → 204 (自分のでなければ 404 `calendar_feed_not_found`)。
  URL を作り直すときは消して作る。
- `GET /calendar/ical/{token}.ics`: 認証なし。`text/calendar; charset=utf-8`。知らない・消したトークン、無効化された人は 404。

新しいエラー: `calendar_invalid_rrule` (400)、`calendar_not_recurring` (400)、`calendar_occurrence_not_found` (404)、`calendar_feed_limit` (409)、
`calendar_feed_not_found` (404)。

### 10.4 同期

- イベントの種類は増やさない。親・例外・分割のどれが変わっても `calendar.event.updated` (親の内容。`recurring: true`、`id` = 親の id、
  `occurrence_start` = 1 回目) を送る。系列を消したら `calendar.event.deleted {id: 親の id}`。分割では古い親と新しい親の 2 つが届く。
- 端末: `recurring` の `calendar.event.updated` (と、自分の繰り返しの変更の応答) では、開いている期間 (そのチャンネルか、全部の窓) を
  **読み直す** (回の展開はサーバだけがする)。`calendar.event.deleted` は `series_id` が一致する回を全部外す。単発の予定は今までどおり。
- 通知: `calendar.alarm.updated` の `alarm.occurrence_start` で回が分かる。通知は系列に 1 つなので、手元のその系列の回すべてに当てる。
- M69 より前の端末: 回は重ならない id で届き、単発と同じに見える (繰り返しの表示・編集はない)。2 回目以降を開いて変えると 404。
  `calendar.event.updated` は 1 回目 (親の id) を入れ替えるだけなので、ほかの回は次に読むまで古い。

### 10.5 通知 (worker)

- 通知の行は親に人ごとに 1 つ。予約は「送る時刻 (`fire_at`) が今より後の、一番近い回」(取り消した回は飛ばし、動かした回は動かした先で、
  終日 ↔ 時刻の分前の読み替えは §6 と同じ)。400 日先まで回が無ければ (毎年で間隔が大きいなど)、その時刻に目覚ましとして予約する
  (`occurrence_start` NULL、送らずに予約し直す)。系列が終われば `cancelled`。
- `fire_due`: 繰り返しの行は、その回がまだあり見られることを確かめて `fired` の `calendar.alarm.updated` (回の鍵付き) を書き、
  同じトランザクションで次の回を予約して `pending` の `calendar.alarm.updated` を書く。止まっていて過ぎた回は送らずに次へ。
- プッシュの計画は `fired` のイベントの回の鍵と `fire_at` から文を作る (行はもう次の回を指しているため。行が消えていたら送らない)。
- 親・例外・分割の変更のたびに、その系列の全員の通知を予約し直して `calendar.alarm.updated` を送る (冪等: 同じ入力から同じ予約)。

### 10.6 iCal の購読

- 中身: その人が見られるもの (§3。ゲストもメンバーのチャンネルだけ)。`scope = personal` は自分用だけ。チャンネルの予定の SUMMARY は
  「題名 (#チャンネル)」。範囲は 90 日前〜400 日後に重なる単発と、範囲に回がある系列。
- 系列は親の VEVENT に `RRULE` (保存した規則。`UNTIL` は時刻の予定なら tz のその日の終わりを UTC に直す)、取り消した回の `EXDATE`、
  変えた回ごとに `RECURRENCE-ID` 付きの VEVENT (同じ UID)。単発の時刻の予定は UTC (`...Z`)、繰り返しの時刻の予定は `TZID` と
  `VTIMEZONE` (zoneinfo から範囲内の切り替えを書き出す)、終日は `VALUE=DATE` (DTEND は翌日)。
- RFC 5545 の TEXT のエスケープ (`\\` `\;` `\,` `\n`)、75 オクテットでの折り返し (UTF-8 の文字の途中で切らない)、CRLF。UID は `<親の id>@chikuwachat`。
- 安全 (SECURITY.md §2.5・§8): URL を知っていれば誰でも読めるので、画面で必ずそう書く。IP ごとのレートリミット (60 回 / 分)、
  アクセスログのパスは `/api/v1/calendar/ical/***`。トークンは保存しない (SHA-256 だけ)。消せば即座に 404。人が無効化されたら 404。

### 10.7 画面 (Desktop / Web)

- 予定のダイアログに「繰り返し」: しない / 毎日 / 毎週 (曜日を選ぶ。初期値は開始の曜日) / 毎月 (「毎月 10 日」か「第 2 火曜日」・
  「最終金曜日」) / 毎年 / カスタム (間隔「N 日 / 週 / か月 / 年ごと」と、終了: なし / 日付 / 回数)。選んだ規則の要約
  (「毎週 火・木曜日、12 月 20 日まで」) を下に出す。読むだけの表示と一覧の行にも 🔁 と要約。
- 繰り返しの回を保存・削除すると「繰り返しの予定の変更」ダイアログ: 「この予定」「これ以降すべて」「すべての予定」。終日 ↔ 時刻や
  繰り返しを変えたときは「この予定」を出さない。
- カレンダーの見出しの「購読」で「カレンダーを購読 (iCal)」: 範囲 (すべて / 自分のカレンダーだけ) を選んで作る → URL を 1 回だけ
  表示してコピー (「この URL を知っている人は誰でも予定を見られます」)、作った URL の一覧 (範囲・作成日・最後に読まれた日) と削除、
  Google カレンダー (他のカレンダー → URL で追加) と Apple のカレンダー (ファイル → 新規カレンダー照会) の手順。

### 10.8 M68 で決めたこと

- 単発の予定を表示する端末の規則 (§5) は変えない。繰り返しは窓ごとに読み直すだけにして、端末で RRULE を展開しない (iOS / Android と
  Web で展開の実装を 3 つ持たない)。
- 1 回の応答の 1000 件の上限は展開後の回で数える (毎日の予定でも 100 日の期間で 100 回)。
- 通知の予約は「今」と「系列の始まり」の遅い方から 400 日先まで探す (遠い先に始まる系列も作ったときに予約できる)。
- 「すべての予定」を回から開いたとき、端末は変えた項目だけを送る (時刻を変えていなければ系列はずれない)。「この予定」も変えた項目
  だけを送る (変えていない項目を例外の項目にしない: あとで系列の場所などを変えたとき、その回にも届くように)。
- 画面の「終了 (なし / 日付 / 回数)」はカスタムだけでなく、繰り返すときはいつも出す。毎月は、開始が月の最終日なら「月末」
  (`BYMONTHDAY=-1`)、最終週なら「最終 X 曜日」(`BYDAY=-1XX`) も選べる (第 5 X 曜日は「最終」だけ)。
- `calendar_feeds.last_used_at` は 1 時間に 1 回だけ書く (カレンダーのアプリが何度読んでも DB に書き込みが増えない)。
- 予定 1 件の .ics の書き出しは入れなかった (後で)。

### 10.9 スマホ (M69)

iOS と Android に同じもの: フォームの「繰り返し」(Web と同じ選択肢と要約、`apps/shared` に規則 → 要約の共通の例を置く)、
保存・削除の 3 通りの確認、回の id と `series_id`、`recurring` のイベントで読み直す、通知の `occurrence_start`。購読 URL の作成・一覧・削除は
「自分 → カレンダーを購読」に。
