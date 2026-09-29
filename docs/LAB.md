# LAB (研究室向け機能の設計)

2026-09-28 の設計提案 (復元、[ROADMAP.md](ROADMAP.md) 参照)。A (L1 名簿と学年グループ) と B (L2 times) は実装済み (M23・M24)。C (投稿テンプレート) と G (ゼミの日程調整、`/日程`) = L3 も実装済み (M30、仕様は DATA_MODEL.md message_templates)。H (確認の拡張と教員の権限) と J (プライバシー) = L4 も実装済み (M31)。**次は L7 (I 4 月の受け入れ・年度更新・卒業、2027 年 3 月までに)**。実装した部分は DATA_MODEL.md などに移し、本書には未実装の設計を残す。

## 0. 前提と方針

- **想定する利用者**: 教員 1〜5 人 (教授・准教授・講師・助教)、学生 5〜25 人 (B3/B4、M1、M2、D1〜D3、研究生)。ほかに秘書・共同研究者・卒業生が少し。合計 5〜30 人。
- **構成は変えない (CLAUDE.md)**
  - modular monolith に葉モジュールを足すだけにする。
  - outbox、seq による差分同期、既存の投稿経路 (冪等キー) を通す。
  - 新しいプロセス、Redis、キューは足さない。
  - **権限は増やさない**。system role は admin / member / guest のまま。身分と学年は「表示とグループ分けの材料」として扱い、権限には使わない。
- **研究室専用のものは `lab` モジュールに閉じ込める**
  - `lab` に入れるもの: 名簿、学年、年度更新、卒業処理。
  - times・テンプレート・定期投稿・締切は、研究室以外でも意味のある汎用機能として作る。
- **優先順位**
  1. 毎日使うもの: times、@m1 などのグループ、日報・週報
  2. 年に数回だが外せないもの: 4 月の受け入れ、年度更新、卒業
  3. あると嬉しいもの: 添削依頼、Times フィード

## 1. 今の機能で既にできること / 足りないもの

| 研究室での用途 | 使える既存機能 | 足りないもの |
| --- | --- | --- |
| 教員・学生の区別、研究テーマ | 肩書 `title` (M11d)、プロフィールカード、メンバーディレクトリ (M13g) | 自由記述なので学年での絞り込みや名簿順の並べ替えができない。指導教員の関係を持てない |
| @M1 / @教員 への一斉連絡 | ユーザーグループ (M12k、`<@group:id>` をメンバーに展開、未読メンション・プッシュ・メンション一覧に効く) | 学年と連動しない (毎年手で入れ替え)。名前は英小文字と数字だけ (`@m1` や `@faculty` は可、`@教員` は不可) |
| お知らせと既読確認 | 投稿制限チャンネル (M15a)、重要度と「確認しました」(M15e) | 未確認の人の一覧と催促が無い。オーナーは作成者だけで、あとから教員をオーナーにできない |
| times | 公開チャンネル (日本語名も可)、参加 = フォロー、自分のサイドバー節、通知レベル | 誰の times かがデータに無い。他人の times が太字の未読として並ぶ。一覧とフィードが無い |
| 週報の催促 | 予約送信 (1 回だけ)、リマインダー (本人宛て) | 繰り返しが無い。提出状況が見えない |
| 学会などの締切 | 個人のリマインダー、リンク集、ピン留め | チャンネル全員向けの締切と、自動の事前通知が無い |
| ゼミの日程調整 | 投票 (複数選択、選択肢 10 個まで) | 日付の選択肢を作るのが手間 |
| 4 月の受け入れ | 招待リンク (ロール、参加チャンネル、回数、期限) | 学年・身分・グループ・times を一緒に設定できない |
| 卒業 | 無効化、匿名化、ゲスト | 年度単位の一括処理が無い。ゲストにしても元のチャンネルに残ったまま |
| 過去の研究ログの検索 | PGroonga 検索、`in:` `from:` `has:` など | times だけに絞る方法が無い |
| 教員と学生のプライバシー | 非公開チャンネルと DM は、admin でもメンバーでなければ読めない。個人ごとの既読は他人に見えない。編集履歴は本人だけ | admin なら誰でも非公開 → 公開に変換できる。在席表示を隠せない |

