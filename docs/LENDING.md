# LENDING（備品の貸し出し）

2026-10-26 の設計。**L1（M167、台帳・サーバ）・L2（M168、貸し出し・サーバ）・L3（M169、許可と知らせ・サーバ）を実装（2026-10-26、移行 0123〜0125、§17）。L4（M170、Desktop / Web）・L5（M171、iOS）・L6（M172、Android）も実装（2026-10-26、§17.4〜§17.6）。L7（M173、CSV と QR のラベル）も実装（2026-10-26、移行なし、§17.7）。L1〜L7 のすべてを実装した。** マイルストーンは L1〜L7
（§16。M 番号は仮に M167〜M173、移行は 0123〜0125。並行する作業と重なれば振り直す）。§15 の質問は利用者がすべて推めのとおりに
決めた（2026-10-26）。

利用者（研究室の教員）の要望（2026-10-26）：研究室の PC・カメラ・本などを、メンバーが**自分で借りて自分で返す**ようにしたい。
貸し出しは数日〜数週間。今は紙やスプレッドシートで管理していて、誰が何を持っているか・返っていないものがすぐにはわからない。
借りるのに教員の許可が要るものがある。研究室以外でも使える汎用の機能（会社の備品、サークルの機材など）として作る。

画面の名前は「備品」（英語 Equipment、中国語 设备）、コード上の名前は `lending`（モジュール `app/modules/lending/`、表 `lending_*`、
API `/lending/*`、ナビの鍵 `lending`）。

関連：RESERVATIONS.md（担当者・アクティビティの知らせ・worker の形の元）、ACTIONS.md（ワークスペースの機能の切り替えと bootstrap）、
ROLES.md §2（権限の表）、LAB.md（名簿の教員・指導教員）、PUSH_NOTIFICATIONS.md §4（PushPlanner と DND）、SYNC_PROTOCOL.md §6
（イベント）、DATA_MODEL.md「attachments」「audit_logs」「lab_profiles」、SECURITY.md §4（添付の検査）、DEADLINES.md §4（朝の知らせの
時刻と取りこぼしの扱い）。

## 0. 結論

- **新しいモジュール `lending` を作る。** 予約（`reservations`）とは分ける：予約は「数に限りのあるものを**時間**で分け、担当者が
  外の管理画面で付け替える」もの、貸し出しは「1 つずつ番号のある**物**を、借りた人が**日**の単位で手元に持つ」もの。単位
  （1 時間 / 1 日）・受け渡し（担当者が押す / 本人が押す）・期限を過ぎたとき（入れ替え / 催促）が違い、1 つの表にまとめると
  どちらの規則も分岐だらけになる（§2）。
- **台帳**：備品（名前・分類・管理番号・置き場所・写真・付属品とメモ・状態）と分類。状態は `available`（貸出可）・`on_loan`
  （貸出中）・`in_repair`（修理中）・`retired`（廃棄・除籍）。写真は今の添付（`attachments.lending_item_id`、BlobStore・サムネイル）。
- **借りる・返す・延長は本人が押す**（受け渡しの操作は無い）。借りるときに返す日（備品ごとの最長の日数まで）・目的・
  （要るものは）教員の許可。返すときに状態（問題なし / 問題あり）とメモ。延長は最長の日数と回数の範囲で。
- **教員の許可は自己申告 + 教員への知らせ**：借りる人が「教員の許可を得た」に印を付けて許可した教員を選ぶ。その教員に
  アクティビティとプッシュが届き、「許可していない」を押せる（記録し、借りた人と備品係に知らせる）。「確認した」も押せる（任意）。
  許可が要るかは備品ごと（未設定なら分類の既定）。
- **備品係**はワークスペースの設定（`lending_settings.keeper_ids`）で管理者が選ぶ。台帳の登録・編集、状態の変更、代わりに
  返却を記録、延長の上限を超えた日付の変更、延滞の一覧を担う。管理者はいつも備品係と同じことができる（§3）。
- **期限の知らせ**：返す日の前日と当日の朝、過ぎたら毎朝、借りた人に。**3 日過ぎたら備品係にも**（朝に 1 つのまとめ）。知らせは
  アクティビティの項目（種類 `lending`）と、同じトランザクションの outbox（`lending.notice`）から作るプッシュ（`kind = lending`）。
  DND・おやすみ時間は今の PushPlanner の規則に従う（§8.3）。
- **同時に 2 人が借りる**：備品の行を `FOR UPDATE` でロックしてから状態を見る。さらに「貸出中の貸し出しは備品に 1 つ」の部分
  一意索引で DB が保証する。後の人は `409 lending_item_unavailable`。同じ人の送り直しは `client_request_id` で 1 つにまとめる（§7）。
- **同期**：`lending.updated {item_ids, settings}`（audience all、中身を載せない合図）で端末が読み直す。
- **端末**：Desktop / Web はすべて（台帳の管理を含む）。iOS・Android は見る・借りる・返す・延長・自分の貸し出し・教員の
  「許可していない」「確認した」（教員はスマホで知らせを受けることが多いため）。台帳の編集はしない。
- **v1 では作らない**：先の日付の取り置き（予約）、消耗品、ゲストの利用、分類ごとの見える人の制限、アプリ内の QR の読み取り。
  **後の段階で作る**：CSV の取り込み・書き出しと、QR のラベル（備品のリンク `/eq/<id>` を印刷する）（L7、§13。2026-10-26 に実装、§17.7）。

## 1. 目標と非目標

### 1.1 目標

- 誰が何をいつまで持っているかが、メンバー全員にすぐわかる（「貸出中」の一覧）。
- 返し忘れが、本人への催促と、長引けば備品係への知らせで自然に解ける。担当者が毎日台帳を見に行かなくてよい。
- 許可の要る備品で、「誰の許可で借りたか」が残り、許可していない教員はワンタップでそれを記録できる。
- 備品ごとの履歴（誰が・いつ・どれだけ・返したときの状態）が残り、壊れた・なくなったときに追える。
- 今の作り（モジュール・outbox・worker・アクティビティ・PushPlanner・添付・監査・権限の表）に乗せ、新しいサービスや依存を足さない。

### 1.2 非目標（v1 では作らない。§13）

- 先の日付の取り置き（「来週の月〜水にカメラを使う」）。
- 消耗品（数量・在庫・補充）。
- ゲストの利用（卒業生・学外の人が借りる）。
- 分類・備品ごとの見える人の制限（全員がすべての備品を見られる）。
- アプリ内のカメラでの QR の読み取り、NFC。
- 物の受け渡しの確認（備品係が渡す・受け取るボタン）。利用者の決定でセルフサービスにした。
- 金額・購入日・減価償却などの会計の項目（メモに書く）。

## 2. 予約（RESERVATIONS.md）との境界

| | 予約（`reservations`） | 貸し出し（`lending`、本書） |
| --- | --- | --- |
| 何を | 数に限りのある**枠**（シート 3 つ、装置 1 台）。枠どうしは区別しない | 管理番号のある**1 つずつの物**（カメラ A とカメラ B は別） |
| 単位 | 1 時間、14 日先まで | 1 日、数日〜数週間（備品ごとの最長） |
| 始まり | 担当者が外で付け替えて「割り当てた」 | 本人が「借りる」（物を棚から取る） |
| 終わり | 担当者が「外した」 | 本人が「返す」（棚に戻す） |
| 期限を過ぎたら | 待つ人のために入れ替える | 本人に毎朝催促、3 日で備品係 |
| 先の予定 | 予約そのもの | v1 には無い（§13.1） |

- **装置を時間で使う**（測定器を午後だけ、計算機を 3 時間）は予約の枠を使う。**物を持ち出す**のは貸し出しを使う。両方に
  当たるもの（共用のノート PC を「今日の午後だけ」）は貸し出し（1 日単位、当日返却）で足りる。
- 同じ物を両方に登録しない（二重に管理することになる）。画面の説明にこの区別を 1 行で書く（「時間で使う枠は「予約」へ」）。
- 先の日付の取り置きを足すときも予約のモジュールは使わない（単位と状態の遷移が違う）。貸し出しの中に「取り置き」（日付の範囲）を
  足す（§13.1）。

## 3. 役割と権限

### 3.1 備品係をどう持つか（決めたこと）

| # | 案 | 選んだもの ★ / 理由 |
| --- | --- | --- |
| K1 | ★ **ワークスペースの設定に人の一覧**（`lending_settings.keeper_ids`、20 人まで、ゲスト・ボット不可）。選ぶのは管理者 | 研究室の備品係は数人で、全部の備品を見る。延滞の知らせの宛先がはっきりする（予約の枠の担当者と同じ考え方を、ワークスペースに 1 組で） |
| K2 | 分類ごとの担当（`lending_categories.keeper_ids`） | 本は図書係、PC は PC 係のように分かれる研究室では便利だが、宛先の規則（分類に担当がいなければ？）と画面が増える。要望が出たら K1 の上に「分類の担当（いれば優先）」として足す（§13） |
| K3 | 新しいロール（`users.role = keeper`） | ロールは 1 人 1 つなので、運営やメンバーと両立しない。権限の表（ROLES.md）は機能の役割を持つ場所ではない |
| K4 | 運営（`manager`）を備品係にする | 運営は日々の運用の人だが、備品係は別の学生が務めることが多い。運営をそのまま備品係にはしない（運営も K1 の一覧に入れれば備品係） |

- 権限の表（ROLES.md §2）に **`lending.manage`**（admin ○、manager —）を足す：機能のオン・オフ、備品係の選び方、既定の日数などの
  設定。運営に開くかは利用者に確かめる（Q1）。
- **備品係である**（`can_keep(user)`）= `has_capability(user, "lending.manage")`、または `keeper_ids` に入っていて、有効でゲスト・
  ボットでない人。規則は予約の `access.py` と同じく `app/modules/lending/access.py` の 1 か所に置き、サービス・アクティビティの
  一覧とバッジ・WebSocket の audience・PushPlanner が同じものを使う。
- 備品係がいない（選んでいない・全員が権限を失った）とき、備品係あての知らせは管理者に届く（予約の「担当者がいなければ作った人、
  それもいなければ管理者」と同じ考え方）。

### 3.2 操作と権限

「人」は ROLES.md §1 の `PERSON_ROLES`（admin・manager・member）。ゲスト・ボットは機能そのものが見えない（§3.3）。

| 操作 | 人（member など） | 借りた本人 | 許可した教員（その貸し出しの `approver_id`） | 備品係 | 管理者 |
| --- | --- | --- | --- | --- | --- |
| 台帳・分類を見る、貸出中の一覧（誰が・いつまで） | ○ | ○ | ○ | ○ | ○ |
| 貸し出しの目的・許可の詳細・返却のメモを見る | — | ○ | ○ | ○ | ○ |
| 借りる（貸出可の備品） | ○ | — | — | ○ | ○ |
| 返す | — | ○ | — | ○（代わりに記録。本人に知らせる） | ○ |
| 延長（最長の日数・回数の範囲） | — | ○ | — | ○（範囲を超えた日付も、365 日まで） | ○ |
| 「許可していない」「確認した」 | — | — | ○ | — | — |
| 返却を知らせる（見守り） | ○ | ○ | ○ | ○ | ○ |
| 備品の登録・編集・写真・状態の変更・削除 | — | — | — | ○ | ○ |
| 分類の登録・編集・削除 | — | — | — | ○ | ○ |
| 延滞の一覧（日数・目的・連絡） | — | — | — | ○ | ○ |
| CSV の取り込み・書き出し（L7） | — | — | — | ○ | ○ |
| 機能のオン・オフ、備品係の選び方、既定の日数・時刻（`lending.manage`） | — | — | — | — | ○ |

- 「許可していない」「確認した」は**その貸し出しで選ばれた教員だけ**。管理者・備品係でも代わりには押せない（記録の意味が
  変わるため。`403 lending_not_approver`）。
- 返却のメモは「問題あり」のときに備品の状態を知る手がかりなので、備品の履歴では人にも見せる案もある。v1 は目的と同じく
  本人・教員・備品係・管理者だけ（Q6）。返却が「問題あり」だったことは履歴の印（🔧）で全員にわかる。
- 備品係が代わりに借りる操作は v1 には無い（セルフサービス。アカウントの無い人に貸すのも §13.4）。

### 3.3 見える人・機能の切り替え

- **機能はワークスペースの設定で切り替える**（`lending_settings.enabled`、既定オフ。ACTIONS.md D15 と同じ）。オフのあいだはナビ・
  タイルを出さず、API は `409 lending_disabled`（設定の読み書きを除く）。オフにしても台帳と記録は消えない。
- **ゲスト・ボットには見せない**（API は `403 guest_restricted`、bootstrap の `lending` は null）。卒業生などに貸すのは §13.4。
- 台帳は人の全員に見える（v1）。分類ごとの見える人の制限は §13.6。
- 無効化した人が借りたままの貸し出しは残る（物はその人の手元にある）。備品係の朝のまとめに「無効化された人の貸し出し」として
  出す（§8.2）。アカウントの削除（匿名化）でも貸し出しの行は残る（借りた人は「削除されたユーザー」）。

## 4. データモデル（移行 0123〜0125）

段階ごとに移行を分ける（L1 で 0123、L2 で 0124、L3 で 0125）。どれも downgrade を書く。

### 4.1 表

