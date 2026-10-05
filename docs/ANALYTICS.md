# ANALYTICS: 最終ログイン・最終利用と、管理者のアナリティクス (M116)

利用者の要望 (2026-10-06、Slack のアナリティクスのように): 管理者が、メンバーそれぞれがいつ最後にログインし、いつ最後に
アプリを使ったかを見られるようにし、ワークスペースの簡単な数字 (利用している人の数、1 日のメッセージ数など) を出す。
数十人の研究室・小さなチーム向けなので、集計の仕組みは増やさず、PostgreSQL の索引付きの問い合わせで済ませる。

## 1. 見せるもの・見せないもの

- 管理者 (ロール `admin`) だけが見る。メンバー・ゲストには API も画面も無い (`403 admin_required`)。
- 見えるのは **日時と数だけ**: 最終ログイン、最終利用、期間中の投稿の数、ログイン中の端末の数と種類。
  **メッセージの本文は一切含まない**。
- チャンネルごとの数は、公開チャンネルと「その管理者が参加している非公開チャンネル」だけ名前付きで出す。
  参加していない非公開チャンネルは **個数と投稿数の合計だけ**、DM・グループ DM も **件数と投稿数の合計だけ**
  (名前・メンバー・誰と誰の会話かは出さない)。MEMBERSHIP.md の「管理者も参加していない非公開の会話は読めない」に合わせる。
- 人ごとの投稿数 (「よく投稿している人」、メンバーの表の「30 日の投稿」) は全部の会話の合計で、どこに投稿したかは出さない。
- ボット (Webhook・フィード・AI・予約・モデレーション) は数えない (メンバーにも投稿者にも入れない)。

## 2. 記録するもの

### 2.1 `users.last_login_at` (最終ログイン)

- **新しいセッションを作ったとき** = ログイン。パスワードのログイン、Google でログイン (SSO)、招待からの登録
  (どれも `auth.open_session` を通る) で、そのトランザクションの中で書く。
- トークンの更新 (`/auth/refresh`) はログインに数えない (アプリが開いたままでも 15 分ごとに起きるため)。
- 書くのは素の SQL (`UPDATE users SET last_login_at = …`)。ORM で書くと `updated_at` (プロフィールの版) も動くため。

### 2.2 `users.last_active_at` (最終利用) と `user_activity_hours`

「アプリを使った」とみなすもの:

- 認証付きの HTTP 要求すべて (`get_auth_context`)。
- WebSocket がつながったとき、と `ping` の `active: true` (アプリが前面で使われている。SYNC_PROTOCOL.md §5.2)。
  背景で開いているだけの接続 (`active: false` の ping) は数えない。
- ログイン (§2.1 と同じ UPDATE で `last_active_at` も進める)。

書き方 (要求の流れの中で DB に書かない):

1. `ActivityTracker.touch(user_id)` (`server/app/modules/analytics/activity.py`、`app.state.activity`) は辞書を見るだけ。
   同じ人は **5 分に 1 回** (`ACTIVITY_WRITE_INTERVAL_SECONDS`、既定 300) だけ記録し、それ以外は何もしない。
2. 背景のループ (`activity`、`ACTIVITY_FLUSH_INTERVAL_SECONDS`、既定 60 秒) が、たまった分を 1 回のトランザクションで書く:
   `users.last_active_at` (今より新しいときだけ。複数のプロセスでも時刻が戻らない) と、
   `user_activity_hours (user_id, hour)` に UTC の 1 時間ごとの行 (`ON CONFLICT DO NOTHING`)。終了時にも 1 回書く。
3. 書けなかったときは記録を手元に戻し、次の回に書く。消えた人の記録は飛ばす。

結果、`last_active_at` の精度は 5〜6 分。プロセスが落ちたときは最後の 1 分ほどの記録が失われるが、次に使えばまた書かれる
(分析用の値で、同期や通知の正しさには関わらない)。