## 2. 提案する機能

### A. 研究室プロフィールと学年グループ (新しい葉モジュール `lab`)

**画面と操作**
- プロフィールカード: 「M1」「准教授」などのチップ、研究テーマ、指導教員 (押すとその人のカード)、「times を見る」。
- メンバーディレクトリを「名簿」表示にする。
  - 並び: 教員 → 研究員 → D3〜D1 → M2 → M1 → B4 → 研究生 → スタッフ → 共同研究者 → 卒業生。
  - 身分と学年で絞り込める。
- 誰が何を設定するか:
  - 研究テーマ: 本人
  - 身分・学年・指導教員: admin (Desktop の管理画面に「研究室」タブ。表でまとめて編集)
- `@b4` `@m1` `@m2` `@d` `@faculty` `@students` `@alumni` は自動で保たれる「管理グループ」にする。
  - 管理画面では編集できない (鍵の表示)。
  - メンバーがいないグループは @ 候補に出さない。

**データ**

```sql
CREATE TABLE lab_profiles (
  user_id        uuid PRIMARY KEY REFERENCES users(id),
  position       text NOT NULL,   -- professor | associate_professor | lecturer | assistant_professor
                                  -- | researcher | staff | student | alumni | external
  grade          text,            -- B3 | B4 | M1 | M2 | D1 | D2 | D3 | RS(研究生)
  research_topic varchar(200),
  advisor_ids    uuid[] NOT NULL DEFAULT '{}',
  graduated_year smallint,        -- 卒業・修了した年度 (alumni のとき)
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((position = 'student') = (grade IS NOT NULL))
);
ALTER TABLE user_groups ADD COLUMN managed_key text UNIQUE;
-- 例: 'grade:M1' / 'position:faculty' / 'students' / 'alumni'
```

- `users` 表には列を足さない。users は汎用のままにし、`groups` と同じく独立した表とイベントで持つ。
- 学籍番号・成績・評価は保存しない。

**API**
- 読み取り: `GET /lab/profiles`。bootstrap に `lab_profiles`、変更はイベント `lab_profile.updated` (audience all)。
- ゲストの見える範囲: 同じチャンネルにいる人だけ。今のユーザー一覧と同じ絞り込み規則を使う。
- 更新: `PUT /admin/lab/profiles/{user_id}` (admin)、`PATCH /users/me/lab` (本人は研究テーマだけ)。
- 管理グループの同期:
  - `lab` が同じトランザクション内で `groups.sync_managed_in_tx(key, name, member_ids)` を呼び、`group.updated` を出す。
  - 手で PATCH / DELETE すると `409 group_managed`。
  - 依存の向き: `lab → users, groups, channels, admin`。

### B. times

**画面と操作 (Slack の times 文化)**
- サイドバーに「Times」節を作る。
  - 自分の times を先頭に、フォロー中の times を新しい投稿順に並べる。
  - 行はチャンネル名ではなく「山田 太郎」+ 時計アイコン + 学年チップで表示する。
- times が無い人には、節に「自分の times を作る」を出す。名前の既定は `times_<username>` (あとで変更可)。
- 「Times 一覧」: 全員の times を名簿順に並べ、フォロー / フォロー解除 / 全員フォローができる。
- **他人の times は「静かな未読」にする**
  - 太字にせず、「未読のみ」の絞り込みや未読の合計にも入れない。新着は行の小さな点だけで示す。
  - メンションされたときだけ、バッジとプッシュを出す。
  - その times の通知を「すべて」にしたときだけ、通常のチャンネルと同じ扱いにする (教員が特定の学生を密に追う用途)。
  - 既存のミュートを使わない理由: ミュートと level=none はメンションでもプッシュしない (planner.py:181-183)。