```sql
-- 0123（L1）：設定・分類・備品・履歴・写真
CREATE TABLE lending_settings (                       -- 1 行（無ければ既定値：オフ）
  singleton              boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled                boolean NOT NULL DEFAULT false,
  keeper_ids             uuid[] NOT NULL DEFAULT '{}',   -- 備品係（20 人まで。外部キーは無く、使うときに有効な人だけを数える）
  default_max_days       integer NOT NULL DEFAULT 14,    -- 備品・分類に無いときの最長の日数（1〜365）
  max_extensions         integer NOT NULL DEFAULT 2,     -- 本人ができる延長の回数（0〜10。備品係はこの外）
  keeper_overdue_days    integer NOT NULL DEFAULT 3,     -- 何日過ぎたら備品係に知らせるか（1〜30）
  notice_minute          integer NOT NULL DEFAULT 540,   -- 朝の知らせの時刻（0 時からの分。既定 9:00）
  tz                     varchar(64) NOT NULL DEFAULT 'Asia/Tokyo',  -- 返す日と知らせの時刻のゾーン（§8.1）
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE lending_categories (                     -- 50 個まで
  id                     uuid PRIMARY KEY,              -- UUIDv7
  name                   varchar(40) NOT NULL,
  name_key               text NOT NULL UNIQUE,          -- NFC + casefold（同じ名前を 2 つ作らない）
  position               integer NOT NULL,              -- 並び（備品係が並べ替える）
  requires_permission    boolean NOT NULL DEFAULT false, -- この分類の備品の既定
  max_days               integer,                       -- NULL = lending_settings.default_max_days
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lending_items (                          -- 2,000 個まで（廃棄を含む）
  id                     uuid PRIMARY KEY,              -- UUIDv7
  name                   varchar(80) NOT NULL,
  category_id            uuid REFERENCES lending_categories(id) ON DELETE RESTRICT,  -- NULL = 未分類
  code                   varchar(40),                   -- 管理番号（任意。「PC-03」「図-0123」）
  code_key               text,                          -- NFC + casefold + 前後の空白を除く
  location               varchar(80),                   -- 置き場所（「A棟 301 棚 2」）
  notes                  text,                          -- 付属品とメモ（2,000 字まで。「充電器・ケース・SD 64 GB」）
  photo_attachment_id    uuid REFERENCES attachments(id) ON DELETE SET NULL,  -- §4.3
  status                 varchar(16) NOT NULL DEFAULT 'available',  -- 'available' | 'on_loan' | 'in_repair' | 'retired'
  status_note            varchar(200),                  -- 修理中・廃棄の理由（備品係）
  requires_permission    boolean,                       -- NULL = 分類の既定
  max_days               integer,                       -- NULL = 分類 → 設定の既定（1〜365）
  current_loan_id        uuid,                          -- 貸出中の貸し出し（0124 で外部キー）。status = 'on_loan' のときだけ入る
  created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('available', 'on_loan', 'in_repair', 'retired')),
  CHECK ((status = 'on_loan') = (current_loan_id IS NOT NULL))
);
-- 管理番号は廃棄していないものの中で一意（廃棄した「PC-03」の番号を新しい PC に付け直せる）
CREATE UNIQUE INDEX lending_items_code_uniq ON lending_items (code_key) WHERE code_key IS NOT NULL AND status <> 'retired';
CREATE INDEX lending_items_category_idx ON lending_items (category_id, name);

CREATE TABLE lending_item_events (                    -- 備品ごとの履歴（§5.2 の history）。消さない
  id                     uuid PRIMARY KEY,              -- UUIDv7（カーソルに使う）
  item_id                uuid NOT NULL REFERENCES lending_items(id) ON DELETE CASCADE,
  loan_id                uuid,                          -- 貸し出しに関わるもの（0124 で外部キー）
  kind                   varchar(24) NOT NULL,          -- created | updated | status | borrowed | extended | returned
                                                        -- | permission_denied | permission_confirmed | due_changed
  actor_id               uuid REFERENCES users(id) ON DELETE SET NULL,
  at                     timestamptz NOT NULL,
  details                jsonb NOT NULL DEFAULT '{}'    -- 変えた項目・前後の状態・返す日・返却の状態など（本文のメモは入れない：貸し出しの行を見る）
);
CREATE INDEX lending_item_events_item_idx ON lending_item_events (item_id, id DESC);

ALTER TABLE attachments ADD COLUMN lending_item_id uuid REFERENCES lending_items(id) ON DELETE SET NULL;
CREATE INDEX attachments_lending_item_idx ON attachments (lending_item_id) WHERE lending_item_id IS NOT NULL;

-- 0124（L2）：貸し出し
CREATE TABLE lending_loans (
  id                     uuid PRIMARY KEY,              -- UUIDv7
  item_id                uuid NOT NULL REFERENCES lending_items(id) ON DELETE RESTRICT,
  borrower_id            uuid NOT NULL REFERENCES users(id),
  client_request_id      uuid NOT NULL,                 -- 端末が作る冪等のキー（§7.2）
  status                 varchar(16) NOT NULL,          -- 'active' | 'returned'
  borrowed_at            timestamptz NOT NULL,
  due_on                 date NOT NULL,                 -- 返す日（lending_settings.tz の日付。その日の終わりまで）
  original_due_on        date NOT NULL,                 -- 借りたときの返す日
  extension_count        integer NOT NULL DEFAULT 0,    -- 本人の延長の回数（備品係の変更は数えない）
  purpose                varchar(200) NOT NULL,         -- 目的（必須、1〜200 字）
  permission_required    boolean NOT NULL,              -- 借りた時点で許可が要ったか（後で備品の設定が変わっても変えない）
  approver_id            uuid REFERENCES users(id),     -- 許可した教員（自己申告）
  permission_state       varchar(16),                   -- NULL（要らない）| 'claimed'（申告）| 'confirmed'（教員が確認）| 'denied'（教員が否定）
  permission_decided_at  timestamptz,
  permission_note        varchar(200),                  -- 教員の一言（任意）
  returned_at            timestamptz,
  returned_by            uuid REFERENCES users(id),     -- 本人か備品係
  return_condition       varchar(8),                    -- 'ok' | 'issue'
  return_note            varchar(500),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('active', 'returned')),
  CHECK ((status = 'returned') = (returned_at IS NOT NULL)),
  CHECK (permission_required = (permission_state IS NOT NULL)),
  CHECK ((permission_state IS NULL) = (approver_id IS NULL)),
  CHECK (return_condition IS NULL OR return_condition IN ('ok', 'issue'))
);
-- 1 つの備品に貸出中は 1 つ（§7.1 の最後の守り）
CREATE UNIQUE INDEX lending_loans_active_uniq ON lending_loans (item_id) WHERE status = 'active';
-- 送り直しは同じ行（§7.2）
CREATE UNIQUE INDEX lending_loans_request_uniq ON lending_loans (borrower_id, client_request_id);
CREATE INDEX lending_loans_borrower_idx ON lending_loans (borrower_id, status, due_on);
CREATE INDEX lending_loans_due_idx ON lending_loans (due_on) WHERE status = 'active';     -- worker
CREATE INDEX lending_loans_item_idx ON lending_loans (item_id, borrowed_at DESC);
ALTER TABLE lending_items ADD FOREIGN KEY (current_loan_id) REFERENCES lending_loans(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE lending_item_events ADD FOREIGN KEY (loan_id) REFERENCES lending_loans(id);

-- 0125（L3）：知らせと見守り
CREATE TABLE lending_notices (                        -- アクティビティの項目（種類 lending、§8）。reservation_notices と同じ形
  id                     uuid PRIMARY KEY,
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id                uuid REFERENCES lending_items(id) ON DELETE CASCADE,
  loan_id                uuid REFERENCES lending_loans(id) ON DELETE CASCADE,
  key                    varchar(200) NOT NULL,         -- §8.2 の表のキー。1 人 1 キー 1 回
  role                   varchar(12) NOT NULL,          -- 'borrower' | 'approver' | 'keeper' | 'watcher'
  text                   text NOT NULL,                 -- 受け取る人の言語で書いた 1 行（M115）
  at                     timestamptz NOT NULL,
  done_at                timestamptz,                   -- 教員の作業の済み（判断したとき・返却から 14 日。ほかの知らせは済みを持たない）
  done_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (user_id, key),
  CHECK (role IN ('borrower', 'approver', 'keeper', 'watcher'))
);
CREATE INDEX lending_notices_user_idx ON lending_notices (user_id, at DESC);

CREATE TABLE lending_watches (                        -- 「返却を知らせる」（§6.7）
  item_id                uuid NOT NULL REFERENCES lending_items(id) ON DELETE CASCADE,
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, user_id)
);
```

- **`status` を列に持つ理由**：貸出中は `current_loan_id` からも分かるが、修理中・廃棄は人が決める状態なので列が要る。
  `on_loan` も同じ列に入れ、`CHECK` と同じトランザクションの更新で `current_loan_id` と食い違わないようにする（一覧の絞り込みが
  1 列で済む）。変えるのは備品の行をロックしたサービスだけ（§7）。
- **履歴を `audit_logs` に任せない理由**：監査ログは管理者の操作の記録で、API が無く（ROLES.md §3.2）、人に見せる形でもない。
  借りる・返すは人の日々の操作なので監査には入れず、`lending_item_events` に残す。台帳と設定の変更は両方に書く（§10）。
- 終わった貸し出しは消さない（履歴）。備品を消せるのは貸し出しが 1 度も無いときだけ（§6.2）。それ以外は廃棄にする。
- 上限（`too_many_lending_items` 2,000、分類 50、備品係 20）はどれも研究室の規模の数倍。一覧をページに分けずに 1 回で返すため（§5.2）。

### 4.2 名前と値の規則

- 名前・管理番号・置き場所は NFC にして前後の空白を除く。管理番号の重複の判定は `code_key`（NFC + casefold）。
- 返す日は**日付**（`date`）。その日の `lending_settings.tz` の 23:59:59 まで。「何日過ぎたか」はそのゾーンの今日 − `due_on`。
- 最長の日数は「今日から何日後まで」：借りるとき `due_on ≤ 今日 + max_days`（当日返却は `due_on = 今日`、0 日）。延長も
  「延長する日から」数える（§6.5）。実際の最長は 備品の `max_days` → 分類の `max_days` → 設定の `default_max_days`。
- 許可が要るか：備品の `requires_permission` → 分類の `requires_permission` → false。

### 4.3 写真（添付を使う）

- 備品の写真は 1 枚（v1）。今の `POST /attachments`（pending のアップロード、MIME の sniff・大きさの上限・サムネイルは今のまま）で
  上げ、`PATCH /lending/items/{id} {photo_attachment_id}` で bind する（`attachments.lending_item_id`、`status = attached`）。画像
  （`image/jpeg`・`png`・`webp`・`heic`）だけ（`400 lending_photo_invalid`）。他人の添付・別の備品やメッセージの添付は bind しない。
- 読み取りは `attachments` の `get_for_access` に枝を足す（DRIVE.md と同じ注入）：`lending_item_id` のある添付は、機能が有効で
  ゲストでない人が読める（台帳と同じ）。`/attachments/{id}/thumbnail` で一覧のサムネイルを出す。
- 写真を替える・外すと、前の添付を `deleted` にする（添付の GC がバイト列を消す）。備品の削除も同じ。
- 返却のときの写真（傷の記録）は §13.7。

## 5. API（`/api/v1`）

どの応答も構造化したエラー（`{"error": {"code", "message", "details"}}`、文言は `apps/shared/errors.json`）。OpenAPI に載せる。

### 5.1 設定

| | |
| --- | --- |
| `GET /lending/settings` | `LendingSettingsOut {enabled, keeper_ids, default_max_days, max_extensions, keeper_overdue_days, notice_minute, tz, is_keeper, updated_at}`。人なら誰でも（機能がオフでも読める。ゲストは `403 guest_restricted`） |
| `PATCH /admin/lending/settings` | 上の項目の一部（`is_keeper` を除く）。`lending.manage`（`403 admin_required`）。`keeper_ids` に無効・ゲスト・ボット・知らない人がいれば `400 lending_keeper_invalid`（`details.user_ids`）、21 人目は 422。範囲外の数・知らないゾーンは 422。監査 `lending_settings.updated`、`lending.updated {settings: true}` |

bootstrap に **`lending: LendingSummaryOut | null`**（ゲストと、オフのときは null。ACTIONS.md の `actions` と同じ）：
`{enabled, is_keeper, my_active_count, my_overdue_count, keeper_attention_count, settings_updated_at}`。タイル・ナビの数字（§12.1）に使う。

**`GET /lending/summary`**（L7）：bootstrap の `lending` と同じ `LendingSummaryOut` だけを返す（`lending.updated` の後に端末が数を読み直すため）。
bootstrap が null のところは、ゲスト・ボットは `403 guest_restricted`、機能がオフなら `409 lending_disabled`（ほかの台帳の API と同じ）。

### 5.2 分類と備品

| | |
| --- | --- |
| `GET /lending/categories` | `CategoryOut[]`（`position` の順）`{id, name, position, requires_permission, max_days, item_count}` |
| `POST /lending/categories` (201) | `{name, requires_permission?, max_days?}`。備品係（`403 lending_keeper_required`）。同じ名前は `409 lending_category_name_taken`、51 個目は `409 too_many_lending_categories` |
| `PATCH /lending/categories/{id}` | 同じ項目の一部と `position`。既定の変更は、その分類で値を持たない備品のこれからの貸し出しに効く（貸出中のものは変えない） |
| `DELETE /lending/categories/{id}` (204) | 備品が残っていれば `409 lending_category_in_use`（`details.item_count`） |
| `GET /lending/items` | `ItemOut[]`。既定は廃棄を除くすべて（`?include_retired=true` で含める）。名前の順（`core/collation` の日本語の並び）。**ページに分けない**（2,000 個まで、§4.1）。端末が手元で絞り込む（分類・状態・文字） |
| `GET /lending/items/{id}` | `ItemDetailOut`（`ItemOut` + 最近の貸し出し 5 件 + 見守りの有無 + 見守っている人の数 `watcher_count`（延長のダイアログの「待っている人がいます（2 人）」、§6.5）） |
| `POST /lending/items` (201) | `{name, category_id?, code?, location?, notes?, requires_permission?, max_days?, photo_attachment_id?}`。備品係。管理番号の重複は `409 lending_code_taken`（`details.existing_id`）、2,001 個目は `409 too_many_lending_items` |
| `PATCH /lending/items/{id}` | 同じ項目の一部（null で外す）。備品係。`status` はここでは変えない |
| `POST /lending/items/{id}/status` | `{status: available \| in_repair \| retired, note?}`。備品係。貸出中は `409 lending_item_on_loan`（先に返却を記録する）。廃棄から戻すときに管理番号が使われていれば `409 lending_code_taken`。同じ状態なら何もしない |
| `DELETE /lending/items/{id}` (204) | 備品係。貸し出しが 1 度でもあれば `409 lending_item_has_history`（廃棄にする） |
| `GET /lending/items/{id}/history?before=<event_id>&limit=50` | `{events: ItemEventOut[], next_before}`（新しい順、カーソル） |
| `PUT / DELETE /lending/items/{id}/watch` | 返却を知らせる（§6.7）。冪等（204） |
| `GET /lending/approvers` | 教員の候補（§6.4）`{user_ids, suggested_ids, self_approved}`（`suggested_ids` は呼んだ人の指導教員、`self_approved` は呼んだ人が `@faculty` で許可が要らないこと） |

`ItemOut`：`id, name, category_id, code, location, notes, photo (AttachmentOut | null), status, status_note, requires_permission
（実際の値）, requires_permission_source（item / category / default）, max_days（実際の値）, max_days_source（item / category / default）,
loan (LoanBriefOut | null), watching, created_at, updated_at`。`LoanBriefOut`：`id, borrower_id, borrowed_at, due_on, overdue_days, permission_state,
status, returned_at, return_condition`（目的などは載せない。`permission_state` は §3.2 の見える人にだけ入り、ほかは null）。

### 5.3 貸し出し

