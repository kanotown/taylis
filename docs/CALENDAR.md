# カレンダー (M51〜M52)

テスターの要望 (2026-09-28、2026-10-01 に再度): 自分用のカレンダー、共有のカレンダー、予定の通知。
設計のもとは IMPLEMENTATION_PLAN.md「カレンダー (設計メモ)」。このあと、調整さん型の日程調整
(決まったら予定にする) とタスク (期限をカレンダーに出す) がこの上に乗る。

## 1. 方針

- **カレンダーは 2 種類だけ**: 自分用 (本人だけ) と、チャンネルの共有カレンダー (そのチャンネルのメンバー)。
  見える範囲と権限はチャンネルのメンバーシップと非公開・DM の規則をそのまま使い、新しい権限の仕組みを作らない。
  研究室全体の予定は、全員が入っているチャンネルに置く。
- **サーバが正**。端末は表示している期間の予定をサーバから読み、WebSocket のイベントで更新する。予定はチャンネルの
  seq とは別に管理する (メッセージの同期規則を複雑にしない)。再接続したら表示中の期間を読み直す。端末に予定を
  長く保存しない (オフラインでの表示は後で検討)。
- **最初は単発の予定だけ**。繰り返し、空き時間の検索、外部カレンダーの取り込みは入れない。書き出し (読み取り専用の
  iCal 購読 URL) は後で検討。
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

時刻の予定は `starts_at`/`ends_at`、終日は `start_date`/`end_date` のどちらか一方だけを持つ (CHECK 制約)。
索引: (channel_id, starts_at)、(owner_id, starts_at) where channel_id is null、終日も同様に date で。

`calendar_event_alarms` (予定ごと・人ごとの通知)

| 列 | 意味 |
|---|---|
| event_id, user_id | 主キー。共有の予定でも、通知を付けた人だけに届く |
| minutes_before | 0 / 5 / 10 / 15 / 30 / 60 / 1440 (前日) 。終日は 1440 か当日 8:00 (`minutes_before = -480` を「当日 8:00」と読む) |
| fire_at | 計算した送る時刻 (予定の変更で計算し直す) |
| status | pending → fired、または cancelled |

## 3. 権限

| 操作 | 自分用 | 共有 (チャンネル) |
|---|---|---|
| 見る | 本人 | チャンネルのメンバー (公開チャンネルでもメンバーだけ。ゲストはメンバーなら見られる) |
| 作る | 本人 | 投稿できるメンバー (アーカイブ済み・投稿制限は既存の `require_writable` と投稿ポリシーに従う) |
| 変える・消す | 本人 | 作った人、チャンネルのオーナー、管理者 |
| 通知を付ける | 本人 | 見られる人なら誰でも (自分の分だけ) |

チャンネルから抜けたら、その共有カレンダーは見えなくなり、付けていた通知も止まる (取り消す)。

## 4. API (`/api/v1`)

- `GET /calendar/events?from=<ISO>&to=<ISO>[&channel_id=]` — 期間 (最長 100 日) に重なる予定。自分用と、メンバーの
  チャンネルの共有予定を合わせて返す (`channel_id` を付けるとそのチャンネルだけ)。各予定に自分の通知 (`alarm`) を含める。
  終日の予定は日付で重なりを見る (端末のタイムゾーンで `from`/`to` を渡す)。
- `POST /calendar/events` — `{channel_id?, title, all_day, starts_at?, ends_at?, start_date?, end_date?, location?, description?, alarm_minutes?}`
- `PATCH /calendar/events/{id}` / `DELETE /calendar/events/{id}`
- `PUT /calendar/events/{id}/alarm` `{minutes_before}` / `DELETE /calendar/events/{id}/alarm`
- `GET /calendar/upcoming?days=2&channel_id=` — チャンネルの見出し・ホーム用の今日・明日の予定 (最大 10 件)。

`CalendarEventOut`: 上の列 + `can_edit` (bool) + `alarm` (`{minutes_before, fire_at}` か null) + `channel_name`。

## 5. 同期

- outbox のイベント: `calendar.event.updated` (作成も含む。予定全体を載せる) と `calendar.event.deleted` (`{id, channel_id}`)。
  宛先は共有ならそのチャンネルのメンバー、自分用なら本人の端末。チャンネルの seq は使わない。
- 端末は表示中の期間に重なる予定だけを更新する。重ならないイベントは捨ててよい (次に開いたときに読む)。
- 通知の変更 (`alarm`) は本人の端末へ `calendar.alarm.updated`。
- 再接続したら、表示中の期間とチャンネルの「今日・明日」を読み直す (イベントの取りこぼしはこれで埋まる)。

## 6. 通知 (プッシュ)

- worker が `fire_at <= now` の pending を送る (M12e の `fire_due` と同じ流れ)。`kind = calendar`、タイトル「予定」、
  本文「14:00 ゼミ (#m2-進捗)」、`channel_id` があればそのチャンネル、無ければ自分のカレンダーを開く。
- 予定の時刻が変わったら `fire_at` を計算し直す。過去になった通知は送らない。予定が消えたら取り消す。
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

## 8. 実装の順番

- **M51**: サーバ (表・API・イベント・通知の worker) と Desktop / Web。
- **M52**: iOS と Android。
- あとで: 繰り返し、予定の共有メッセージ、iCal 購読、日程調整から予定を作る (日程調整の M)、タスクの期限の表示。