- 自分の times は通常のチャンネルと同じ (他人のコメントは未読になり、通知も届く)。
- 学生が times を作ったら、指導教員は自動でフォローする (静かな未読なのでうるさくならない)。
- 誰が書き込めるか:
  - 既定は誰でも書ける (Slack と同じ)。
  - 本人が「コメントはスレッドだけ」を選べる。これは既存の `posting_policy = owners` をそのまま使う (times を作った本人がオーナー)。
- times では、入力欄のテンプレート (C) に「日報」を最初に出す。

**データと API**

```sql
ALTER TABLE channels ADD COLUMN times_owner_id uuid REFERENCES users(id);
CREATE UNIQUE INDEX channels_times_owner_uniq ON channels (times_owner_id) WHERE times_owner_id IS NOT NULL;
ALTER TABLE channels ADD CONSTRAINT times_is_named_channel
  CHECK (times_owner_id IS NULL OR type IN ('public', 'private'));
```

- 作成
  - `POST /users/me/times`: 冪等で、既にあれば既存のものを返す。
  - `POST /admin/users/{id}/times`: 受け入れ時に admin が作る。
- `ChannelOut.times_owner_id` を足す。
- 一覧は既存の `GET /channels` (公開 + 参加中) を `times_owner_id` で絞れば足りる。フォローは既存の join / leave を使う。
- **静かな未読の規則**: `times_owner_id != null && times_owner_id != 自分 && level != 'all'` のとき、「メンションがあるときだけ未読」とする。
  - SYNC_PROTOCOL.md に 3 端末共通の規則として書き、同じテストケースで確かめる。
  - サーバの `/sync/summary` の `has_unread` も同じ規則にする。
  - アプリのバッジは、チャンネルでは元々メンション数だけなので変更しない。
- (L8) Times フィード: `GET /times/feed?before=&limit=`
  - 参加している times のトップレベル投稿を新しい順に返す。カーソルは (created_at, id)。
  - **チャンネルごとに LATERAL で上位 N 件を取ってから混ぜる**。計測では 0.95 ms。素直に `IN + ORDER BY` で書くと 43 ms で、履歴に比例して遅くなる。
- (L8) 検索に `is:times` 修飾子を足す。卒業生の研究ログも「引き継ぎの資料」として検索できるようにする。

### C. 投稿テンプレート (日報・週報・ゼミ議事録)

**実装済み (M30)**。決まった仕様は DATA_MODEL.md の message_templates (置き換え・挿入・並び・名前の規則)。以下は設計時の文面。

- **操作**: 入力欄の「テンプレート」ボタン、または `/日報` `/週報` で本文に挿入する (送信はしない)。
- **置換**: 挿入時に `{date}` `{weekday}` `{week}` を置き換える (例: 2026/09/28 (月)、2026-W40)。
- **既定の例**
  - 日報: 今日やったこと / 明日やること / 困っていること
  - 週報: 今週の進捗 / 来週の予定 / 相談したいこと / 論文・学会の状況
- **データ**
  - `message_templates (id, scope 'workspace'|'user', owner_id, name, body, suggest_in 'times'|'any', position, created_at, updated_at)`
  - ワークスペース共通のテンプレートは admin、個人のテンプレートは本人が編集する。
  - bootstrap に `templates`。変更は `template.updated` (共通は audience all、個人は本人だけ)。
- **3 端末で結果を揃える**: 置換の規則は apps/shared にテストベクタを置く (emoji / errors と同じ運用)。

### D. 定期投稿と週報の回収

**画面と操作**
- チャンネルの ⋯ →「定期投稿」で設定する。
  - 例: 「毎週金曜 17:00 に『今週の週報をこのスレッドに返信してください @students』」
  - 設定項目: 曜日 (複数可)、時刻、本文、回収するかどうか (対象グループと提出期限。例: 翌週月曜 9:00)。
- 回収つきの投稿には「提出 7/10」のカードを付ける。
  - 押すと提出済み / 未提出の名前を出す。スレッドに返信した人を提出済みとする。
- 提出期限を過ぎても未提出の人には、**本人にだけ**リマインダーを送る (みんなの前で名指ししない)。

**データ**