| | |
| --- | --- |
| `POST /lending/items/{id}/borrow` | `{client_request_id, due_on, purpose, permission_confirmed?, approver_id?}` → 201 `LoanOut`（送り直しは 200 で同じもの）。人（ゲスト不可）。状態が貸出可でなければ `409 lending_item_unavailable`（`details`: `status`、貸出中なら `loan_id`・`borrower_id`・`due_on`）。返す日が過去・最長を超えるなら `400 lending_due_invalid`（`details.reason`: past / too_long、`details.latest`）。同じ `client_request_id` を別の備品に使うと `409 idempotency_conflict`。許可が要るのに印か教員が無ければ `400 lending_permission_required`、教員が候補でない・自分・無効なら `400 lending_approver_invalid`。目的が空は 422 |
| `POST /lending/loans/{id}/return` | `{condition: ok \| issue, note?}`（`issue` のときは note が必須、422）。本人か備品係（ほかは `403 lending_not_yours`）。返却済みなら何もしない（200、今の `LoanOut`） |
| `POST /lending/loans/{id}/extend` | `{due_on}`。本人：今の返す日より後で（`400 lending_due_invalid`、reason `not_later`）、今日 + 最長の日数まで（reason `too_long`）、延長の回数が `max_extensions` まで（`409 lending_extend_limit`）。備品係：今日から 365 日先まで（reason past / too_long）、回数を数えず、前にも戻せる（記録 `due_changed`、本人に知らせる）。同じ日付は何もしない。教員が「許可していない」とした貸し出しは本人は延長できない（`409 lending_permission_denied`）。返却済みは `409 lending_loan_closed` |
| `POST /lending/loans/{id}/permission` | `{decision: denied \| confirmed, note?}`。その貸し出しの教員だけ（`403 lending_not_approver`）。許可が要らない貸し出しは `409 lending_permission_not_required`。返却から 14 日を過ぎたら `409 lending_loan_closed`。同じ判断の送り直しは何もしない。`confirmed` → `denied` には変えられる（後で気づいた）、`denied` → `confirmed` も変えられる（押し間違い。両方とも記録が残る） |
| `GET /lending/loans?scope=mine`（scope の既定） | 自分の貸し出し（貸出中を返す日の順、その後に返却済みを新しい順 50 件） |
| `GET /lending/loans?scope=active` | 貸出中のすべて（返す日の順）。誰が何をいつまで（`LoanOut` の目的などは見える人にだけ） |
| `GET /lending/loans?scope=overdue` | 返す日を過ぎたもの（過ぎた日数の多い順）。備品係（`403 lending_keeper_required`） |
| `GET /lending/loans?scope=approved` | 自分が教員として選ばれた貸し出し（貸出中と、返却から 14 日以内） |
| `GET /lending/loans/{id}` | 1 つ。見える人（台帳と同じ）。詳細の項目は §3.2 の規則で空にする |

`LoanOut`（OpenAPI では `LendingLoanOut`）：`id, item_id, item_name, item_code, borrower_id, borrowed_at, due_on, original_due_on, overdue_days,
extension_count, can_extend, latest_due_on（本人が延ばせる最も後の日）, purpose?, permission_required, approver_id?, permission_state?,
permission_decided_at?, permission_note?, returned_at, returned_by, return_condition, return_note?, status, details_hidden`。`?` の項目は
本人・教員・備品係・管理者にだけ入り、ほかの人には null（`details_hidden: true`）。`return_condition`（ok / issue）は伏せない：履歴の 🔧 の
印で全員にわかるもの（§3.2・Q6）で、伏せるのはメモだけ。

### 5.4 CSV（L7、§13.3）

| | |
| --- | --- |
| `GET /lending/items/export.csv` | 備品係。UTF-8（BOM 付き、Excel のため）。列は `管理番号, 名前, 分類, 置き場所, 状態, 許可が要る, 最長の日数, 付属品とメモ, 借りている人, 返す日`。既定は廃棄を除く（`?include_retired=true` で含める）。「許可が要る」「最長の日数」は備品そのものの値（空欄 = 分類・設定の既定） |
| `POST /lending/items/import?dry_run=true` | 備品係。multipart の CSV（`file`、1 MB・データ 2,000 行まで、UTF-8（BOM の有無を問わない）か Shift_JIS）。管理番号で既存と突き合わせ（管理番号の無い行は管理番号の無い備品と名前で）、無ければ作る（分類は名前で、無ければ作る）。`LendingImportOut {dry_run, created, updated, unchanged, skipped, new_categories, rows, errors: [{line, code, message}]}`（§17.7）。`dry_run=false` で同じ内容を 1 つのトランザクションで当てる（エラーが 1 つでもあれば `400 lending_csv_invalid`、`details.errors` で何も当てない）。状態・貸し出しは取り込まない（状態が「廃棄」の行は飛ばす）。監査 `lending_import.applied` |

### 5.5 エラーの一覧（`apps/shared/errors.json` に足す、ja / en / zh-Hans）

| HTTP | code | 意味 |
| --- | --- | --- |
| 409 | `lending_disabled` | ワークスペースで備品の機能がオフ |
| 403 | `lending_keeper_required` | 備品係・管理者だけの操作 |
| 403 | `lending_not_yours` | 本人（か備品係）だけの操作 |
| 403 | `lending_not_approver` | その貸し出しで選ばれた教員だけ |
| 404 | `lending_item_not_found` / `lending_loan_not_found` / `lending_category_not_found` | 無い |
| 409 | `lending_item_unavailable` | 貸出中・修理中・廃棄（`details.status` など、§5.3） |
| 409 | `lending_item_on_loan` | 貸出中の備品の状態は変えられない |
| 409 | `lending_item_has_history` | 貸し出しのあった備品は消せない（廃棄にする） |
| 409 | `lending_code_taken` / `lending_category_name_taken` | 重複（`details.existing_id`） |
| 409 | `lending_category_in_use` | 備品の残る分類 |
| 409 | `too_many_lending_items` / `too_many_lending_categories` | 上限（`details.limit`） |
| 400 | `lending_due_invalid` | 返す日（`details.reason`・`details.latest`） |
| 400 | `lending_permission_required` | 許可の印と教員が要る |
| 400 | `lending_approver_invalid` | 教員の候補でない |
| 400 | `lending_keeper_invalid` | 備品係に選べない人（`details.user_ids`） |
| 400 | `lending_photo_invalid` | 画像でない・他人の添付 |
| 409 | `lending_extend_limit` | 延長の回数の上限（`details.max_extensions`） |
| 409 | `lending_permission_denied` | 教員が「許可していない」とした貸し出しは延長できない |
| 409 | `lending_permission_not_required` | 許可の要らない貸し出し |
| 409 | `lending_loan_closed` | 返却済み（判断は返却から 14 日まで） |
| 400 | `lending_csv_invalid` | CSV の行のエラー（`details.errors`） |

端末は CLAUDE.md の区別（認証・権限・検証・一時的なサーバの失敗・ネットワーク）に従い、`409 lending_item_unavailable` は
「ほかの人が先に借りました」として一覧を読み直す（§7.1）。

## 6. 流れ

### 6.1 台帳の登録（備品係、Desktop / Web）

1. 「備品」→「管理」→「分類」で分類を作る（例：PC・カメラ・本・ケーブル。PC は「許可が要る」、最長 30 日）。
2. 「備品を追加」：名前・分類・管理番号・置き場所・付属品とメモ・写真・（分類と違えば）許可が要るか・最長の日数。
3. まとめて入れるときは CSV（L7）。

### 6.2 状態の変更

- 備品係が `available` ↔ `in_repair` ↔ `retired` を切り替える（理由の一言、履歴 `status`）。貸出中は変えられない。
- **返却が「問題あり」**だったときは、備品係に知らせが届き（§8.2）、備品の詳細に「最後の返却：問題あり」と出す。状態を
  修理中にするかは備品係が決める（自動では変えない：「ケースが少し汚れた」程度で貸せなくなると困る）。
- 廃棄の備品は一覧から消え（「廃棄も表示」で出る）、管理番号は空く。履歴は残る。

### 6.3 借りる

1. 備品の詳細で「借りる」。ダイアログ：返す日（既定は最長、カレンダーは最長より後を選べない）・目的（必須、「学会発表の撮影」）・
   許可が要る備品なら「教員の許可を得た」の印と、許可した教員の選択（§6.4）。
2. 送ると、サーバは備品の行をロックし、貸出可・返す日・許可を確かめて、貸し出しの行・備品の状態・履歴 `borrowed`・
   教員への知らせ（§8.2）・`lending.updated` を **1 つのトランザクション**で書く。
3. 教員が自分で借りるとき（呼んだ人が名簿の `@faculty` の有効なメンバーのとき、§6.4）は許可の印を求めない（`permission_required = false`
   とし、履歴の `details.self_approved = true`）。名簿の無いワークスペースの「人の全員が候補」（§6.4）では、誰も自分では許可できない
   （全員が候補なので、候補であることで許可を省くと許可の要る備品が意味を失う）。

### 6.4 教員の候補

- 名簿（LAB.md）の**管理グループ `@faculty`（`user_groups.managed_key = 'faculty'`、名簿の `affiliation = faculty` の人）のメンバー**で、有効な人
  （admin・manager・member）。借りる人の指導教員（`lab_profiles.supervisor_id`、1 人）が候補なら `suggested_ids` に入れる。
- 名簿を使っていない（グループが無い・有効なメンバーがいない）ワークスペースでは、人（admin・manager・member）の全員から選ぶ。研究室以外での汎用の
  形。グループを設定で選べるようにするかは Q3。
- 自分は選べない（`400 lending_approver_invalid`）。教員の候補でない人を API で直に送っても同じ。

### 6.5 延長

- 本人：「延長」で新しい返す日を選ぶ。範囲は「今の返す日の次の日」〜「今日 + 最長の日数」、回数は `max_extensions`（既定 2）まで。
  延滞中でも延長できる（延ばせば催促は止まる。催促の目的は返すか延ばすかを決めてもらうこと）。
- 延長しても教員にはもう一度知らせない（許可は貸し出しごと。延長の多いものは備品係が延滞・履歴で見る）。
- 「返却を知らせる」の人がいるときは、延長のダイアログに「この備品を待っている人がいます（2 人）」と出す（止めはしない）。
- 備品係は範囲の外の日付にも変えられる（長期の貸し出し、壊れたものの返却待ちなど）。本人に知らせ、履歴 `due_changed`。

### 6.6 返す

1. 「返す」：状態（問題なし / 問題あり）と、問題ありならメモ（必須）。問題なしでもメモは書ける（「充電器は棚の箱へ」）。
2. 貸し出しの行（`returned`）・備品の状態（`available`、`current_loan_id` を空に）・履歴 `returned`・知らせ（問題あり → 備品係、
   代わりの記録 → 本人、見守り → その人たち）・`lending.updated` を 1 つのトランザクションで。教員の作業（`permission:<loan>`）は
   返却では済みにしない：判断は返却から 14 日までできる（§5.3）ので、判断したときか 14 日を過ぎたときに済みにする（§8.2・§8.4）。
3. 備品係が代わりに記録するとき（棚に戻っていたのに押し忘れ）は、確かめのダイアログを出し、本人に「備品係の 〇〇 さんが返却を
   記録しました」と知らせる。
4. 物が実際に棚にあるかは Taylis は確かめない（予約と同じく、ボタンは「そうした」という記録）。

### 6.7 返却を知らせる（見守り）

- 貸出中・修理中の備品の詳細で「返却されたら知らせる」。返却（か修理中 → 貸出可）のときに、見守る人全員に 1 回知らせて、
  見守りを消す。順番や取り置きにはしない（先に借りた人が借りられる。取り置きは §13.1）。
- 本人の見守りは自分が借りたときに消す。

## 7. 並行と冪等

### 7.1 同時に 2 人が借りる

- `borrow` は最初に `SELECT … FROM lending_items WHERE id = :id FOR UPDATE` で備品の行をロックし、そのロックの中で状態を見る。
  2 人が同時に押しても順に処理され、後の人は `status = 'on_loan'` を読んで `409 lending_item_unavailable`（`details.borrower_id`・
  `due_on`）になる。
- 最後の守りに部分一意索引 `lending_loans_active_uniq`：コードの誤りでロックを飛ばしても、貸出中が 2 つになることはない
  （一意の違反は同じ `409` に変える）。
- 端末は `409 lending_item_unavailable` を受けたら「〇〇 さんが先に借りました（10/30 まで）」と出し、詳細を読み直す。
- 返す・延長・状態の変更・教員の判断も、**備品の行 → 貸し出しの行**の順にロックする（どの操作も同じ順なのでデッドロックしない）。
  本人と備品係が同時に「返す」を押しても、2 回目は返却済みを読んで何もしない（200）。
- worker（§8.4）は貸し出しの行を `FOR UPDATE SKIP LOCKED` で取る。人の操作の最中のものは次の周期に回る。

### 7.2 送り直し

- `borrow` の `client_request_id` は端末が作る UUID（メッセージの冪等のキーと同じ考え方、SYNC_PROTOCOL.md §9）。同じ人が同じ id で
  送り直すと、前の貸し出しを 200 で返す（もう返却していても同じ行）。違う id で同じ備品をもう一度借りようとすると、自分が
  借りている備品は `409 lending_item_unavailable`（`details.borrower_id` が自分）。端末はこれを「すでに借りています」と出す。
- `return`・`extend`（同じ日付）・`permission`（同じ判断）・`status`（同じ状態）は、2 回目は何もしない（冪等）ので id は要らない。
- 端末は送信中にボタンを押せなくし、ネットワークの失敗は同じ `client_request_id` で送り直す（新しい id を作らない）。

## 8. 知らせ（アクティビティとプッシュ）

### 8.1 時刻とゾーン

- 返す日は**ワークスペースの日付**（`lending_settings.tz`、既定 Asia/Tokyo）：研究室に返すという規則なので、人ごとの端末のゾーン
  （タスクの期限、TASKS.md）ではなく 1 つのゾーンで決める。朝の知らせも同じゾーンの `notice_minute`（既定 9:00）。
- 9:00 は既定のおやすみ時間（22:00〜7:00、`users/dnd.py`）の外。

### 8.2 いつ・誰へ

知らせは **アクティビティの項目**（`lending_notices`、種類 `lending`）と、同じトランザクションの `lending.notice`（audience user）で、
プッシュはそこから作る（予約の §5 と同じ。コミットの後に送るものは無い）。文は受け取る人の言語で書く（M115、`i18n/messages.json`）。