`user_activity_hours` は「1 日の利用メンバー数」のグラフのためだけの表で、**120 日** (`ACTIVITY_RETENTION_DAYS`) で消す
(毎時の掃除のループ)。1 人 1 日最大 24 行なので、50 人・120 日で最大 14 万行 (実際はずっと少ない)。
時間単位で持つのは、日の区切りを見る人の時間帯 (JST など) で切るため。30 分ずれの時間帯 (インドなど) では
日の境目が最大 30 分ずれる。5 分の間引きのため、時間の境目をまたいだ数分の利用がその時間に数えられないことがある。

### 2.3 移行 0087 の埋め戻し

- `last_login_at` = その人のセッションのうち一番新しい `created_at`。
- `last_active_at` = セッションの `last_used_at` と端末の `last_seen_at` のうち一番新しいもの。
- セッション・端末は終わってから 30 / 90 日で消えるので、それより前にいなくなった人は NULL (画面は「記録なし」)。
- 投稿の日時は使わない (Mattermost・Slack から取り込んだ過去の投稿で、前のシステムの日付になるため)。
- `user_activity_hours` は空から始まる (グラフは導入した日から埋まる。画面に注記)。

## 3. 集計の方法: 要求のたびに計算する (日ごとの集計表は作らない)

候補は「要求のたびに索引付きの問い合わせ」と「背景のループで日ごとの集計表を更新」の 2 つ。前者にした:

- メッセージの数は既存の部分索引 `messages_created_idx` (`created_at WHERE deleted_at IS NULL`、移行 0037) の範囲の
  走査で数えられる。新しい索引は要らなかった。
- 100 万件 (5 年分、1 日約 550 件) の試験データで EXPLAIN ANALYZE (PostgreSQL 17、開発機): 90 日分 (約 5 万行) の
  日ごとの数 23 ms、チャンネルごと 20 ms、人ごと 10 ms、`user_activity_hours` の日ごと 12 ms、メンバーの 30 日の投稿 2 ms。
  概要の 1 回は 100 ms 未満。管理者が時々開くだけなので十分。
- 集計表は、メッセージの削除・取り込み・時間帯の違いのたびに作り直しが要り、正しさを保つ仕組みが増える。数十人・数百万件の
  範囲では要らない。1,000 万件を超えて遅くなったら、日ごとの集計表 (チャンネル × 日 × 送り手の数) を足す。
- メンバーの表は全員分 (ボット以外、多くても数百行) を 1 回の問い合わせで取り、並べ替え・絞り込み・ページ分けは
  サーバーのメモリで行う (CSV と同じ規則)。

数え方:

- 「メッセージ」= 人 (ボット以外) の `type = 'user'` の投稿で、削除されていないもの。スレッドの返信も含む。
  参加・退出の行 (`system`) は数えない。
- 「利用メンバー (N 日)」= 無効化されていない人で `last_active_at` がその範囲にある人。
- 「1 日の利用メンバー数」= その日 (要求の時間帯) に `user_activity_hours` の行がある人の数。
- 「期間中に加わったメンバー」= 期間中に作られたアカウント (後で無効化された人も含む)。
- 「未ログイン」= 無効化されていない人で `last_login_at` が NULL。
- 期間 = 要求の時間帯で、今日を含む直近 `days` 日 (1〜90)。

## 4. API (管理者のみ、openapi/openapi.json)

- `GET /admin/analytics/overview?days=30&tz=Asia/Tokyo` → `AnalyticsOverviewOut`:
  `members` (`accounts`・`admins`・`guests`・`deactivated`・`active_1d`・`active_7d`・`active_30d`・`new_in_period`・
  `never_signed_in`)、`messages_in_period`、`series` (日ごとの `messages`・`active_members`・`new_members`)、
  `top_channels` (最大 10、公開と自分が参加している非公開)、`other_private_channels` / `direct_messages`
  (`conversations`・`messages` の合計だけ)、`top_posters` (最大 10、数だけ)。`tz` は IANA の名前 (クライアントの
  時間帯)、知らない名前は `422 validation_error`、`days` は 1〜90。