```sql
CREATE TABLE recurring_posts (
  id uuid PRIMARY KEY, channel_id uuid NOT NULL REFERENCES channels(id),
  created_by uuid NOT NULL REFERENCES users(id), body text NOT NULL,
  weekdays smallint[] NOT NULL, time_of_day smallint NOT NULL, tz text NOT NULL,
  collect_group_id uuid REFERENCES user_groups(id), collect_due_minutes int,
  next_run_at timestamptz NOT NULL, last_run_at timestamptz,
  enabled boolean NOT NULL DEFAULT true, created_at timestamptz, updated_at timestamptz
);
ALTER TABLE messages ADD COLUMN report jsonb;  -- {group_id, due_at, nudged_at}。回収つきの親メッセージだけ
```

**投稿のしかた**
- 投稿者は「研究室 bot」にする。
  - role bot のユーザーで、ログインできない。M13a の `create_bot_in_tx` を流用する。
  - 作った人が卒業しても定期投稿が止まらない。
- 既存の投稿経路で投稿する。冪等キーは `uuid5(rule_id, 予定時刻)`。
  - 投稿してから次回予定を更新するまでの間にワーカーが落ちても、二重投稿にならない。
- ワーカーは `_scheduled_send_loop` (main.py:143-160) に 1 つ呼び出しを足すだけにする。

**提出状況と催促**
- 提出状況: `GET /messages/{id}/report` → `{expected, submitted}`。
  - グループの有効なメンバーと、スレッドの返信者との差分で出す。
  - タイムラインに載せる `MessageOut` には人数だけを入れる。
- 催促: `reminders.create_system_in_tx(user_id, message_id, note, remind_at)` を足す。
  - 既存のリマインダー (プッシュ kind=reminder、一覧、バッジ) をそのまま使う。
  - F と H の催促も同じ関数を使う。

### E. 締切 (学会・奨学金・修論提出など)

**画面と操作**
- チャンネルの見出しに、次の締切のチップを出す (例: 「全国大会 原稿 あと 3 日」)。
- サイドバーに「締切」: 参加中のチャンネルの締切を、今週 / 今月 / それ以降 / 過ぎたもの に分けて並べる。
- 作成時の項目: タイトル、日時 (終日も可、JST)、URL、メモ、事前通知。
  - 事前通知の既定: 7 日前・3 日前・前日・当日。
  - 作成・変更・取消ができるのは、ゲスト以外のメンバー。
- 事前通知は研究室 bot がチャンネルに投稿する。締切をずらしたら、新しい日時で通知し直す。

**データと API**

```sql
CREATE TABLE deadlines (
  id uuid PRIMARY KEY, channel_id uuid NOT NULL REFERENCES channels(id),
  title varchar(120) NOT NULL, due_at timestamptz NOT NULL, all_day boolean NOT NULL DEFAULT false,
  url text, note varchar(500), notify_offsets int[] NOT NULL DEFAULT '{10080,4320,1440,0}',
  created_by uuid NOT NULL REFERENCES users(id), cancelled_at timestamptz,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE deadline_notices (   -- 投稿済みの通知 = 冪等性の記録
  deadline_id uuid, offset_minutes int, due_at timestamptz, message_id uuid,
  PRIMARY KEY (deadline_id, offset_minutes, due_at)
);
```

- API: `GET /deadlines?channel_id=&after=`、`POST /channels/{id}/deadlines`、`PATCH /deadlines/{id}`、`DELETE /deadlines/{id}`。
- 変更は `deadline.updated` (audience channel)。bootstrap には今後 90 日分を入れる。
- 葉モジュール `deadlines`。依存の向き: `deadlines → channels, messages, admin (bot)`。
- カレンダー購読 (ICS) は、トークン付き URL の扱いが必要になるので後回しにする。

### F. 添削・レビュー依頼

- **画面と操作**
  - 原稿の添付や Overleaf のリンクを含むメッセージに「レビュー依頼」を付ける。依頼先 (教員) と希望日を指定する。
  - カードに状態 (依頼中 / 対応中 / 完了) を出す。
  - 「依頼」一覧で、自分宛ての依頼と自分が出した依頼を見られる。
  - 希望日になったら、依頼先にだけリマインダーを送る。