| いつ | 誰へ | キー | 文（例） |
| --- | --- | --- | --- |
| 許可の要る備品が借りられた | 教員 | `permission:<loan>` | 「🔑 〇〇 さんが「カメラ A（CAM-02）」を借りました（10/30 まで、目的：学会の撮影）。あなたの許可を得たとしています。許可していなければ「許可していない」を押してください。」（作業。判断・返却から 14 日で済み） |
| 教員が「許可していない」 | 借りた人 | `denied:<loan>` | 「⚠️ △△ さんは「カメラ A」の貸し出しを許可していないとしました。返却して、もう一度相談してください。」 |
| 同じとき | 備品係 | `denied:<loan>` | 「⚠️ 〇〇 さんの「カメラ A」の貸し出し（10/30 まで）を、△△ さんが許可していないとしました。」 |
| 返す日の前日の朝 | 借りた人 | `due:<loan>:<due_on>:-1` | 「📦 「カメラ A」は明日（10/30）が返す日です。延長もできます。」 |
| 返す日の朝 | 借りた人 | `due:<loan>:<due_on>:0` | 「📦 「カメラ A」は今日が返す日です。」 |
| 過ぎてから毎朝 | 借りた人 | `due:<loan>:<due_on>:<n>` | 「⏰ 「カメラ A」の返す日（10/30）を 2 日過ぎています。返すか延長してください。」 |
| 過ぎて `keeper_overdue_days`（3）日以上のものがある朝 | 備品係 | `overdue:<日付>` | 「⏰ 返す日を 3 日以上過ぎた貸し出しが 2 件あります：〇〇 さん「カメラ A」（5 日）、△△ さん「PC-03」（3 日）。」（**朝に 1 つのまとめ**。1 件ずつは送らない。無効化された人の貸し出しも、日数によらずここに入れる） |
| 返却が「問題あり」 | 備品係 | `issue:<loan>` | 「🔧 〇〇 さんが「カメラ A」を返却しました。状態：レンズキャップがありません。」 |
| 備品係が代わりに返却を記録 | 借りた人 | `returned_by_keeper:<loan>` | 「✅ 備品係の 〇〇 さんが「カメラ A」の返却を記録しました。」 |
| 備品係が返す日を変えた | 借りた人 | `due_changed:<loan>:<due_on>` | 「🗓 備品係の 〇〇 さんが「カメラ A」の返す日を 11/15 に変えました。」 |
| 見守っていた備品が返却された | 見守った人 | `watch:<item>:<loan>` | 「📦 「カメラ A」が返却されました。今は借りられます。」 |
| 見守っていた備品の修理が終わった（修理中 → 貸出可） | 見守った人 | `watch:<item>:repair:<履歴の id>` | 「📦 「カメラ A」の修理が終わりました。今は借りられます。」 |

- 前日・当日・毎朝のキーは返す日を含むので、延長すれば新しい日付のキーになり、前日の知らせからやり直す。返却・延長で
  知らせの要らなくなった時刻のものは出さない（送る直前に貸し出しを確かめる）。
- 「許可していない」の作業（`permission:<loan>`）は、教員が判断したとき・返却から 14 日が過ぎたときに `done_at` を入れ、
  `activity.updated` で知らせる（予約の担当者の作業と同じ）。済んだ項目は未読に数えない。
- 備品係のまとめは作業にしない（済みの状態を持たない）。対応は延滞の一覧で見る。毎朝届くのがうるさければ、まとめの頻度を
  設定にする（Q4）。
- 借りた本人の「借りました」「返しました」は送らない（自分で押したので画面でわかる）。教員が「確認した」も借りた人には送らない
  （貸し出しの詳細に「△△ さんが確認しました」と出る）。

### 8.3 DND・おやすみ時間・プッシュ

- **アクティビティの項目はいつも書く**（記録とバッジ）。プッシュは今の PushPlanner の規則（PUSH_NOTIFICATIONS.md §4）：
  DND（一時停止・おやすみ時間）の間は出さず、後で送り直さない（リマインダー・予定・予約と同じ）。別の端末でアクティブなら
  出さない。おやすみ時間が 9:00 を超える人（10:00 まで、など）はプッシュが無く、アクティビティのバッジで気づく。催促は
  翌朝もまた来るので、取りこぼしは残らない。
- `kind = lending`（タイトル「備品」、本文は知らせの 1 行、`lending_item_id`・`loan_id` を送り、タップで「備品」のその貸し出しを
  開く。`channel_id` は null）。`collapse_key` は **`lending:loan:<loan_id>`**：同じ貸し出しの催促は通知の欄で前のものを置き換える
  （毎朝の催促が溜まらない）。備品係のまとめは `lending:overdue`。`PUSH_INCLUDE_CONTENT=false` なら本文は「備品のお知らせがあります」。
- 計画の時点で項目が済んでいる・貸し出しが返却済み（催促）・読む権利が無い（備品係でなくなった人のまとめ）なら出さない
  （`lending/access.py` の `may_deliver`、予約の §5 と同じ確かめ方）。
- 古い端末：アクティビティは `include=lending` を付けた端末にだけ返す（M76・M112 と同じ。知らない種類で落ちる端末のため）。
  プッシュの知らない `kind` は今の端末も通知としては出せる（タップはアプリを開くだけ）。

### 8.4 worker のジョブ

- **`lending.tick`**：リマインダー・予約と同じ scheduled のループ（`SCHEDULED_SEND_INTERVAL_SECONDS`、15 秒、`main.py` の
  `_scheduled_send_loop` に 1 つ足す）。機能がオフなら何もしない。
  1. 今の時刻がそのゾーンの `notice_minute` より前なら何もしない（その日の朝の分はまだ）。
  2. 返す日が明日以前の貸出中で、今日のキー（`due:<loan>:<due_on>:<今日 − due_on>`）がまだ `lending_notices` に無いものを
     1 回に 100 件まで選び（残りは次の周期）、貸し出しの行を `FOR UPDATE SKIP LOCKED` で取って 1 件ずつのトランザクションで書く
     （同じトランザクションで outbox）。今朝の時刻より後に借りた・返す日を変えた貸し出しはその日は書かない（決めたばかりなので、
     次の朝から）。
  3. 備品係のまとめ：今日の `overdue:<日付>` を、まだ受け取っていない備品係（いなければ管理者）に書く。対象が無ければ書かない。
  4. 教員の作業で返却から 14 日を過ぎたものを済みにする（これは朝の時刻によらず、周期ごとに）。
- **取りこぼしの扱い**：サーバが止まっていて朝を過ぎても、その日のうちに動けばその日の分を出す。**前の日の分は出さない**（キーが
  今日の日付だけなので、3 日止まっていても「5 日過ぎています」の 1 つだけ。DEADLINES.md §4 の「いちばん近い 1 件」と同じ考え）。
- キーは `(user_id, key)` で一意なので、worker が 2 つ動いても、同じ周期に 2 回動いても 1 回だけ。
- 失敗は貸し出しごとに巻き戻してログに残し、次の周期でまた試す（予約の `tick` と同じ）。

## 9. 同期

| type | audience | seq | data |
| --- | --- | --- | --- |
| `lending.updated` | all | — | `{item_ids, categories, settings}`。備品・貸し出し・分類（`item_ids` は空で `categories: true`）・設定（`settings: true`）が変わった。L7 から朝の `lending.tick` も、返す日の当日・過ぎた貸し出しの催促を書いた周期に 1 つだけ送る（`item_ids` はその備品。延滞の数と「N 日過ぎ」が変わるため）。中身は人によって違う（目的などの見える範囲）ので載せず、端末は `GET /lending/items`（設定なら `GET /lending/settings`）と数（`GET /lending/summary`、L7）を読み直す。続けて届いたものは 300 ms で 1 回にまとめる。ゲストにも届きうるが中身は無い（予約の `reservation.updated` と同じ） |
| `lending.notice` | user | — | `{item_id, lending_item_id, loan_id, role, text, at}`。自分あての知らせ（アクティビティの項目 `item_id`）。バッジを読み直し、開いている端末はバナー / 通知を出す |
| `activity.updated` | user | — | 既存。教員の作業が済んだとき `{item_ids}` |

- bootstrap のたびに `lending`（§5.1）を受け取り、「備品」の画面を開いていれば一覧を読み直す（WebSocket が切れていた間の変化を
  拾う。SYNC_PROTOCOL.md §7.5）。
- 端末は台帳を手元に持たない（開いたときに読む。オフラインでは「オフラインです」）。v1 の規模（数百個）なら 1 回の一覧で足りる。
- `ws-events.json` と SYNC_PROTOCOL.md §6 に 2 行を足す。

## 10. 監査

- `audit_logs` に書くもの（`record_in_tx`、`actor_role` は自動）：`lending_settings.updated`（変えた項目、備品係の出入り）、
  `lending_category.created / updated / deleted`、`lending_item.created / updated / status_changed / deleted`、
  `lending_loan.returned_by_keeper`、`lending_loan.due_changed_by_keeper`、`lending_loan.permission_decided`（教員の判断は後で
  争いになりうるので監査にも残す）、`lending_import.applied`（件数）。
- 借りる・本人の返却・本人の延長は監査に書かない（人の日々の操作。`lending_item_events` に残る）。

## 11. セキュリティ

- 権限はすべてサーバで確かめる（端末の出し分けは見た目だけ）。`borrower_id`・`returned_by`・時刻は端末から受け取らない。
- 目的・許可・返却のメモは §3.2 の人にだけ返す（一覧・詳細・CSV（備品係だけ）・イベント（中身を載せない）・プッシュ（本人あて））。
  備品係のまとめのプッシュは名前と備品名を含むので、宛先は今の備品係だけ（§8.3）。
- 自由記述（名前・メモ・目的・返却のメモ）はプレーンテキストとして描く（Markdown・メンションを解かない）。知らせの文の中の
  名前は、締切の投稿と同じくメンションの構文にならない形にする（DEADLINES.md §4）。
- 写真は今の添付の検査（大きさ・sniff した MIME）と、画像だけの制限（§4.3）。
- CSV の書き出しは表計算の数式の注入を防ぐ（`=`・`+`・`-`・`@` で始まる値の前に `'` を付ける。`'` で始まる値にも付け、取り込みで
  1 つ外す：§18）。取り込みの大きさと行数の上限。
- 速度制限は今の API の共通のもの。借りるの連打は冪等のキーと備品のロックで害が無い。

## 12. 画面

### 12.1 入口

| | Desktop / Web | iOS / Android |
| --- | --- | --- |
| 入口 | 場所のレール / サイドバーの「備品」（`apps/shared/nav-items.json` に `lending`、`platforms: ["desktop", "mobile"]`、既定の並びは「予約」の次）。機能が有効なときだけ実装済みとして数える（PRESENCE.md・ACTIONS.md と同じ） | ホームのタイル「備品」（iPad のサイドバー、Android のタブレットの一覧にも） |
| 数字 | 自分の延滞の数（赤）。備品係は加えて `keeper_attention_count`（`keeper_overdue_days` 以上の延滞と、無効化された人の貸出中の数。備品係のまとめと同じ対象） | 同じ |
| 知らせ | アクティビティの 📦 の行（押すとその貸し出し）、デスクトップの通知 | アクティビティの行、開いているときのバナー、プッシュのタップ |

### 12.2 Desktop / Web

```text
┌ 備品 ───────────────────────────────────────────────────────────────┐
│ [一覧] [貸出中 12] [自分 2] [延滞 3]*  [管理]*        🔍 名前・管理番号 │
│ 分類：[すべて] [PC] [カメラ] [本] …   状態：[すべて ▾]              │
├──────────────────────────────────────────┬──────────────────────────┤
│ 🖼 カメラ A    CAM-02  カメラ  301 棚 2   │ 🖼（写真）                │
│    ● 貸出中  山田 太郎  10/30 まで        │ カメラ A   CAM-02         │
│ 🖼 PC-03       PC-03   PC      302 机     │ ● 貸出中（山田 太郎、10/30 │
│    ● 貸出可  🔑 許可が要る                │   まで・2 日過ぎ）         │
│ 🖼 統計学入門  図-0123 本      本棚 B     │ 置き場所：301 棚 2         │
│    ○ 修理中（表紙の破れ）                 │ 付属品：充電器・ケース     │
│ …                                        │ 🔑 教員の許可が要る        │
│                                          │ 最長 14 日                 │
│                                          │ [返却されたら知らせる]     │
│                                          │ ── 履歴 ──                 │
│                                          │ 10/16 山田 太郎 借りた      │
│                                          │ 10/10 鈴木 花子 返した 🔧   │
│                                          │ [✏️ 編集] [状態 ▾]*        │
└──────────────────────────────────────────┴──────────────────────────┘
* 備品係・管理者だけ
```

- **一覧**：表（写真のサムネイル・名前・管理番号・分類・置き場所・状態・借りている人と返す日）。状態は色の点と文字（緑の点＝貸出可、
  青＝貸出中、灰＝修理中、延滞は赤の「2 日過ぎ」）。左に太い色の帯の付いたカードにはしない。並べ替えは名前・管理番号・返す日。
  絞り込みは手元で（分類・状態・文字）。右に詳細の欄（狭い画面では詳細のページ）。
- **借りるダイアログ**：返す日（カレンダー、最長より後は選べず「最長 14 日（11/9 まで）」と出す）、目的（1 行）、許可が要るなら
  「☐ 教員の許可を得た」と「許可した教員」（指導教員を先頭に、名前の検索）。印を付けないと「借りる」を押せない。説明の 1 行：
  「選んだ教員に知らせが届きます。」
- **返すダイアログ**：「問題なし」/「問題あり」（ラジオ）、メモ（問題ありは必須）。
- **延長ダイアログ**：新しい返す日（範囲の外は選べない）、残りの回数（「あと 1 回延長できます」）、見守る人がいれば注意。
- **貸出中**：返す日の順の表（備品・借りている人・借りた日・返す日・延滞の日数）。人の名前を押すとプロフィール。
- **自分**：自分の貸出中（返す・延長のボタン）と最近の返却、自分が教員として選ばれた貸し出し（「許可していない」「確認した」）。
- **延滞**（備品係）：過ぎた日数の多い順。目的・連絡（DM を開く）・代わりに返却を記録・返す日を変える。
- **管理**（備品係）：分類（追加・名前・既定の許可・最長・並べ替え・削除）、備品の追加、CSV（L7）、QR のラベル（L7）。管理者には
  「設定」（機能のオン・オフ、備品係、既定の最長・延長の回数・備品係に知らせる日数・知らせの時刻・ゾーン）。機能のオン・オフと
  備品係は「設定 → 管理」の「備品」のタブにも置く（ROLES.md §7 の権限で出し分け）。
- **編集フォーム**：名前・分類・管理番号・置き場所・付属品とメモ・写真（ドロップ / 選ぶ / 外す）・許可が要るか（「分類の既定（要る）」/
  要る / 要らない）・最長の日数（「分類の既定（30 日）」/ 日数）。

### 12.3 iOS / Android