- `GET /admin/analytics/members?sort=&order=&status=&inactive_days=&q=&limit=&offset=` → `{items, total, limit, offset}`。
  `sort` は `name` (既定)・`role`・`status`・`created_at`・`last_login_at`・`last_active_at`・`messages_30d`、
  `order` は `asc` / `desc`。時刻が無い人は一番古いものとして並ぶ。`inactive_days` = 有効な人で N 日以上使っていない
  (または一度も) 人。`q` は名前・ユーザー名 (先頭の `@` は無視)。`limit` 1〜500 (既定 100)。
  行: `id`・`username`・`display_name`・`role`・`status` (`active` / `deactivated`)・`created_at`・`deactivated_at`・
  `last_login_at`・`last_active_at`・`messages_30d`・`devices` (ログイン中の端末の数)・`platforms`。
- `GET /admin/analytics/members.csv` (同じ絞り込み・並び、全行): UTF-8 (BOM 付き。Excel で日本語の名前が化けない)、
  列名は英語、時刻は UTC の ISO 8601、`=` `+` `-` `@` で始まる値は先頭に `'` を付ける (表計算ソフトの式にしない)。
  `Content-Disposition: attachment; filename="members-YYYYMMDD.csv"`、`Cache-Control: no-store`。
- `GET /admin/users` の `AdminUserOut` にも `last_login_at`・`last_active_at` (古いサーバーには無い)。

## 5. 画面 (Desktop / Web)

管理 →「アナリティクス」(「ユーザー」の隣):

- 期間 (過去 7 / 30 / 90 日、端末の時間帯で日を切る)、更新、集計した時刻、「管理者に見えるのは日時と数だけ」の注記。
- 概要のカード 6 枚: メンバー (管理者・ゲスト・無効の内訳)、過去 24 時間 / 7 日 / 30 日に利用 (未ログインの人数)、
  期間中のメッセージ、期間中に加わったメンバー。
- 棒グラフ 2 つ (インライン SVG、グラフのライブラリは使わない): 1 日のメッセージ数、1 日の利用メンバー数。系列は 1 つずつ
  なので凡例は無く、題が系列を表す。棒の上を指すと「10/6(火)：12」、指していなければ最大値。アクセントの色、上の角を丸めた
  細い棒、棒の間に 2px。値が 0 の期間は「この期間のデータはありません」。
- よく使われているチャンネル (メッセージ・投稿した人) と、参加していない非公開チャンネル・DM の合計の行、よく投稿している人。
- メンバーの利用状況の表: 名前・ロール・状態・最終ログイン・最終利用・30 日の投稿・端末。列の見出しで並べ替え
  (時刻と数は新しい / 多い順から)、「N 日以上利用なし」(7 / 14 / 30 / 90)、名前の絞り込み、100 人ごとのページ、
  「CSV を書き出す」(同じ絞り込みで全員)。時刻は「3 日前」(Intl の相対時刻、UI の言語)、指すと完全な日時。記録が無ければ
  「記録なし」。
- 「ユーザー」タブの各行の 3 行目に「最終ログイン 3 日前」/「未ログイン」(指すと最終ログインと最終利用の日時)。
- M116 より前のサーバーでは「このサーバはまだアナリティクスに対応していません」。

iOS / Android には管理の画面が無いので変更なし。

## 6. 設定

| 環境変数 | 既定 | 意味 |
| --- | --- | --- |
| `ACTIVITY_WRITE_INTERVAL_SECONDS` | 300 | 1 人の最終利用を書く最短の間隔 |
| `ACTIVITY_FLUSH_INTERVAL_SECONDS` | 60 | たまった記録を書く間隔 |
| `ACTIVITY_RETENTION_DAYS` | 120 | `user_activity_hours` を残す日数 |

## 7. 運営者のプライバシーポリシー

最終ログイン・最終利用の日時と投稿数を管理者が見られることは、利用者に知らせる (SECURITY.md §9、
website/docs/privacy.md)。公式アプリのプライバシーポリシー (kano.ac) に足す文は IMPLEMENTATION_PLAN.md の M116 の行。