- **データ**
  - `review_requests (message_id PK, requester_id, assignee_ids uuid[], due_at, status, updated_at, done_at)`
  - 状態が変わったら seq を消費し、`message.updated change=review` を出す (投票・確認と同じ仕組み)。
- 修論・学会の締切前は、教員に 10 人分の依頼が集中する。その整理に効く。

### G. ゼミの日程調整

**実装済み (M30)**。文法とラベルの規則は DATA_MODEL.md の message_templates の「`/日程`」。以下は設計時の文面。

- 既存の投票で足りる。クライアントにヘルパを足すだけで、サーバの変更は無い。
  - 例: `/日程 ゼミ 10/3 10/4 10/6` → 「10/3 (金)」などを選択肢にした複数選択の投票を作る。
- 毎週のゼミの案内は、D の定期投稿で出す。

### H. お知らせの確認 (M15e の拡張) と教員の権限

**実装済み (M31)**。決まった仕様は DATA_MODEL.md reminders と SECURITY.md。以下は設計時の文面。

- 確認を求めた投稿に「未確認: 3 人」と名前の一覧を出す。
  - 未確認 = チャンネルのメンバー − 確認済みの人 − 投稿者 − bot と無効化された人。
- 投稿者または admin が「未確認の人にリマインド」できる。
  - `POST /messages/{id}/ack/remind` → 本人にだけ届くリマインダー。1 時間に 1 回まで。
- `PATCH /channels/{id}/members/{user_id} {role}` (オーナーか admin) を足す。#お知らせ のオーナーに教員を加えられるようにする。

### I. 4 月の受け入れ・年度更新・卒業

**受け入れ (4 月や配属のとき)**
- 招待リンクに「プリセット」を付けられるようにする。
  - 設定できるもの: 身分、学年、指導教員、times を作るかどうか、参加するチャンネル (これは既存)。
  - 例: 「2027 年度 B4」、10 回まで、7 日間有効。
  - 受諾したときに lab_profiles・管理グループ・times を同じトランザクションで作る。
- 任意で、#general に研究室 bot の「ようこそ」を投稿する。
- 研究室のしおりは Canvas の提案の側で扱う。Canvas ができたら、「新メンバー向け」の Canvas を招待プリセットに紐付ける。

**年度更新 (3 月末〜4 月)**
- 管理画面の「年度更新」に学生全員の表を出し、人ごとに次の既定案を示す。

| 今の学年 | 既定案 |
| --- | --- |
| B4 | M1 か卒業 |
| M1 | M2 |
| M2 | D1 か修了 |
| D1 | D2 |
| D2 | D3 |
| D3 | 修了か D3 のまま |

- admin が人ごとに選んで「適用」する。
- API:
  - `POST /admin/lab/rollover/preview`
  - `POST /admin/lab/rollover {academic_year, items}`: 学年・管理グループ・卒業処理を 1 トランザクションで行う。
- `lab_rollovers (academic_year PK, applied_by, applied_at, before jsonb)` を持つ。
  - 同じ年度を二度適用すると 409 にする。
  - `before` を使って元に戻せる。監査ログにも残す。

**卒業生 (推奨: ゲストにする)**
- 卒業・修了を選んだ人に行うこと:
  1. position を alumni にし、学年グループから @alumni へ移す。
  2. times をアーカイブする (読み取り専用で、検索には残る)。
  3. 選択によってロールを guest にする。
  4. #alumni と「残すチャンネル」(論文化を続けているチャンネルなど) 以外の、公開・非公開チャンネルから外す。
  5. DM は残す。
- **4 の「外す」まで 1 回の操作で行うことが重要**。ゲストの見える範囲は参加しているチャンネルで決まるので、ロールを変えるだけでは研究室のチャンネルが見え続ける。
- 連絡が不要な人は無効化する。本人の申し出があれば匿名化する (どちらも既存の機能)。

### J. 教員と学生のプライバシー

**実装済み (M31)** (1・2・4。3 は作らない方針のまま)。以下は設計時の文面。