```text
┌ 備品 ────────────────┐   ┌ カメラ A ─────────────┐   ┌ 借りる ──────────────┐
│ 🔍 名前・管理番号      │   │ 🖼（写真）             │   │ 返す日   [10/30 ▾]    │
│ [すべて][PC][カメラ]…  │   │ CAM-02 · カメラ        │   │ 最長 14 日（11/9 まで）│
│ ── 自分の貸し出し ──   │   │ ● 貸出可               │   │ 目的   [学会の撮影  ]  │
│ 📦 PC-03  11/2 まで    │   │ 301 棚 2               │   │ 🔑 教員の許可が要る    │
│ ── 備品 ──             │   │ 充電器・ケース         │   │ ☑ 教員の許可を得た     │
│ 🖼 カメラ A  ● 貸出可  │   │ 🔑 教員の許可が要る     │   │ 許可した教員 [加納 ▾]  │
│ 🖼 PC-03  ● 貸出中     │   │ [ 借りる ]             │   │ [ 借りる ]             │
│ 🖼 統計学入門 ○ 修理中 │   │ 最近の貸し出し …       │   └────────────────────┘
└──────────────────────┘   └──────────────────────┘
```

- 一覧（検索・分類のチップ・状態）。上に「自分の貸し出し」（延滞は赤）。
- 備品の詳細：写真・項目・状態・「借りる」/「返す」/「延長」/「返却されたら知らせる」、最近の貸し出し 5 件。
- 借りる・返す・延長のシート（iOS）/ ダイアログ（Android）は Desktop と同じ項目。
- 「貸出中」の一覧（誰が何をいつまで）。
- 教員：アクティビティの行・プッシュから貸し出しの詳細を開き、「許可していない」（確かめてから、一言を任意で）と「確認した」。
  「自分」の欄に「許可を求められた貸し出し」。
- 台帳の編集・分類・延滞の一覧・CSV・設定は出さない（「Desktop / Web で管理します」）。
- iOS は SwiftUI の `List` とシート、写真は今の添付のサムネイルの読み込み。Android は Compose の `LazyColumn` とダイアログ。どちらも
  新しい依存は足さない。

### 12.4 文言

ja「備品」「借りる」「返す」「延長」「貸出可」「貸出中」「修理中」「廃棄」「備品係」「教員の許可を得た」「許可していない」「確認した」
「返却されたら知らせる」、en「Equipment」「Borrow」「Return」「Extend」「Available」「On loan」「In repair」「Retired」「Equipment
keepers」「A teacher approved this」「I did not approve」「Confirm」「Notify me when returned」、zh-Hans は I18N.md の手順で。

## 13. 決めたこと（v1 に入れないもの・後で作るもの）

### 13.1 先の日付の取り置き（後で）

- v1 には無い。今は「返却されたら知らせる」（§6.7）と、会話での相談で足りる（利用者の要望の中心は「誰が持っているか」と「返し忘れ」）。
- 足すときは貸し出しの中に `lending_holds (item_id, user_id, start_on, end_on)` を作り、**借りる・延長の検査に「その日付に取り置きが
  あれば、その前日まで」**を加える。予約（`reservations`）の枠にはしない（§2：単位が時間で、担当者の付け替えが前提）。

### 13.2 消耗品（作らない）

- 返さないもの（電池・用紙・試薬）は数量と在庫の管理で、貸し出しとは別の機能。v1 は作らない。メモに「付属品」として書くのは
  よい。要望が出たら別の設計（在庫・補充の知らせ）にする。

### 13.3 CSV の取り込み・書き出し（L7）

- 最初の台帳づくり（今のスプレッドシートから数百行）に要るので、v1 の最後の段階 L7 に入れる（§5.4）。管理番号で突き合わせ、
  何度取り込んでも増えない。

### 13.4 ゲスト・アカウントの無い人（後で）

- v1 はゲストに見せない。卒業生や学外の共同研究者に貸すときは、備品係が「代わりに貸す」操作（借りる人の名前を文字で書く）を
  後で足す。ゲストに一部の分類だけを見せるのは §13.6 の後。

### 13.5 QR のラベル（L7）

- 備品のリンク `<server>/eq/<item_id>`：`pages.py` に案内ページ（`/m/`・`/c/`・`/d/` と同じ形、中身を明かさない）、Web はそのまま
  「備品」のその詳細を開く。（当初は `/e/<item_id>` としていたが、`/e/` は予定のリンク（CALENDAR.md §11）なので L7 で `/eq/` に直した。）会話に貼るとカード（DRIVE.md §25 の `/d/` のカードと同じ作り）は後で。
- Desktop / Web の「管理 → QR のラベル」で、選んだ備品の QR（リンク）・名前・管理番号を A4 のラベルの格子に並べて印刷する。QR の
  符号化は `qrcode-generator`（2.0.4 に固定）で行列だけを作り、SVG は `apps/desktop` で描く（§17.7）。
- スマホは OS のカメラで読むとブラウザの Web が開く（アプリは開かない：ユニバーサルリンク / App Links は今無い）。アプリ内の
  読み取り（iOS の VisionKit `DataScannerViewController`、Android は標準の API が無く ML Kit が要る）は後で。

### 13.6 見える人の制限（後で）

- v1 は人の全員がすべての備品を見る。分類ごとに予約の `visibility`（all / channel / group）と同じ形を足せる（`lending_categories.
  visibility*`）。見えない備品は一覧・検索・イベントの対象から外し、`404 lending_item_not_found`。

### 13.7 そのほか後で

- 分類ごとの備品係（§3.1 K2）、返却のときの写真、記録のチャンネルへのボットの投稿（予約の記録のチャンネルと同じ形）、全体の
  検索（`/search`）への備品の枝、年度更新（LAB.md L7）の画面に「卒業する人の貸出中」を出すこと、複数の写真。

## 14. テスト

- `tests/test_lending_access.py`：§3.2 の表を総当たり（{admin, manager, member, guest, 備品係, 借りた本人, 教員} × すべての操作、
  機能のオフ、無効化された備品係）。目的などが見えない人に null で返ること。
- `tests/test_lending_loans.py`：同時の借りる（2 つのセッションで同じ備品、片方だけ 201・もう片方 409）、`client_request_id` の
  送り直し（201 → 200 で同じ行）、返す日の境界（今日・最長・最長 + 1、ゾーンの日付の変わり目）、延長の回数と範囲、備品係の
  日付の変更、本人と備品係の同時の返却、状態の変更と貸出中、管理番号の一意（廃棄を除く）、削除と履歴。
- `tests/test_lending_permission.py`：要る / 要らない の解決（備品 → 分類 → 既定）、教員の候補（`@faculty`・名簿なし・自分・無効）、
  教員が自分で借りる、判断の切り替えと記録、14 日の締め切り。
- `tests/test_lending_notices.py`（時刻を渡す）：前日・当日・毎朝のキー、延長でやり直し、返却で止まる、3 日目からの備品係の
  まとめ（1 人 1 日 1 つ）、備品係がいない → 管理者、無効化された人の貸し出し、止まっていた後は今日の分だけ、worker の二重起動、
  DND 中はプッシュが無くアクティビティはある、`collapse_key`、`include=lending` の無い端末に出ないこと。
- 移行の upgrade / downgrade。OpenAPI と `ws-events.json` の契約テスト。errors.json の生成。
- Desktop vitest：借りるダイアログ（最長の日付・許可の印が無いと押せない）、409 の後の読み直し、一覧の絞り込み、権限による出し分け。
- iOS（`LendingTests`）・Android（`LendingTest`）：一覧の解読（知らない状態で落ちない）、借りる・返す・延長の要求、409 の表示、
  教員の判断。

## 15. 利用者に確かめること

| # | 質問 | 推め（決まらなければこれで作る） |
| --- | --- | --- |
| Q1 | 機能の設定と備品係の選び方は管理者だけでよいか（運営にも開くか） | 管理者だけ（要望どおり）。運営に開くなら `lending.manage` を manager ○ にするだけ |
| Q2 | 既定の数（最長 14 日、延長 2 回、備品係へ 3 日、朝 9:00）でよいか | このまま。分類ごとの最長（PC 30 日など）は台帳で決める |
| Q3 | 教員の候補は名簿の `@faculty` でよいか（助教・研究員・事務の人も許可できるか） | `@faculty`（名簿の教員の職位）。足りなければ設定で「許可できる人」のグループを選べるようにする |
| Q4 | 備品係のまとめは毎朝でよいか（延滞が長引くと毎日届く） | 毎朝（要望どおり）。うるさければ週 1 回の設定を足す |
| Q5 | 借りた本人の延滞の催促に上限は要るか（1 か月過ぎても毎朝） | 上限なし（返すか延ばせば止まる。延ばせない人は備品係が日付を変える） |
| Q6 | 返却のメモ（状態）を全員に見せるか | 本人・教員・備品係・管理者だけ。履歴の 🔧 の印は全員に |
| Q7 | 教員が「確認した」のボタンは要るか（自己申告のままでもよいか） | 置く（任意。押さなくても貸し出しは続く） |
| Q8 | 研究室の外のワークスペース（汎用）で、許可の言葉を「教員」から変えたいか | v1 は「教員」のまま。要望が出たら設定の文言にする |
| Q9 | 備品の数の見込み（数十か、数百か）と、今のスプレッドシートの列 | 数百まで。CSV の列は §5.4（今の表を見て L7 で合わせる） |

## 16. 段階（マイルストーン）

段階の名前 L1〜L7 は本書の中だけのもの（LAB.md の L1〜L9 とは別）。M 番号・移行の番号は仮。各段階の終わりに IMPLEMENTATION_PLAN.md
§0 の確かめ（pytest・mypy・ruff、tsc とテスト、OpenAPI と ws-events.json、移行の downgrade、iOS は xcodebuild、Android は Gradle）を行う。
どの段階も 1 人のエージェントで終わる大きさにした。

| 段階 | M | 中身 | 完了条件 |
| --- | --- | --- | --- |
| **L1** 台帳（サーバ） | M167 | 移行 0123（設定・分類・備品・履歴・`attachments.lending_item_id`）、`lending` モジュール（models・access・service・router・schemas）、`lending.manage` の権限（ROLES.md の表）、設定・分類・備品の API（§5.1・§5.2、状態の変更・削除・履歴のカーソル）、写真の bind と `get_for_access` の枝、bootstrap の `lending`、`lending.updated`、監査、errors.json | pytest：台帳の権限の表、管理番号の一意（廃棄を除く）、分類の削除、写真の bind（他人の添付・画像でないもの）と読み取り（ゲスト不可）、機能のオフ。DATA_MODEL.md・SYNC_PROTOCOL.md §6・ROLES.md §2 に足す |
| **L2** 貸し出し（サーバ） | M168 | 移行 0124（`lending_loans`）、借りる・返す・延長・備品係の日付の変更と代わりの返却、ロックの順と部分一意索引、`client_request_id`、`GET /lending/loans` の 4 つの scope、見える項目の伏せ、履歴への記録、教員の候補（`GET /lending/approvers`）と許可の検査（判断の API は L3） | pytest：同時の借りる（2 セッション）、送り直し、返す日の境界とゾーン、延長の回数、同時の返却、目的の伏せ、教員の候補の解決 |
| **L3** 許可と知らせ（サーバ） | M169 | 移行 0125（`lending_notices`・`lending_watches`）、教員の判断の API、アクティビティの `include=lending`、`lending.notice` と `activity.updated`、PushPlanner の `handle_lending`（`kind = lending`、`collapse_key`、`may_deliver`）、`lending.tick`（前日・当日・毎朝、備品係のまとめ、14 日の締め切り）、見守り、文の 3 言語 | pytest：§14 の `test_lending_notices.py` と `test_lending_permission.py`。PUSH_NOTIFICATIONS.md §4・§5 に行を足す |
| **L4** Desktop / Web | M170 | nav-items の `lending`、一覧・詳細・借りる / 返す / 延長のダイアログ・貸出中・自分・延滞・管理（分類・備品の編集・写真）・設定のタブ、アクティビティの 📦 の行とデスクトップの通知、`lending.updated` の読み直し | tsc・vitest（§14）。Web と macOS のアプリで、2 つのブラウザから同じ備品を同時に借りて片方に「先に借りました」が出る、許可の要る備品を借りて教員のアカウントに知らせが届き「許可していない」で借りた人と備品係に届くことを手で確かめる |
| **L5** iOS | M171 | ホームのタイル、一覧・詳細・借りる / 返す / 延長のシート、自分の貸し出し、教員の判断、アクティビティの行とプッシュのタップ（`kind = lending`） | xcodebuild のビルドと `LendingTests`。実機でプッシュのタップからその貸し出しが開く |
| **L6** Android | M172 | L5 と同じ（Compose）。FCM の `kind = lending` の通知と、フォアグラウンドのローカル通知 | Gradle のビルドと `LendingTest`。エミュレータ（ChikuwaChat_Pixel_9）で借りる・返す・延長、通知のタップ |
| **L7** CSV と QR のラベル | M173 | `export.csv`・`import`（dry run と当てる、§5.4）、Desktop の取り込みの画面（差分の表）、`/eq/<id>` の案内ページと Web の遷移、QR のラベルの印刷 | pytest：取り込みの冪等（2 回目は unchanged）、数式の注入の防ぎ、行のエラー。Desktop で 300 行の CSV を取り込み、ラベルを印刷してスマホのカメラで読むと Web のその備品が開く |

- 使い始められるのは L4 の後（台帳を作って Desktop / Web で借りる・返すができ、知らせも届く）。L5・L6 は並行してよい。L7 は台帳を
  スプレッドシートから移すときに要るので、利用者の今の表の大きさ次第で L4 の直後に回す。
- 見積もりの目安：L1 3 日、L2 3 日、L3 4 日、L4 1 週、L5・L6 各 4 日、L7 3 日。

## 17. 実装の記録

### 17.1 L1（M167、2026-10-26）

`app/modules/lending/`（`models`・`access`・`schemas`・`service`・`router`・`events`）、移行 0123（downgrade は写真の添付を `deleted`
にしてから表を落とす）、`lending.manage`（`app/core/roles.py`、管理者だけ）、`attachments.lending_item_id` と `get_for_access` の枝
（`attachments.set_lending_access_check`、main.py で `lending.access.can_read_photo` を渡す）、bootstrap の `lending`、`lending.updated`、
監査、`apps/shared/errors.json`。テストは `tests/test_lending_ledger.py`（と `tests/test_roles.py` の表に `PATCH /admin/lending/settings`）。

設計から決めたこと・変えたこと（後の段階が知っておくこと）：

- **OpenAPI の型の名前には `Lending` を付けた**：`LendingCategoryOut`・`LendingCategoryCreate`・`LendingCategoryUpdate`・`LendingItemOut`・
  `LendingItemDetailOut`・`LendingItemCreate`・`LendingItemUpdate`・`LendingItemStatusIn`・`LendingItemEventOut`・`LendingItemHistoryOut`・
  `LendingLoanBriefOut`（本書の `CategoryOut`・`ItemOut` などはこれのこと。ほかのモジュールの型と混ざらないように）。L2 の
  `LoanOut` も `LendingLoanOut` にする。
- `LendingItemOut` に **`max_days_source`**（item / category / default）を足した。編集フォームの「分類の既定（30 日）/ 日数」に要る
  （`requires_permission_source` と同じ形）。備品の値そのものは「source が item のときの値」。
