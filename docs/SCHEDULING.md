# 日程調整 (M53〜M54)

状態: **M53 (サーバと Desktop / Web) 完了 (2026-10-01)**。M54: **iOS 完了 (2026-10-01)**、Android は予定。実装で決めたこと・直したことは §7。

調整さんのような日程調整を、メッセージに付くアンケート (M14b の poll) の一種として作る。候補の日時ごとに
○ △ × で答え、集計を表で見る。決めたら、その日時をチャンネルのカレンダー (CALENDAR.md) の予定にする。
今の `/日程` (日付を選択肢にした複数選択の投票、M30) はこれに置き換える。

## 1. 方針

- **アンケートを広げる**。`messages.poll` に `kind = "schedule"` を足す。候補の見出し (「10/3 (土) 14:00〜15:00」) は
  これまでどおり `options` の文字列にも入れるので、M53 より前のアプリでも普通の複数選択のアンケートとして表示でき、
  そこからの投票は ○ として数える。
- 回答は 1 人 1 候補につき ○ / △ / × のどれか (未回答は行が無い)。一言 (コメント) を 1 人 1 つ付けられる。
- 決めるのは作った人、チャンネルのオーナー、管理者。決めると回答は締め切られ、チャンネルのカレンダーに予定ができ、
  スレッドに「決まりました」の返信が付く (答えた人へのメンション付き。通知は既存のメンションの経路)。
- 締切の日時、繰り返し、候補ごとの定員は入れない (要望が出たら)。

## 2. データ

`messages.poll` (JSONB) に足す項目 (`kind` が無いものは今までどおりの `"choice"`):

```json
{
  "kind": "schedule",
  "question": "M2 中間発表の練習",
  "options": ["10/3 (土) 14:00〜15:00", "10/5 (月) 終日", ...],   // 表示用の見出し (古いアプリ用にも)
  "slots": [ {"starts_at": "...Z", "ends_at": "...Z"}, {"date": "2026-10-05"} ],  // 時刻か終日のどちらか
  "tz": "Asia/Tokyo",              // 見出しを作ったタイムゾーン (作った人の端末)
  "multiple": true, "anonymous": false, "closed_at": null,
  "decided": null                  // 決めたら {"index": 2, "event_id": "...", "by": "...", "at": "..."}
}
```

候補は 2〜20 個。時刻の候補は 15 分〜12 時間、終日は 1 日。過去の日時も作れる (振り返りの調整もあるため) が、
作成フォームは今日以降を出す。

`poll_votes` に `answer` 列を足す: `'yes' | 'maybe' | 'no'` (既定 `'yes'`。M53 より前の投票と古いアプリからの投票は yes)。
`kind = "choice"` のアンケートは今までどおり yes だけ。

`poll_comments`: `message_id`, `user_id` (主キー)、`text` (1〜100)、`updated_at`。

## 3. API (`/api/v1`)

- 作成: 既存の `POST /channels/{id}/messages` の `poll` に `kind: "schedule"`, `slots`, `tz` を付ける (`options` はサーバが
  `slots` と `tz` から作る。送られても無視)。
- 回答: `PUT /messages/{id}/poll/answers` `{"answers": [{"index": 0, "answer": "yes"}, ...], "comment": "…" | null}` —
  自分の回答をまとめて置き換える (全候補を送らなくてよい。送らなかった候補は未回答に戻る)。締切後・決定後は 409。
- 決定: `POST /messages/{id}/poll/decide` `{"index": 2, "create_event": true}` / 取り消し `DELETE /messages/{id}/poll/decide`
  (予定は消さない。決めた人が消す)。
- 既存の `POST /messages/{id}/poll/votes` (M14b) は schedule でも使えるが yes だけ (古いアプリ用)。

`PollOut` に足すもの: `kind`, `slots`, `tz`, `decided`, `answers` (候補ごとの `{yes: [user_id…], maybe: [...], no: [...]}`、
匿名なら空で `yes_count` / `maybe_count` / `no_count` だけ)、`comments` (`[{user_id, text}]`)、`my_answers` (応答だけ)。

## 4. 同期・通知

- 回答・コメント・決定はメッセージの変更 (`message.updated`、`change = "poll"`) として流れる (今の投票と同じ。seq を取る)。
- 決定したとき: チャンネルのカレンダーに予定 (題名 = 質問、日時 = 候補、説明 = 「日程調整で決定」とメッセージへのリンク) を
  作り (`create_event` のとき。DM は共有カレンダーが無いので作らない)、スレッドに決めた人の名前で返信する:
  「📅 日程が決まりました: 10/3 (土) 14:00〜15:00 (○ 5 · △ 1)」 + 答えた人へのメンション。

## 5. 画面

- 作成: `/日程` か 入力欄の ＋ →「日程調整」。題名、候補 (カレンダーで日を複数選ぶ → 時刻 (開始・長さ) か終日 → 候補が並ぶ。
  1 つずつ時刻を変えたり消したりできる)。
- カード (タイムライン): 題名、候補ごとに ○ △ × の数と、自分の答え (○ △ × の 3 つのボタン、もう一度押すと未回答)。
  ○ がいちばん多い候補に印。「表で見る」で、人 × 候補の表 (調整さん と同じ形、コメント付き) を開く。
- 決定: 作った人・オーナー・管理者に「この日に決める」(候補ごと)。決まったカードは決まった候補を大きく出し、予定を開ける。
- 古いアプリ: 見出しの複数選択として見え、押すと ○。

## 6. 実装の順番