**すでにあるもの**
- 非公開チャンネルと DM は、admin でもメンバーでなければ読めない。
- 誰がどこまで読んだかは他人に見えない。明示的な既読は「確認しました」だけ。
- 編集履歴は本人だけが見られる。

**足すもの**
1. 非公開 → 公開の変換は、そのチャンネルのメンバーである admin に限る (今は admin なら誰でもできる、channels/service.py:323)。学生だけの非公開チャンネルを、教員の admin が公開にできないようにする。
2. 在席表示を隠す設定 `users.presence_hidden` を足す。他の人からは常にオフラインに見える。Hub が配信するときに絞る。
3. 投稿カレンダーのような活動の見える化は作らない。作るとしても本人が選んだときだけにする。
4. サーバ・DB・バックアップに触れる運用者は技術的には全部読める。このことを README とオンボーディングに明記する。admin を教員ではなく技術職員や D の学生が持つ選択肢もあると示す。

## 3. 共通の部品

- **研究室 bot**: 最初に使うときに bot ユーザーを 1 人作る。D・E・I の投稿者になる。
- **`reminders.create_system_in_tx`**: 本人にだけ届く催促 (D の未提出、F の希望日、H の未確認)。既存のリマインダー一覧・プッシュ・バッジを使い回すので、新しい通知の種類は増えない。
- **ワーカー**: 既存の `_scheduled_send_loop` に、定期投稿・締切の通知・回収期限の処理を足す。
  - `FOR UPDATE SKIP LOCKED` と冪等キーを使う。
  - 新しいプロセスは要らない。
- **3 端末で揃える規則**: 静かな未読、テンプレートの置換、名簿の並び、日程のラベル。SYNC_PROTOCOL.md と apps/shared のテストベクタに書き、3 つの実装を同じケースで確かめる。
- **文書の更新**
  - ARCHITECTURE.md: 依存の向きを追記する (`lab → users, groups, channels, admin`、`deadlines → channels, messages, admin, reminders`、`recurring → channels, messages, admin, reminders, groups`)。
  - 決定の記録に D23 を加える: 研究室固有のものは `lab` に閉じ込め、権限には使わない。

## 4. 端末ごとの作業

| 機能 | サーバ | Desktop / Web | iOS | Android |
| --- | --- | --- | --- | --- |
| A 名簿・学年グループ | `lab` モジュール、マイグレーション、bootstrap、管理グループの同期 | 管理画面「研究室」タブ、カード、名簿、@候補 | カード、名簿、研究テーマの編集 | 同左 |
| B times | `times_owner_id`、作成 API、`/sync/summary` の規則 | Times 節、一覧、作成、静かな未読 | 同左 (ChannelListView) | 同左 (Channels.kt) |
| C テンプレート | 表、API、bootstrap | ボタン、`/日報` | 同左 | 同左 |
| D 定期投稿・回収 | 表、ワーカー、bot、report API | 設定画面、提出状況カード | 提出状況カード (設定は Desktop のみ) | 同左 |
| E 締切 | 葉モジュール、ワーカー | 見出しのチップ、一覧、作成 | 一覧、チップ、作成 | 同左 |
| F 添削依頼 | 表、`message.updated` | カード、依頼一覧 | 同左 | 同左 |
| G 日程調整 | なし | `/日程` | 同左 | 同左 |
| H 確認の拡張 | remind API、メンバーのロール変更 | 未確認の一覧、ボタン | 同左 | 同左 |
| I 年度更新・受け入れ | rollover、招待プリセット、卒業処理 | 年度更新の画面、招待プリセット | 受諾画面の表示だけ | 同左 |
| J プライバシー | 変換の制限、`presence_hidden` | 設定の切り替え | 同左 | 同左 |

管理系の画面は、これまでと同じく Desktop / Web だけに置く。

## 5. 計測 (この提案のために実行したこと)