- `POST /lending/items`（201）・`PATCH /lending/items/{id}`・`POST /lending/items/{id}/status` は **`LendingItemDetailOut`** を返す
  （`recent_loans` は L2 まで空、`loan` は null、`watching` は L3 まで false）。
- 分類の `item_count` は**廃棄を含む**数（分類の削除を止めるのと同じ数え方。`409 lending_category_in_use` の `details.item_count` と一致）。
- 分類の `PATCH {position}` は 0 からの位置：その場所に入れ、ほかを詰めて 0, 1, 2… に並べ直す。
- `POST …/status`：同じ状態・同じ理由なら何もしない。同じ状態で理由だけ違えば理由を変えて履歴 `status` に残す。貸出可に戻すと
  `status_note` は空。貸出中は `409 lending_item_on_loan`（`details.loan_id`）。
- 「貸し出しが 1 度でもあれば消せない」は、L1 では履歴に `borrowed` があるか（と貸出中か）で見る。L2 は `lending_loans` に行が
  あるかで見てよい（どちらでも同じ答え）。
- `PATCH /admin/lending/settings` の `keeper_ids` は、**新しく足した人だけ**を確かめる（無効・ゲスト・ボット・知らない人で
  `400 lending_keeper_invalid`）。前から一覧にいて後で無効化された人は残してよい（数えないだけ）。21 人以上は 422。
- 写真：自分の **pending** のアップロードで、sniff した型が JPEG・PNG・WebP・HEIC のものだけ（GIF は不可）。それ以外・他人の・もう
  何かに付いた添付・知らない id は `400 lending_photo_invalid`。同じ id をもう一度送っても何もしない。
- 機能がオフの間は、管理者・備品係にも台帳の API は `409 lending_disabled`（設定の読み書きだけ通る）。写真も 404。
- ゲストとボットは `403 guest_restricted`（`GET /lending/settings` も）。台帳の操作で備品係でない人は `403 lending_keeper_required`。
- 備品・分類の作成と管理番号の変更・状態の変更は、トランザクションの advisory lock（`lending_items` / `lending_categories`）で
  順に並べ、上限と一意の検査が食い違わないようにした。L2 の `borrow` は備品の行の `FOR UPDATE` → 貸し出しの行の順（§7.1）。
- `errors.json` には §5.5 の**すべて**のコード（L2・L3・L7 のものも）を入れた。端末（L4〜L6）は文言をそのまま使える。
- bootstrap の `lending` の数（`my_active_count` など）は L2 まで 0。`keeper_attention_count` は備品係だけに数える（ほかは 0）。
- 匿名化で `keeper_ids` から外す（`lending.forget_in_tx`、`lending.updated {settings: true}`）。
- Desktop の `ui/roles.ts` の権限の一覧には `lending.manage` をまだ足していない（L4 で足す）。

### 17.2 L2（M168、2026-10-26）

移行 0124（`lending_loans` と §4.1 の索引、`lending_items.current_loan_id` の外部キー（DEFERRABLE INITIALLY DEFERRED）と
`lending_item_events.loan_id` の外部キー。downgrade は貸出中の備品を available に戻してから落とす）、`app/modules/lending/loans.py`（借りる・
返す・延長・一覧・教員の候補）、`access.sees_loan_details`・`access.may_return`、`service.py` の備品の `loan`・`recent_loans`・bootstrap の数・
削除の判定（`lending_loans` に行があるか）。テストは `tests/test_lending_loans.py`（2 つのセッションで同時に借りる・本人と備品係が同時に返す・
部分一意索引）、`tests/test_lending_permission.py`、`tests/test_lending_access.py`（§3.2 の貸し出しの行）、共通の `tests/lending_helpers.py`
（時刻を止める `freeze`）。

設計から決めたこと・変えたこと（後の段階が知っておくこと）：

- **API の形**：`POST /lending/items/{id}/borrow` → 201 / 200 の `LendingLoanOut`。`POST /lending/loans/{id}/return`・`/extend` →
  `LendingLoanOut`。`GET /lending/loans?scope=mine|active|overdue|approved`（既定 mine）→ `LendingLoanOut[]`（ページに分けない）。
  `GET /lending/loans/{id}` → `LendingLoanOut`。`GET /lending/approvers` → `LendingApproversOut {user_ids, suggested_ids, self_approved}`。
  入力は `LendingBorrowIn`・`LendingReturnIn`・`LendingExtendIn`。
- **`LendingLoanOut` に足したもの**：`item_name`・`item_code`（自分の貸し出し・延滞の一覧・アクティビティの行で、廃棄した備品も含めて
  名前を出すため。台帳を読み直さなくてよい）と `details_hidden`。**`return_condition` は伏せない**（§5.3 を直した。🔧 の印は全員に見せる
  という §3.2・Q6 と食い違っていた）。伏せるのは `purpose`・`approver_id`・`permission_state`・`permission_decided_at`・`permission_note`・
  `return_note`。
- **`LendingLoanBriefOut` に `status`・`returned_at`・`return_condition` を足した**（`recent_loans` で返却済みと 🔧 を出すため）。
  `permission_state` は `LendingLoanOut` と同じ規則で伏せる（見えない人には null）。`overdue_days` は返却済みなら 0。
- **教員が自分で借りる**のは `@faculty` の有効なメンバーだけ（§6.3 を直した）。名簿の無いワークスペースの「人の全員が候補」では誰も
  自分で許可できない（そうしないと全員が許可なしで借りられる）。`GET /lending/approvers` の `self_approved` で端末は印の欄を隠せる。
  候補の判定と `self_approved` は借りるときにサーバがもう一度確かめる。
- **指導教員**は `lab_profiles.supervisor_id`（1 人）。§6.4 の `advisor_ids` は LAB.md の当初の設計の名前で、今の名簿には無い（§6.4 を直した）。
- **教員の候補を直に送ったときの検査**：自分・候補でない・無効・ゲスト・ボット・知らない id はどれも `400 lending_approver_invalid`
  （`details.approver_id`）。許可が要らない備品では `permission_confirmed`・`approver_id` を無視する（`permission_required = false`）。
- **返す日の検査**：借りるとき `今日 ≤ due_on ≤ 今日 + 最長`（今日は `lending_settings.tz` の日付）。外れると `lending_due_invalid`
  （`reason` past / too_long、`latest` はいつも本人の最長の日）。延長は本人なら `今の返す日 < due_on ≤ 今日 + 最長`（reason `not_later` を
  足した）、備品係なら `今日 ≤ due_on ≤ 今日 + 365`（`latest` は 365 日先）。過去の日付へは備品係も変えられない。
- **延長の検査の順**（本人）：返却済み（`409 lending_loan_closed`）→ 同じ日付（何もしない、200）→ 教員の否定（`409 lending_permission_denied`）
  → 回数（`409 lending_extend_limit`）→ 日付（400）。**備品係が自分の貸し出し**を延ばすときは、本人の範囲に収まれば本人の延長（数える）、
  外れれば備品係の変更（数えない・監査）になる。
- **送り直し**：`client_request_id` は備品のロックの前と後の 2 回引く（同じ要求が同時に 2 つ来ても 2 つ目は 200）。一意の違反（ロックの外で
  書かれた行など）は savepoint を戻して、同じ要求なら 200、そうでなければ `409 lending_item_unavailable` に変える。
- **返却**：`by_keeper`（本人以外が押した）なら監査 `lending_loan.returned_by_keeper {item_id, borrower_id, condition}`。延長の監査は
  `lending_loan.due_changed_by_keeper {item_id, borrower_id, from, to}`。本人の借りる・返す・延長は監査に書かない。
- **見守りの消去・教員と本人への知らせ（§6.3 の 2、§6.6 の 2、§6.5）は L3**：L2 は貸し出しと履歴と `lending.updated` だけを書く。L3 は
  `loans.borrow` / `return_loan` / `extend` の同じトランザクションに `lending_notices` と `lending.notice` を足す（関数の終わりの
  `service.emit` の前）。
- **`scope=approved`** は `approver_id` が自分のもの（貸出中と、返却から 14 日以内）。L2 では判断の API が無いので `permission_state` は
  いつも claimed（L3 の `POST /lending/loans/{id}/permission` が confirmed / denied を書く。延長の拒否はもう `denied` を見ている）。
- `can_extend` は呼んだ人にとっての値（本人は回数・最長・否定を見て、備品係は貸出中ならいつも true）。`latest_due_on` は誰が見ても本人の最長。
- bootstrap の数：`my_active_count`・`my_overdue_count`（返す日 < 今日）、`keeper_attention_count`（備品係だけ。`今日 − due_on ≥
  keeper_overdue_days` か借りた人が無効化されている貸出中）。L3 の備品係のまとめは同じ対象にする。
- 備品の `updated_at`・`updated_by` は貸し出しでは変えない（台帳の編集の記録のまま）。

### 17.3 L3（M169、2026-10-26）

移行 0125（`lending_notices`・`lending_watches`。§4.1 に `role` の CHECK を足した）、`app/modules/lending/notices.py`（知らせを書く
`notify`、借りる・返す・延長・修理から戻すときの知らせ、教員の判断の知らせ、見守り、worker の `tick`、アクティビティの読み出し）、
`loans.decide`（`POST /lending/loans/{id}/permission`）、`access.may_read`・`access.may_deliver`、`PUT / DELETE /lending/items/{id}/watch`、
アクティビティの `include=lending`（`activity/service.py`・`repository.py`）、`lending.notice`（`sync/catalog.py`、WebSocket の audience で
`may_deliver`）、PushPlanner の `handle_lending`、`main.py` の scheduled のループに `lending.tick`、`i18n/messages.json` の `lending.*` と
`push.lending.*`。テストは `tests/test_lending_notices.py` と `tests/test_lending_permission.py` の判断の流れ（`tests/lending_helpers.freeze` は
`notices.utcnow` も止める）。

設計から決めたこと・変えたこと（端末の段階が知っておくこと）：

- **判断の API**：`POST /lending/loans/{id}/permission {decision: denied | confirmed, note?}` → `LendingLoanOut`（入力は `LendingPermissionIn`、
  `note` は 200 字まで、空白だけは null）。検査の順は 404 → 許可の要らない貸し出し `409 lending_permission_not_required` → 教員でない
  `403 lending_not_approver`（管理者・備品係も）→ 返却から 14 日を過ぎた `409 lending_loan_closed` → 同じ判断なら何もしない（`note` も
  変えない）。別の判断に変えると `permission_note` はその時の一言で置き換わる（無ければ null）。履歴 `permission_denied` /
  `permission_confirmed`（`details {from, to}`）、監査 `lending_loan.permission_decided {item_id, borrower_id, from, to, note}`、
  `lending.updated`。教員の作業は判断で済み（`done_by` は教員）、`activity.updated` を教員に。
- **「許可していない」の知らせ**は `denied:<loan>` の 1 回だけ（否定 → 確認 → 否定でも 2 回目は送らない）。借りた人の文の末尾に教員の
  一言（「一言：…」）を付ける。備品係（いなければ管理者）には一言を付けない。「確認した」は誰にも送らない（§8.2 のとおり）。
- **知らせの宛先の決まり**：押した本人には送らない（見ているので）。教員が備品係でもある・備品係が代わりに返して問題ありを記録した、
  などのときは本人の分を書かない。無効化された人・ゲスト・ボットには書かない。備品係は `keeper_ids` の有効な人（順番どおり）、1 人も
  いなければ `lending.manage` を持つ有効な人（管理者）。
- **アクティビティの項目**（`ActivityItem.kind = "lending"`、`include=lending` を付けた端末だけ。`filter=all` のときだけ）：
  `lending: ActivityLending {item_id, lending_item_id, loan_id, item_name, role, text, done, done_at, done_by}`。`item_id` は項目の id
  （`ActivityItem.id` と同じ、`PUT /activity/items/read` に渡す）、`lending_item_id`・`loan_id` は開く先（備品係のまとめは両方 null、
  修理から戻った見守りは `loan_id` だけ null）、`item_name` は今の備品の名前（まとめは null）、`role` は borrower / approver / keeper /
  watcher。済んでいない項目は**メンションと同じく赤いバッジ**に数える（予約と同じ）。`read` は `at ≤ read_at`、開いた、または済み。
  備品係あての項目は今も備品係である人にだけ返し（`may_read`）、機能がオフ・ゲスト・ボットには 1 件も返さない。
- **`lending.notice`**（user）：`{item_id, lending_item_id, loan_id, role, text, at}`。WebSocket の audience と PushPlanner の両方で
  `may_deliver`（項目がある・読む権利がある・催促 `due:` なら貸し出しがまだ貸出中でその返す日のまま）を確かめ、外れたら配らない。
- **プッシュ**（`kind = lending`）：`PushPayload` に `lending_item_id`・`loan_id` を足した（APNs の本体と FCM の data にも）。タイトル
  「備品」、本文は項目の 1 行（`PUSH_INCLUDE_CONTENT=false` なら「備品のお知らせがあります」）、`channel_id` は null。`collapse_key` は
  `lending:loan:<loan_id>`、修理から戻った見守りは `lending:item:<item_id>`、備品係のまとめは `lending:overdue`。DND・おやすみ時間・
  別の端末でアクティブなら出さず、後で送り直さない。済んだ項目（判断の後に計画した教員の作業）も出さない。
- **worker の `lending.tick`**（§8.4 を直した）：1 回の周期で催促の候補を 100 件まで選び、1 件ずつのトランザクションで書く。**今朝の
  `notice_minute` より後に借りた・返す日を変えた貸し出しはその日の催促を出さない**（借りてすぐ「今日が返す日です」が届かないように）。
  教員の作業の 14 日の締め切りは朝の時刻によらず周期ごとに見る。機能がオフの間は何もしない（締め切りも見ない）。
- **備品係のまとめ**：`notices.attention_loans`（`keeper_attention_count` と同じ対象。過ぎた日数の多い順）。10 件まで名前を挙げて
  「ほか N 件」。全部が `keeper_overdue_days` 以上の延滞なら §8.2 の文、無効化された人の貸し出しが混ざれば「⏰ 備品係の確認が要る
  貸し出しが N 件あります：…」（無効化された人は「（無効化されたアカウント）」、過ぎていれば日数も）。項目は作業にしない（済みは無い）。
- **見守り**：`PUT /lending/items/{id}/watch`（204、冪等）は廃棄していない備品ならどの状態でも置ける（貸出可のときは次の返却を待つ）。
  廃棄は `409 lending_item_unavailable`（`details.status`）、知らない備品は 404。`DELETE` も冪等（204）。どちらも `lending.updated` は
  出さない（変わるのは呼んだ人の `watching` だけ）。返却（`watch:<item>:<loan>`）と修理中 → 貸出可（`watch:<item>:repair:<履歴の id>`）で
  全員に知らせて消す。借りた人自身の見守りは借りたときに消す。`LendingItemOut.watching` は呼んだ人の値、`LendingItemDetailOut` に
  `watcher_count`（§5.2 に足した）。