- **M53**: サーバ (poll の kind・answers・comments・決定・予定の作成) と Desktop / Web。
- **M54**: iOS と Android。

## 7. M53 で決めたこと・直したこと

API と形 (openapi/openapi.json が正):

- 作成: `poll: {kind: "schedule", question, slots: [{starts_at, ends_at} | {date}], tz, anonymous?}`。`tz` は必須 (IANA 名)。
  候補は 2〜20 個、同じ候補 (同じ時刻・同じ日) の重複は 422。`options` は送られても無視し、`multiple` は常に true。
  本文は今までどおり 「📊 題名」 (古いアプリが本文を隠す規則がそのまま効く)。候補の順は送られた順 (Web は日付順に並べて送る)。
- 見出しは `tz` で 「10/3 (土) 14:00〜15:00」「10/5 (月) 終日」。日をまたぐ候補は 「22:00〜24:00」「23:00〜翌1:30」。
  Web は同じ規則で手元でも見出しを出す (`apps/desktop/src/ui/scheduling.ts` の slotLabel)。
- `PollOut` に足したもの: `kind` (`"choice"` | `"schedule"`)、`slots` (`{starts_at, ends_at, date}` のどちらか一方)、`tz`、
  `decided` (`{index, event_id, by, at}`)、`answers` (候補ごとの `yes` / `maybe` / `no` と `*_count`)、`respondents`
  (答えたかコメントした人、最初に答えた順。表の行)、`comments` (`[{user_id, text}]`)、`my_answers` (候補ごとの
  `"yes"|"maybe"|"no"|null`)、`my_comment` (`""` = なし)。`my_*` は `mine` と同じく本人宛ての応答だけで、イベントでは null
  (SYNC_PROTOCOL.md §8 のマージ)。schedule の `votes` / `counts` / `mine` は ○ だけ (古いアプリの表示)。
- `PUT /messages/{id}/poll/answers`: `answers` は置き換え (送らない候補は未回答)。`comment` は **送らなければ今のまま**、
  文字列で設定、`null` か空白だけで削除 (1〜100 文字、改行と連続する空白は 1 つの空白に)。何も変わらなければ 200 で seq を
  取らない、変われば 201。候補の番号が範囲外は 400 `poll_option_invalid`、同じ番号 2 回は 422。
- 決定すると `closed_at` も入れる (古いアプリが締め切りとして見る)。取り消すと `decided` と `closed_at` を両方 null にする
  (決める前に「締め切る」していても回答を再開する)。締め切った後でも決められる。
- `POST …/poll/decide` を同じ候補でもう一度送ると何もしない (200、再送の扱い)。別の候補は 409 `poll_decided` (先に取り消す)。
  決定・取り消しの権限が無いと 403 `poll_decide_restricted`。choice の投票に answers / decide は 400 `poll_not_schedule`。
  決定後の回答・古いアプリの投票は 409 `poll_decided` (締め切りだけなら今までどおり `poll_closed`)。
- 決定は 1 つのトランザクション: poll の更新 (`message.updated` change `poll`)、予定 (`calendar.event.updated`)、スレッドの
  返信 (`message.created`、親の `parent_thread` 付き)。投票がスレッドの返信なら、決定の返信も同じスレッド (親) に付く。

問題だった点と直し方:

1. **匿名の日程調整で決定の返信が答えた人をメンションすると、誰が答えたかが分かる** (匿名の約束 M27 に反する)。
   匿名のときはメンションを付けない (件数だけ)。コメントも匿名では `user_id = null` で、自分のコメントは `my_comment` で知る。
2. **メンションする「答えた人」が決まっていなかった**。どれかの候補に ○ △ × のどれかを付けた人かコメントした人で、
   決めた本人とチャンネルを抜けた人を除く (最初に答えた順)。
3. **予定を作れない人が決めることがある** (投稿制限のチャンネルで、オーナーではない作成者がスレッドに作った日程調整)。
   カレンダーの規則 (CALENDAR.md §3) はそのまま守り、決定ごと 403 `posting_restricted` にする (`create_event: false` なら決められる)。
   アーカイブされたチャンネルでは回答も決定もできない (409 `channel_archived`)。
4. **予定の説明のリンクの URL の元** が無かった。`PUBLIC_BASE_URL` があればそれ、無ければ要求の来た URL
   (本番は uvicorn の `--proxy-headers` で公開の URL になる)。説明は 「日程調整で決定\n<URL>/m/<メッセージ id>」。
   予定の持ち主は決めた人 (変更・削除は今までどおり作成者・オーナー・管理者)。通知 (アラーム) は付けない。
5. **`/日程` の置き換え**: Web では `/日程` だけで空のフォーム、`/日程 題名 日付 …` (M30 の書き方、時刻の終わりが無ければ 1 時間、
   時刻が無ければ終日) で候補を入れたフォームを開く (すぐには作らない)。読めない引数は今までどおり使い方を出す。
   iOS / Android の `/日程` は M54 まで M30 のまま (`apps/shared/templates.json` の検証ケースも変えていない)。
   M54 (iOS): Web と同じく `/日程` はフォームを開く (引数の候補入り。M30 の 10 個までの制限は無く、フォームが 2〜20 個を確かめる)。
   共有の検証ケースは M30 の読み方 (Templates.parseSchedule。readSchedule の上に作り直した) の検証としてそのまま使う。
6. **(M54 iOS) 決定で予定を作れないとき**: 3. の 403 `posting_restricted` はトーストにせず、「予定を作れません」の確認で
   「予定を作らずに決定」(`create_event: false`) を出す (Web はエラーのトーストだけ)。