**条件**
- compose の PostgreSQL 17.11 に一時 DB を作り、`alembic upgrade head` を適用した。計測後に削除した。
- データ: 30 人、times 30 本 × 3,000 件、通常チャンネル 10 本 × 5,000 件 (計 140,000 件)。全員が全 40 チャンネルに参加。
- アプリの `reads.states_for_user` をそのまま 7 回ずつ呼び、中央値を取った。

**未読集計**

| 利用者の状態 | 対象 | 未読の合計 | 中央値 |
| --- | --- | --- | --- |
| 全部既読 | 通常 10 本 | 0 | 8.4 ms |
| 全部既読 | 40 本 | 0 | 33.0 ms |
| 他人の times 29 本 × 3,000 件が未読 | 40 本 | 87,000 | 93.2 ms |
| 何も読んでいない | 40 本 | 135,330 | 124.0 ms |

- 未読 3,000 件の COUNT 1 本は 0.875 ms (Bitmap Index Scan)。
- 時間の大半は、チャンネルごとに 1 往復するループ (reads/service.py:31-42) にかかっている。
- **結論**: times で参加チャンネルが 30 増えても、bootstrap は +20〜60 ms 程度で済む。必要になったら 1 本の GROUP BY にまとめられる (この点は性能の検討側で扱う)。

**Times フィード (最新 50 件)**
- `IN + ORDER BY seq DESC LIMIT 50`: 43.4 ms。
- チャンネルごとに LATERAL で上位 50 件を取ってから混ぜる形: 0.95 ms。フィードはこの形で書く。

## 6. 作らないもの

- 権限としての「教員ロール」(RBAC)。
- 成績・出欠・評価・学籍番号。
- 在室管理。
- ビデオ会議。
- 外部カレンダーとの双方向同期。
- LLM による週報の要約 (RAG は範囲外という方針のまま)。

## 7. リスク

- **機能の増やしすぎ**: 各機能を葉モジュールにし、1 機能ずつ「サーバ → Desktop → iOS → Android」の順でコミットする。既存の M11〜M16 と同じ進め方にする。
- **未読規則のずれ**: 3 端末とサーバの `/sync/summary` の 4 か所に同じ規則が要る。共有テストベクタが無いと必ずずれる。
- **卒業処理の誤り**: 誤って外すと研究室の履歴が見えなくなる。ゲストにしてもチャンネルに残せば情報が漏れる。preview、`before` からの取り消し、監査ログ、権限のテストで守る。
- **bot の投稿**: bot は投稿制限チャンネルにも書ける (M15a の例外)。bot を悪用されないよう、定期投稿と締切を設定できる人をオーナー / admin に限る案もある。
- **監視されている感**: 在席表示、times、確認ボタンが「教員に見張られている」と受け取られると、学生が使わなくなる。オプトアウトの手段と、運用者に何が見えるかの説明を先に出す。
- **時刻**: 繰り返しと締切は JST で決める。ただし `tz` を保存し、zoneinfo で計算する。日をまたぐ設定や年度の境目 (4/1) をテストする。
- **他の提案との順番**: Times フィードのモバイルでの置き場所は、スマホ UI の Slack 化 (別の提案) と一緒に決める必要がある。

## 8. Canvas とスマホ UI との関係

- **Canvas に向くもの**: 自由に書く文書 (研究室のしおり、ゼミの発表順、議事録の蓄積、研究テーマの紹介)。
- **Canvas では足りないもの**: 締切・週報の回収・添削依頼。通知や催促、状態の変化が要るので、構造化したデータにしている。
- **研究テーマの一覧**は A の名簿から自動で作れるので、Canvas に手で書き写さなくてよい。
- **スマホ UI**: Slack 流の下部タブ (ホーム / DM / アクティビティ / 自分) にするなら、次のように置ける。
  - Times フィードと締切: ホームの上部か「アクティビティ」
  - 自分の times: 「自分」

## 付録: マイルストーン L0〜L9 (設計時の範囲)