- **文**：`i18n/messages.json` の `lending.*`（ja / en / zh-Hans）。備品は「名前（管理番号）」、日付は「月/日」（ワークスペースのゾーン）、
  人は「〇〇 さん」（en・zh-Hans は名前だけ）。名前・目的・メモは `escape_text`（メンションの構文にならない）、返却のメモは 1 行にして
  200 字まで。
- **§6.6 を直した**：返却で教員の作業を済みにすると、返却から 14 日まで押せる判断（§5.3）が画面から消えるため、済みにするのは判断した
  とき・14 日を過ぎたときだけにした（§8.2・§8.4 のとおり）。§4.1 の `done_at` の注の「備品係のまとめの対応」も、§8.2（まとめは作業に
  しない）と食い違っていたので直した。

**端末（L4〜L6）に要るもの**：`GET /activity` と `/activity/summary`・`PUT /activity/read`・`PUT /activity/items/read` に `include=lending`、
`ActivityLending` の行（📦 など文の先頭の絵文字はサーバの文に入っている。押すと `loan_id` の貸し出し → 無ければ `lending_item_id` の備品 →
両方 null なら延滞の一覧）、教員の作業（`role = approver`・`done = false`）の行に「許可していない」「確認した」（`POST
/lending/loans/{id}/permission`。`scope=approved` の一覧にも）、`lending.notice` でバッジを読み直しバナー、`activity.updated` で読み直し、
プッシュの `kind = lending` のタップ（`lending_item_id`・`loan_id`）、備品の詳細の「返却されたら知らせる」（`watching`・`PUT / DELETE …/watch`）
と延長のダイアログの `watcher_count`。

### 17.4 L4（M170、Desktop / Web、2026-10-26）

`apps/desktop/src/ui/Lending.tsx`（ページ・ダイアログ・設定のフォーム・「管理 → 備品」のタブ）、`ui/lendingRules.ts`（ワークスペースの日付・
絞り込み・借りる / 延長の範囲・409 の言い方・履歴の文。`Lending.tsx` と大文字小文字だけ違う名前は macOS で衝突するので別名）、`api/client.ts`
の `/lending/*`、ストアの `lending`（bootstrap の数）と `lendingRevision`、エンジンの `lending.updated` / `lending.notice`、
`apps/shared/nav-items.json` の `lending`（予約の次。L6 と同じ変更）、`ui/roles.ts` の `lending.manage`。テストは `tests/lending.test.tsx`。

決めたこと（後の段階が知っておくこと）：

- **入口**：場所のレール / サイドバーと、狭い画面のホームのタイルに「備品」（📦 の箱のアイコン）。bootstrap の `lending` が null（オフ・ゲスト・
  古いサーバ）のあいだは出さない。赤い数は `my_overdue_count` + 備品係なら `keeper_attention_count`（§12.1）。
- **数の読み直し**：bootstrap 以外に数を返す API は無いので、`lending.updated`（300 ms でまとめる）と `lending.notice`（朝の催促で延滞に
  なったときは `lending.updated` が来ない）の後に、`GET /lending/settings` と `GET /lending/loans?scope=mine`（備品係は `scope=active` も）から
  サーバと同じ数え方で作り直す（`sync/engine.ts` の `lendingSummaryOf`）。オフになれば null にしてナビから消す。開いているページは
  `store.lendingRevision` が進むたびに一覧・詳細・各タブを読み直す。
- **タブ**：一覧・貸出中・自分（借りているもの・最近返したもの・許可を求められた貸し出し）、備品係には延滞・管理、`lending.manage` には設定。
  一覧は検索（名前・管理番号・置き場所、全角と大文字小文字を畳む）・状態（「延滞」を含む）・分類のチップ（「未分類」）・並べ替え（名前は
  サーバの並びのまま・管理番号・返す日）・「廃棄も表示」。状態は色の点と文字（緑・青・延滞は赤・灰）。カードの左の太い帯は使わない。
  広い画面は右に詳細の欄、狭い画面（`max-md`）は詳細がページ全体になり「戻る」で一覧へ。
- **借りる**：返す日は `<input type="date">` の `min`=今日・`max`=今日 + `max_days`（ワークスペースのゾーンの日付）、既定は最長。許可の要る
  備品は `GET /lending/approvers` を読み、`self_approved` なら印の欄を出さない。教員の選択は指導教員を先頭に「（指導教員）」、候補が 8 人を
  超えれば名前の絞り込み。印・教員・目的がそろうまで「借りる」を押せない。`client_request_id` はダイアログごとに 1 つで、ネットワークの失敗・
  5xx は同じ id で 2 回まで送り直す。`409 lending_item_unavailable` は「〇〇 さんが先に借りました（10/30 まで）」/「すでに借りています」/
  「今は借りられません（修理中）」と出して詳細を読み直す。
- **延長**：本人は今の返す日の翌日〜`latest_due_on`（「あと N 回延長できます」）、備品係は今日〜365 日先（前にも戻せる、「返す日を変える」）。
  `watcher_count` があれば「この備品を待っている人がいます（N 人）」。本人の「延長」は `can_extend` が false なら押せない。
- **返す**：問題なし / 問題あり（メモ必須）。備品係が他人の貸し出しで押すと「返却を記録」（本人に知らせが届くと書く）。
- **教員**：詳細・「自分」の許可を求められた貸し出し・アクティビティの行（`role = approver` で済んでいないもの）に「許可していない」（一言を
  任意で書くダイアログ）と「確認した」。押したら手元で済みにし（`store.noteActivityItemsDone`）、`activity.updated` で確かめる。
- **アクティビティ**：`ACTIVITY_INCLUDE` に `lending`。行は 📦・見出しは備品名（まとめは「備品」）と役割（自分の貸し出し・許可の確認・備品係・
  返却の知らせ）・本文はサーバの文。押すと `loan_id` → その備品、`lending_item_id` → その備品、両方 null → 備品係は延滞・ほかは自分の
  タブ。デスクトップの通知（`lending.notice`、タイトル「備品」）も同じ所を開く。
- **管理**：分類は追加・編集（名前・許可が要る・最長の日数）・↑↓（`position` は 0 からの位置）・削除。備品の編集フォームは許可を
  「分類の既定（要る / 要らない）/ 要る / 要らない」、最長の日数は空欄で既定（プレースホルダに既定の日数）。写真は `POST /attachments` で上げて
  保存時に `photo_attachment_id`（選ぶ・ドロップ・外す）。状態の変更（貸出可・修理中・廃棄と理由）と削除は貸出中は押せない。CSV と QR は L7。
- **設定**：オン・オフ、備品係（人だけ、名前で絞り込み、20 人まで）、既定の最長・延長の回数・備品係に知らせる日数・朝の時刻（`type="time"`）・
  ゾーン（`Intl.supportedValuesOf` の候補）。機能がオフのあいだはナビに出ないので、同じフォームを「管理 → 備品」（`lending.manage`）にも置く。
- **手で確かめたこと**：作業用のサーバ（別のデータベース）と Vite（1422）・ヘッドレス Chrome で、幅 1400 と 390 の一覧・詳細・借りる
  ダイアログ・貸出中・設定、借りる → 教員のアクティビティの行 → 「許可していない」→ 詳細の赤い表示と履歴。2 つのブラウザで同時に借りる
  手順と macOS のアプリは確かめていない（409 の表示はテストで確かめた）。

### 17.5 L5（M171、iOS、2026-10-26）

`Api/LendingModels.swift`（型・`LendingApi`・`LendingUnavailable`）、`Sync/LendingHub.swift`（SyncEngine の `lending`）、`UI/LendingRules.swift`
（純粋な規則）、`UI/LendingViews.swift`（画面とシート）。ホームのタイル「備品」（`HomeTile.Kind.lending`、アイコン `shippingbox`、iPad の
サイドバーにも）、`MainRoute.lending(LendingScreen)`（備品・貸し出し・延滞・貸出中の画面を一覧の上に積む）、アクティビティの 📦 の行と
プッシュのタップ。テストは `ChikuwaChatTests/LendingTests.swift`。

決めたこと（Android・Desktop と揃えるとよいこと）：

- **端末は台帳を持たない**（§9）：`LendingHub` は bootstrap の `lending`（タイルの有無と数）、設定（ゾーン・延長の回数）、開いた画面が読んだ
  一覧だけを持つ。`lending.updated` は 300 ms でまとめて、設定（`settings: true` のとき）・自分の貸し出し・読んだことのある一覧（備品・
  許可を求められた・貸出中・延滞）を読み直し、開いている備品・貸し出しの画面も読み直す。再接続（2 回目以降の bootstrap）でも同じ。
- **タイルの数**：bootstrap の `my_overdue_count`（＋備品係なら `keeper_attention_count`）から始め、`lending.updated` の後は読み直した
  `scope=mine`（と備品係は `scope=active` から `keeper_overdue_days` 以上か無効化された人の貸し出し）で数え直す。bootstrap を読み直さない。
  0 のときは数を出さない（暗くもしない）。機能がオフ・ゲスト・ボット・古いサーバでは出さない（設定の `lending.updated` で出入りする）。
- **返す日はワークスペースのゾーンの日付**：日付の選択（`DatePicker`）に `lending_settings.tz` のカレンダーとゾーンを渡し、「今日」も
  そのゾーンで数える（端末のゾーンが違っても日がずれない）。借りるの既定は最長の日、延長は「今の返す日の次の日（過ぎていれば今日）」〜
  `latest_due_on`。
- **送り直し**：`client_request_id` は借りるシートを開いたときに 1 つ作り、閉じるまで同じものを送る（ネットワークの失敗の後に押しても
  2 つ目の貸し出しにならない）。`409 lending_item_unavailable` は `details` を読んで「〇〇 さんが先に借りました（10/30 (金) まで）」/
  「すでに借りています」/「この備品は今は借りられません（修理中）」と出し、一覧と詳細を読み直す。
- **スマホで押せるもの**：借りる（貸出可、ゲスト不可）・自分の貸し出しの返す / 延長・見守り（廃棄でなく、自分が借りていないもの）・
  教員の判断（その貸し出しの教員だけ。申告中は 2 つ、確認済みは「許可していない」、否定済みは「確認した」）。「許可していない」は
  確かめのアラートで一言（任意、200 字）を書ける。備品係の代わりの返却・日付の変更は出さない（「Desktop / Web で行います」）。
- **延滞の一覧はスマホにも読むだけで置いた**（§12.3 は「出さない」だったが、備品係のまとめの知らせ（`loan_id`・`lending_item_id` が
  どちらも null）を押した先が要るため）。備品係にだけ一覧の画面に行を出し、目的も見せる。「貸出中の一覧」（`scope=active`）は全員に。
- **知らせの開き方**：アクティビティの行・プッシュとも `loan_id` → その貸し出し、無ければ `lending_item_id` → その備品、両方無ければ
  延滞の一覧。プッシュは home のタブ（iPad は詳細の列）に「備品」の一覧を置いてその上に開く。教員の作業の行（`role = approver`・
  `done = false`）は行の下に「許可していない」「確認した」を置き、判断の後は `activity.updated` で「対応済み」になる。開いている間の
  `lending.notice` はバナー（サーバの文をそのまま。DND 中は出さない）。
- **サーバへの指摘**：なし（L1〜L3 の API のままで足りた）。
- **L7 の後（§17.8）**：`lending.updated`・`lending.notice` の後の数は `GET /lending/summary` から読む（`scope=mine`・`scope=active`
  から数え直すのは 404 の古いサーバだけ）。再接続は bootstrap の数をそのまま使う。メッセージの中の `/eq/<id>` は「備品」で開く。

### 17.6 L6（M172、Android、2026-10-26）

`apps/android`：`api/LendingModels.kt`（`LendingSettingsOut`・`LendingSummaryOut`・`LendingCategoryOut`・`LendingItemOut`（詳細の
`recent_loans`・`watcher_count` も同じ型）・`LendingLoanOut`・`LendingApproversOut`・`LendingNotice`・`ActivityLending`）、`ApiClient` の
`/lending/*`、`sync/LendingApi.kt`（エンジンが読み直す設定と貸し出し、`LendingSummary.of`）、`Store.lending`・`lendingSettings`・
`lendingRevision`、`ui/Lending.kt`（`LendingRules` と画面・ダイアログ）、`Route.Lending`、タイル `HomeTile.LENDING`、アクティビティの行、
`PushMessage` の `kind = lending`、`Notifier` と `MainActivity` のタップ、`strings_lending.xml`（ja・en・zh-Hans）。テストは `LendingTest`。

決めたこと（Desktop の L4・iOS の L5 と合わせるとよいもの）：

- **タイル**：bootstrap の `lending` が null でないあいだだけ（`NavItems.implemented(lending = …)`）。数は `my_overdue_count`（備品係なら
  `keeper_attention_count` を足す）で、1 以上のときだけ赤で出す（0 のときは数を出さない）。`apps/shared/nav-items.json` に `lending`
  （両方の形、既定の順は予約の次）を足した。L4・L5 も同じ項目を足すので、合わせるときは 1 つにする。
- **数の読み直し**：サーバには bootstrap の `lending` だけを返す API が無いので、`lending.updated` の後（300 ms にまとめる）は
  `GET /lending/loans?scope=mine`（備品係なら `scope=active` も）から `LendingSummary.of` で数え直す（`keeper_attention_count` は
  `overdue_days ≥ keeper_overdue_days` か、借りた人が無効化されている貸出中。§17.2 と同じ対象）。`settings: true` のとき・まだ設定を
  知らないときは `GET /lending/settings` も読み、オフならタイルを消す。次の bootstrap がいつも正す。
- **画面**：一覧（検索は名前・管理番号・置き場所、NFKC で全角も当たる。分類・状態のチップ、上に自分の貸出中）・貸出中・自分（自分の
  貸出中・許可を求められた貸し出し（`scope=approved`）・最近の返却）・延滞（備品係だけ、見るだけ）の 4 つのチップ。行は色の点と文字で
  状態を出す（太い色の帯は使わない）。開いているページは `Store.lendingRevision`（`lending.updated` の後と自分の操作の後に進む）で読み直す。
- **延滞の一覧**：§12.3 はスマホに延滞の一覧を出さないとしていたが、備品係のまとめ（`lending_item_id`・`loan_id` が両方 null）の
  タップ先に要るので、備品係にだけ**見るだけ**の延滞（`scope=overdue`）を出した。行から貸し出しを開ける。代わりの返却は貸し出しの
  詳細の「代わりに返却を記録」（確かめのダイアログで、本人に知らせが届くことを書く）。日付の変更（範囲外）・連絡はしない。