| ID | 名前 | 範囲 (設計時) | 工数 | 状態 |
| --- | --- | --- | --- | --- |
| L0 | 方針の決定と設計文書 | decisions_for_user の回答を反映する。docs/LAB.md (または ARCHITECTURE / DATA_MODEL / SECURITY / SYNC_PROTOCOL への追記) に書くもの: lab モジュールの境界、D23、静かな未読の規則、運用者に何が見えるかの説明。コードは書かない。 | S | 方針は ROADMAP.md §6 と利用者の回答で決定済み |
| L1 | 研究室プロフィールと学年グループ | サーバ: 葉モジュール lab、マイグレーション (lab_profiles、user_groups.managed_key)、GET /lab/profiles、bootstrap の lab_profiles、lab_profile.updated (ゲストの絞り込みあり)、PUT /admin/lab/profiles/{id}、PATCH /users/me/lab、groups.sync_managed_in_tx と 409 group_managed。Desktop: 管理画面「研究室」タブ、カードのチップ、名簿の並びと絞り込み、@候補での人数表示。iOS / Android: カード、名簿、研究テーマの編集。 | M | 実装済み (M23) |
| L2 | times (基本) | サーバ: channels.times_owner_id と一意インデックス、POST /users/me/times (冪等)、POST /admin/users/{id}/times、ChannelOut.times_owner_id、指導教員の自動フォロー、/sync/summary の静かな未読規則。3 端末: Times 節 (sectionChannels と同等の関数)、作成ボタン、Times 一覧 (フォロー / 全員フォロー)、hasUnread の静かな未読、共有テストベクタ。 | M | 実装済み (M24) |
| L3 | 投稿テンプレートと /日程 | サーバ: message_templates、API、bootstrap の templates、template.updated。3 端末: 入力欄のテンプレートボタン、/日報 /週報、{date}/{weekday}/{week} の置換 (apps/shared のテストベクタ)、/日程 で日付の選択肢の投票を作るヘルパ (クライアントのみ)。 | S | 実装済み (M30) |
| L4 | 確認の拡張・教員の権限・プライバシー | サーバ: reminders.create_system_in_tx、POST /messages/{id}/ack/remind (1 時間に 1 回)、PATCH /channels/{id}/members/{user_id} (ロール)、非公開→公開をメンバーの admin に限定、users.presence_hidden (Hub で絞る)。3 端末: 未確認の人の一覧とリマインドボタン、メンバーのロール変更、在席を隠す設定。 | M | 実装済み (M31) |
| L5 | 締切 (学会・提出物) | サーバ: 葉モジュール deadlines (deadlines、deadline_notices)、CRUD API、deadline.updated、bootstrap に 90 日分、研究室 bot、scheduled ループでの事前通知 (冪等)。3 端末: 見出しのチップ、「締切」一覧、作成と編集。 | L | 未着手 |
| L6 | 定期投稿と週報の回収 | サーバ: recurring_posts、messages.report、ワーカー (uuid5 の冪等キー、tz を使った次回計算)、GET /messages/{id}/report、MessageOut の report_summary、期限後の未提出者へ本人だけのリマインダー。Desktop: チャンネル ⋯ の「定期投稿」設定画面。3 端末: 提出状況のカード。 | L | 未着手 |
| L7 | 年度更新・受け入れプリセット・卒業処理 | サーバ: rollover の preview と apply、lab_rollovers (二重適用は 409、before で取り消し)、招待プリセット (身分・学年・指導教員・times)、卒業処理 (alumni、ゲスト化、指定外のチャンネルから外す、times のアーカイブ)、監査ログ。Desktop: 年度更新の画面、招待プリセット。モバイル: 受諾時の表示。2027 年 2 月までに終える。 | M | 未着手 |
| L8 | Times フィードと times の検索 | サーバ: GET /times/feed (LATERAL で上位 N 件、(created_at, id) カーソル)、検索修飾子 is:times。3 端末: フィード画面 (モバイルはスマホ UI の見直しに合わせてタブかホームの上部)。 | M | 未着手 |
| L9 | 添削・レビュー依頼 | サーバ: review_requests、状態変更 (message.updated change=review、seq を消費)、GET /reviews (自分宛て / 自分が出した)、希望日に依頼先へ本人だけのリマインダー。3 端末: 依頼の付与、カード、依頼一覧。 | M | 未着手 |