- **借りる**：返す日はワークスペースのゾーン（設定の `tz`）の今日〜今日 + `max_days`（既定は最長、範囲外の日はカレンダーで選べない）。
  許可が要る備品は `GET /lending/approvers` を読み、`self_approved` なら印の欄を隠す。教員は指導教員を先頭に名前の順（7 人以上で検索）、
  指導教員を既定で選ぶ。`client_request_id` はダイアログを開いたときに 1 つ作り、送り直し（ネットワークの失敗の後など）も同じものを送る。
  `409 lending_item_unavailable` は `details` から「〇〇 さんが先に借りました（10/30 まで）」・自分なら「すでに借りています」・修理中なら
  その旨を出し、備品を読み直す。
- **教員の判断**：貸し出しの詳細（教員本人で、貸出中か返却から 14 日以内）と、アクティビティの教員の作業の行（`role = approver`・
  済んでいない）に「許可していない」「確認した」を置く。どちらも確かめのダイアログを出し、「許可していない」は一言（任意、200 字）を
  付けられる。今の判断と同じボタンは出さない（切り替えはできる）。
- **アクティビティ**：`include=lending` をすべてのアクティビティの呼び出しに付けた。行の見出しは「備品名 · 自分の貸し出し / 許可の確認 /
  備品係 / 返却の知らせ」、本文はサーバの 1 行をプレーンテキストで（絵文字のショートコードも解かない）。教員の作業は済んだら
  「対応済み」で薄くし、未読に数えない（予約と同じ）。押すと `loan_id` → `lending_item_id` → 延滞の一覧の順に開く。
- **通知**：FCM の `kind = lending` は会話が無くても通知にする。キーはサーバの `collapse_key`（無ければ `lending:loan:<id>` /
  `lending:item:<id>` / `lending:overdue`）。アプリが開いていてソケットがつながっているときは、`lending.notice` からバナーと同じキーの
  ローカル通知（DND・おやすみ時間の間は出さない）。タップはそのワークスペースに切り替えて、ホームのタブに「備品」→ 貸し出し（無ければ備品、
  両方無ければ延滞の一覧）を積む。
- 台帳の編集・分類・設定・CSV は出さない（一覧の下に「Desktop / Web で管理します」）。新しい依存は足していない。

サーバへの気づき（直していない）：bootstrap の `lending` だけを読む API が無いため、端末は数を貸し出しの一覧から数え直している
（`GET /lending/summary` のようなものがあれば、備品係の端末が `scope=active` を毎回読まなくて済む）。
→ L7 で `GET /lending/summary` を足した（§5.1・§17.7）。L7 の後、Android もこれを読むようにした（§17.8。`LendingSummary.of` は
404 の古いサーバのときだけ使う）。メッセージの中の `/eq/<id>` も「備品」で開く。

### 17.7 L7（M173、CSV と QR のラベル、2026-10-26）

サーバ：`app/modules/lending/csvio.py`（書き出しと取り込み）、`GET /lending/items/export.csv`・`POST /lending/items/import`・`GET /lending/summary`
（`router.py`。`export.csv` は `/lending/items/{item_id}` より前に置く）、`app/core/pages.py` の `/eq/{item_id}`、`notices.tick` の
`lending.updated`、`i18n/messages.json` の `lending.csv.*`（行のエラーの文、ja / en / zh-Hans）、`infra/Caddyfile`（取り込みは 2 MB まで通す。
ほかの `/api/*` の 1 MB では 1 MB の CSV に multipart の分が乗って切られる）。移行なし。テストは `tests/test_lending_csv.py`。
Desktop / Web：`ui/LendingCsv.tsx`（「管理 → CSV」と取り込みのダイアログ）、`ui/LendingLabels.tsx`（「管理 → QR のラベル」）、
`ui/permalink.ts` の `equipmentLink`・`parseEquipmentLink`、`ui/routes.ts` の `/eq/`、メッセージの中の備品のリンク（「備品を開く」）、
エンジンの数の読み直しを `GET /lending/summary` に。テストは `tests/lendingCsv.test.tsx`。

決めたこと（スマホと後の段階が知っておくこと）：

- **リンクの接頭辞は `/eq/`**：§13.5 の `/e/` は予定のリンク（CALENDAR.md §11、Web の入口と Desktop のメッセージの中のリンク）と
  重なっていた。`/eq/`（equipment）はサーバの頁（`pages.py`）にも Web の入口（`routes.ts`）にも無かった。サーバの頁は中身を明かさない
  （`/m/`・`/d/` と同じ）。Caddy の後ろでは知らない道は Web を読むので、ブラウザで開くと Web がログインの後に「備品」のその備品を開く。
- **スマホのアプリはリンクを開かない**：iOS・Android にはユニバーサルリンク / App Links が無い（§13.5 のとおり）。OS のカメラで読むと
  ブラウザの Web が開く。アプリのメッセージの中の `/eq/` のリンクは L7 の後に「備品」で開くようにした（§17.8）。
- **書き出し**：`lending.*` の他の API と同じく備品係（`403 lending_keeper_required`、ゲストは `403 guest_restricted`、オフは 409）。
  名前の順（一覧と同じ）。表計算が数式と読むセル（`=`・`+`・`-`・`@`・タブ・CR で始まる）と `'` で始まるセル（§18）は前に `'` を付ける。状態は日本語の言葉
  （貸出可・貸出中・修理中・廃棄）、「許可が要る」は「要る」「要らない」か空欄（分類の既定）、「最長の日数」は数か空欄（既定）、
  借りている人は表示名、返す日は ISO の日付。列の見出しは日本語に固定（読む人の言語によらない）。
- **取り込み**：
  - 列は見出しで探す（順は自由）。日本語の見出しのほか英語（`code`・`name`・`category`・`location`・`status`・`requires_permission`・
    `max_days`・`notes`）も読む。「名前」の列は必須。**ファイルにある列だけ**を比べて書く（空のセルはその項目を空にする。列が無ければ
    今のまま）。「借りている人」「返す日」は読まない。「状態」は「廃棄」（`retired`）の行を飛ばす（`skipped`）ためだけに読む。
  - 突き合わせ：管理番号（NFC + casefold）で廃棄していない備品と。管理番号の無い行は、管理番号の無い廃棄していない備品と名前で。
    同じ名前の候補が 2 つ以上なら `name_ambiguous`。ファイルの中で管理番号・（管理番号の無い）名前が重なれば 2 つ目が
    `code_duplicate` / `name_duplicate`（そうしないと 2 回目の取り込みが決まらない）。
  - 値：「許可が要る」は 要る / はい / yes / true / 1 / ○ と 要らない / いいえ / no / false / 0 / ×、空欄・「既定」は既定。「最長の日数」は
    1〜365（「14 日」「14 days」も）。文字の長さは API と同じ上限（`too_long`）。分類は 50 個まで、備品は（廃棄を含めて）2,000 個まで。
    書き出しが付けた `'` は外す（書き出したものをそのまま取り込むと、すべて「変わらない」）。
  - 文字コードは UTF-8（BOM の有無を問わない）、読めなければ Shift_JIS（cp932、日本語の Excel の保存の既定）。ファイル全体の誤り
    （1 MB を超える・データが 2,001 行以上・文字コード・CSV として読めない・「名前」の列が無い・データが無い）は dry run でも
    `400 lending_csv_invalid` で、`details.errors` に `line: 0` の 1 件。
  - 応答 `LendingImportOut`：`rows` はエラーの無い行（`line`・`action`（created / updated / unchanged / skipped）・`item_id`（dry run の新しい
    備品は null）・`name`・`code`・`changes: [{field, before, after}]`。`field` は name / category / location / notes / requires_permission /
    max_days、値は文字（許可は "true" / "false"、日数は数字、空は null））。`errors` の `message` は読む人の言語（`Accept-Language` か本人の設定）。
  - 当てるとき：分類・備品の advisory lock を取り、**全部の備品の行を `FOR UPDATE`** で読んでから突き合わせ直す（dry run の後の変更も
    見る）。エラーがあれば何も書かずに 400。変わるものが無ければ何も書かない（監査・イベントも無し）。新しい分類は並びの最後に
    （既定の許可・日数なし、監査 `lending_category.created`、`details.via = import`）。備品は履歴 `created` / `updated`（`details.via = import`）、
    監査は `lending_import.applied`（件数と作った分類）の 1 行だけ。`lending.updated` は 1 つ（変えた備品の id、分類を作れば `categories: true`）。
- **`lending.tick` の `lending.updated`**：その周期に返す日の当日・過ぎた催促（`due:…:<n>`、n ≥ 0）を書いた貸し出しがあれば、周期の
  終わりに 1 つだけ（`item_ids` はその備品）。前日の催促だけでは送らない。催促は 1 人 1 キー 1 回なので、同じ朝の 2 回目の周期は送らない。
  延滞になるのは日付の変わり目だが、端末に知らせるのは朝の時刻（それまでは bootstrap と開いた画面が正しい数を読む）。
- **`GET /lending/summary`**：bootstrap の `lending` と同じ値（同じ関数）。Desktop / Web のエンジンは `lending.updated` の後にこれだけを読む
  （オフ・ゲストの 409 / 403 は null として「備品」を隠す）。M173 より前のサーバ（`404 not_found`）では M170 のやり方（設定と貸し出しの
  一覧から数える）に戻る。iOS・Android も L7 の後にこの API に替えた（§17.8）。
- **QR**：`qrcode-generator` 2.0.4（Kazuhiko Arase、MIT、依存なし、ESM と型付き、2025-08 の版に固定）。Desktop にもサーバにも JS の QR の
  ライブラリは無かった（2 段階認証の QR はサーバの Python の `qrcode` が PNG で返す）。リンクは端末が知っているサーバのアドレス
  （Web は `location.origin`）から作るので、サーバで作るより素直（サーバは `PUBLIC_BASE_URL` が無いと自分の外のアドレスを知らない）。
  誤り訂正は M。行列だけを使い、SVG のパスは自分で描く。
- **ラベル**：A4 の 24 面（3 × 8、70 × 37 mm、`@page { size: A4; margin: 0 }`）。左に QR（29 mm）、右に名前（太字、3 行まで）と管理番号。
  廃棄を除く備品から選ぶ（分類で絞り込み、既定はすべて）。「印刷」はこのページで `window.print()`（印刷の間はアプリを隠してラベルだけを
  出す）。「HTML で保存」は同じシートの HTML を保存する（アプリの窓から印刷できない環境のため。ブラウザで倍率 100%・余白なしで印刷）。
  手で確かめたこと：書き出した HTML をヘッドレス Chrome で A4 に描き、OpenCV の QR の読み取りで 5 つのリンクがすべて読めた。
  スマホのカメラで読む手順と、macOS / Windows のアプリの `window.print()` は確かめていない。
- **取り込みの画面**：「管理 → CSV」の「取り込む…」でファイルを選ぶと dry run を送り、ダイアログに件数・新しい分類・行のエラー・
  差分の表（既定は「新しく作る」「変える」の行だけ、「変わらない行も表示」で全部）。エラーがあるあいだ「取り込む」は押せない。当てる
  ときの 400 は行のエラーとして同じダイアログに出す。

### 17.8 L7 の後の手直し（iOS・Android、2026-10-26）

サーバ・Desktop / Web は変えていない。iOS：`LendingApi.lendingSummary()`（`Api/LendingModels.swift`）、`LendingHub.loadSummary()`・
`summaryRoute`、`LendingRules.isMissingRoute`、`EquipmentLink`（`UI/Permalink.swift`）、`MessageBodyView` の `equipmentLinks`、
`AppController.openEquipmentLink`。Android：`LendingApi.lendingSummary()`（`ApiClient`）、`SyncEngine.reloadLending` の
`lendingSummaryRoute`、`LendingSummary.isMissingRoute`、`Permalink.equipmentId`・`equipmentUrl`、`MessageBody` の `onOpenEquipment`、
`AppController.openEquipmentLink`。テストは iOS `LendingTests`、Android `LendingTest`。

- **タイルの数**：`lending.updated`・`lending.notice`（朝の催促は `lending.updated` を伴わないことがある）の後（300 ms にまとめる）は
  `GET /lending/summary` を読み、その値をそのまま使う。`409 lending_disabled`・`403 guest_restricted` は bootstrap の null と同じに扱い、
  「備品」を隠す（iOS は設定も捨て、次の `settings: true` で読み直す）。再接続（2 回目以降の bootstrap）は bootstrap の数を使い、
  summary を読み直さない（開いた画面の一覧は今までどおり読み直す）。
- **古いサーバ**：`404 not_found`（か 405）なら M173 より前のサーバとして覚え、それからは M171・M172 のやり方（`scope=mine` と、
  備品係は `scope=active` から数える）に戻る。summary を読むのは端末ごとに 1 回だけで、404 を毎回待たない。ほかの失敗（ネットワーク・
  5xx）は数をそのままにし、次の bootstrap が正す。備品係の端末は summary が読めるあいだ `scope=active` を数のためには読まない。
- **`/eq/<item_id>` のリンク**：ログインしているサーバの `/eq/` で、UUID のものだけ（大文字小文字・クエリ・フラグメントは問わない。
  `/e/` の予定のリンクとは重ならない）。「備品」が自分に有効なあいだは「📦 備品を開く」（書いた人のラベルがあればそれ）として描き、
  押すとそのワークスペースのホームのタブに「備品」→ その備品を積む（知らせのタップと同じ道）。無効なあいだ（オフ・ゲスト・ボット・
  M167 より前のサーバ）はふつうのリンクのまま（ブラウザの Web が開く）。描いた後にオフになっていれば、押したときにブラウザで開く。
  見えない備品・消えた備品は備品の画面がいつものエラーを出す。リンクを描くのは会話のメッセージ（スレッドを含む）だけで、
  キャンバス・ページ・AI の答えではふつうのリンクのまま。

## 18. REVIEW-v0.1.82 の対応（2026-10-30）

- **CSV の先頭のアポストロフィ**（#8）：書き出しは、表計算が数式と読む頭（`=`・`+`・`-`・`@`・タブ・CR）に加えて、`'` で始まる
  値の前にも `'` を付ける。取り込みは、`'` の後ろが数式の頭か `'` のときだけ 1 つ外す。これで `'=original` のような値も、書き出し →
  取り込み → 書き出しで変わらない（今までは取り込みで `=original` になっていた）。手で書いた `'abc` はそのまま残り、`''abc` と
  書けば `'abc` になる。
- 表計算ソフトは `'` で始まるセルを文字列として読むので、数式の注入の防ぎはそのまま。
- 試験：`test_lending_csv.py::test_round_trip_keeps_leading_apostrophes`（名前・管理番号・分類・置き場所・メモに `''`・`'=`・`'+`・
  `'棚`、メモの `'@`。書き出しの形、取り込みが全部 unchanged、再書き出しが同じバイト列、手書きの `'手書き`）。
