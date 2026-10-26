# LENDING（備品の貸し出し）

2026-10-26 の設計。**本書は設計だけで、コードはまだ無い。** マイルストーンは L1〜L7（§16。M 番号は仮に M167〜M173、移行は
0123〜0125。並行する作業と重なれば振り直す）。

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
  **後の段階で作る**：CSV の取り込み・書き出しと、QR のラベル（備品のリンク `/e/<id>` を印刷する）（L7、§13）。

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
  done_at                timestamptz,                   -- 作業の済み（教員の判断・備品係のまとめの対応）
  done_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (user_id, key)
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
| `GET /lending/settings` | `LendingSettingsOut {enabled, keeper_ids, default_max_days, max_extensions, keeper_overdue_days, notice_minute, tz, is_keeper}`。人なら誰でも（機能がオフでも読める。ゲストは `403 guest_restricted`） |
| `PATCH /admin/lending/settings` | 上の項目の一部（`is_keeper` を除く）。`lending.manage`（`403 admin_required`）。`keeper_ids` に無効・ゲスト・ボット・知らない人がいれば `400 lending_keeper_invalid`（`details.user_ids`）、21 人目は 422。範囲外の数・知らないゾーンは 422。監査 `lending_settings.updated`、`lending.updated {settings: true}` |

bootstrap に **`lending: LendingSummaryOut | null`**（ゲストと、オフのときは null。ACTIONS.md の `actions` と同じ）：
`{enabled, is_keeper, my_active_count, my_overdue_count, keeper_attention_count, settings_updated_at}`。タイル・ナビの数字（§12.1）に使う。

### 5.2 分類と備品

| | |
| --- | --- |
| `GET /lending/categories` | `CategoryOut[]`（`position` の順）`{id, name, position, requires_permission, max_days, item_count}` |
| `POST /lending/categories` (201) | `{name, requires_permission?, max_days?}`。備品係（`403 lending_keeper_required`）。同じ名前は `409 lending_category_name_taken`、51 個目は `409 too_many_lending_categories` |
| `PATCH /lending/categories/{id}` | 同じ項目の一部と `position`。既定の変更は、その分類で値を持たない備品のこれからの貸し出しに効く（貸出中のものは変えない） |
| `DELETE /lending/categories/{id}` (204) | 備品が残っていれば `409 lending_category_in_use`（`details.item_count`） |
| `GET /lending/items` | `ItemOut[]`。既定は廃棄を除くすべて（`?include_retired=true` で含める）。名前の順（`core/collation` の日本語の並び）。**ページに分けない**（2,000 個まで、§4.1）。端末が手元で絞り込む（分類・状態・文字） |
| `GET /lending/items/{id}` | `ItemDetailOut`（`ItemOut` + 最近の貸し出し 5 件 + 見守りの有無） |
| `POST /lending/items` (201) | `{name, category_id?, code?, location?, notes?, requires_permission?, max_days?, photo_attachment_id?}`。備品係。管理番号の重複は `409 lending_code_taken`（`details.existing_id`）、2,001 個目は `409 too_many_lending_items` |
| `PATCH /lending/items/{id}` | 同じ項目の一部（null で外す）。備品係。`status` はここでは変えない |
| `POST /lending/items/{id}/status` | `{status: available \| in_repair \| retired, note?}`。備品係。貸出中は `409 lending_item_on_loan`（先に返却を記録する）。廃棄から戻すときに管理番号が使われていれば `409 lending_code_taken`。同じ状態なら何もしない |
| `DELETE /lending/items/{id}` (204) | 備品係。貸し出しが 1 度でもあれば `409 lending_item_has_history`（廃棄にする） |
| `GET /lending/items/{id}/history?before=<event_id>&limit=50` | `{events: ItemEventOut[], next_before}`（新しい順、カーソル） |
| `PUT / DELETE /lending/items/{id}/watch` | 返却を知らせる（§6.7）。冪等（204） |
| `GET /lending/approvers` | 教員の候補（§6.4）`{user_ids, suggested_ids}`（`suggested_ids` は呼んだ人の指導教員） |

`ItemOut`：`id, name, category_id, code, location, notes, photo (AttachmentOut | null), status, status_note, requires_permission
（実際の値）, requires_permission_source（item / category / default）, max_days（実際の値）, loan (LoanBriefOut | null), watching,
created_at, updated_at`。`LoanBriefOut`：`id, borrower_id, borrowed_at, due_on, overdue_days, permission_state`（目的などは載せない）。

### 5.3 貸し出し

| | |
| --- | --- |
| `POST /lending/items/{id}/borrow` | `{client_request_id, due_on, purpose, permission_confirmed?, approver_id?}` → 201 `LoanOut`（送り直しは 200 で同じもの）。人（ゲスト不可）。状態が貸出可でなければ `409 lending_item_unavailable`（`details`: `status`、貸出中なら `loan_id`・`borrower_id`・`due_on`）。返す日が過去・最長を超えるなら `400 lending_due_invalid`（`details.reason`: past / too_long、`details.latest`）。許可が要るのに印か教員が無ければ `400 lending_permission_required`、教員が候補でない・自分・無効なら `400 lending_approver_invalid`。目的が空は 422 |
| `POST /lending/loans/{id}/return` | `{condition: ok \| issue, note?}`（`issue` のときは note が必須、422）。本人か備品係（ほかは `403 lending_not_yours`）。返却済みなら何もしない（200、今の `LoanOut`） |
| `POST /lending/loans/{id}/extend` | `{due_on}`。本人：今の返す日より後で、今日 + 最長の日数まで、延長の回数が `max_extensions` まで（`409 lending_extend_limit`）。備品係：365 日先まで、回数を数えず、前にも戻せる（記録 `due_changed`、本人に知らせる）。教員が「許可していない」とした貸し出しは本人は延長できない（`409 lending_permission_denied`）。返却済みは `409 lending_loan_closed` |
| `POST /lending/loans/{id}/permission` | `{decision: denied \| confirmed, note?}`。その貸し出しの教員だけ（`403 lending_not_approver`）。許可が要らない貸し出しは `409 lending_permission_not_required`。返却から 14 日を過ぎたら `409 lending_loan_closed`。同じ判断の送り直しは何もしない。`confirmed` → `denied` には変えられる（後で気づいた）、`denied` → `confirmed` も変えられる（押し間違い。両方とも記録が残る） |
| `GET /lending/loans?scope=mine` | 自分の貸し出し（貸出中を返す日の順、その後に返却済みを新しい順 50 件） |
| `GET /lending/loans?scope=active` | 貸出中のすべて（返す日の順）。誰が何をいつまで（`LoanOut` の目的などは見える人にだけ） |
| `GET /lending/loans?scope=overdue` | 返す日を過ぎたもの（過ぎた日数の多い順）。備品係（`403 lending_keeper_required`） |
| `GET /lending/loans?scope=approved` | 自分が教員として選ばれた貸し出し（貸出中と、返却から 14 日以内） |
| `GET /lending/loans/{id}` | 1 つ。見える人（台帳と同じ）。詳細の項目は §3.2 の規則で空にする |

`LoanOut`：`id, item_id, borrower_id, borrowed_at, due_on, original_due_on, overdue_days, extension_count, can_extend, latest_due_on
（本人が延ばせる最も後の日）, purpose?, permission_required, approver_id?, permission_state?, permission_decided_at?, permission_note?,
returned_at, returned_by, return_condition?, return_note?, status`。`?` の項目は本人・教員・備品係・管理者にだけ入り、ほかの人には
null（`details_hidden: true`）。

### 5.4 CSV（L7、§13.3）

| | |
| --- | --- |
| `GET /lending/items/export.csv` | 備品係。UTF-8（BOM 付き、Excel のため）。列は `管理番号, 名前, 分類, 置き場所, 状態, 許可が要る, 最長の日数, 付属品とメモ, 借りている人, 返す日` |
| `POST /lending/items/import?dry_run=true` | 備品係。multipart の CSV（1 MB・2,000 行まで）。管理番号で既存と突き合わせ、無ければ作る（分類は名前で、無ければ作る）。`{created, updated, unchanged, errors: [{line, code, message}]}`。`dry_run=false` で同じ内容を 1 つのトランザクションで当てる（エラーが 1 つでもあれば `400 lending_csv_invalid` で何も当てない）。状態・貸し出しは取り込まない。監査 `lending_import.applied` |

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
3. 教員が自分で借りるとき（呼んだ人が教員の候補のとき、§6.4）は許可の印を求めない（`permission_required = false` とし、履歴の
   `details.self_approved = true`）。

### 6.4 教員の候補

- 名簿（LAB.md）の**管理グループ `position:faculty`（`@faculty`）のメンバー**で、有効な人。借りる人の指導教員（`lab_profiles.advisor_ids`）を
  先頭に出す（`suggested_ids`）。
- 名簿を使っていない（グループが無い・空の）ワークスペースでは、人（admin・manager・member）の全員から選ぶ。研究室以外での汎用の
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
   見守り → その人たち、教員の未済の作業 → 済み）・`lending.updated` を 1 つのトランザクションで。
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
  2. 返す日が明日以前の貸出中（`lending_loans_due_idx`）を、貸し出しの行の `FOR UPDATE SKIP LOCKED` で 100 件ずつ取り、
     今日のキー（`due:<loan>:<due_on>:<今日 − due_on>`）が `lending_notices` に無ければ書く（同じトランザクションで outbox）。
  3. 備品係のまとめ：今日の `overdue:<日付>` を、まだ受け取っていない備品係（いなければ管理者）に書く。対象が無ければ書かない。
  4. 教員の作業で返却から 14 日を過ぎたものを済みにする。
- **取りこぼしの扱い**：サーバが止まっていて朝を過ぎても、その日のうちに動けばその日の分を出す。**前の日の分は出さない**（キーが
  今日の日付だけなので、3 日止まっていても「5 日過ぎています」の 1 つだけ。DEADLINES.md §4 の「いちばん近い 1 件」と同じ考え）。
- キーは `(user_id, key)` で一意なので、worker が 2 つ動いても、同じ周期に 2 回動いても 1 回だけ。
- 失敗は貸し出しごとに巻き戻してログに残し、次の周期でまた試す（予約の `tick` と同じ）。

## 9. 同期

| type | audience | seq | data |
| --- | --- | --- | --- |
| `lending.updated` | all | — | `{item_ids, settings}`。備品・貸し出し・分類（`item_ids` は空で `categories: true`）・設定（`settings: true`）が変わった。中身は人によって違う（目的などの見える範囲）ので載せず、端末は `GET /lending/items`（設定なら `GET /lending/settings`、bootstrap の `lending` も）を読み直す。続けて届いたものは 300 ms で 1 回にまとめる。ゲストにも届きうるが中身は無い（予約の `reservation.updated` と同じ） |
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
- CSV の書き出しは表計算の数式の注入を防ぐ（`=`・`+`・`-`・`@` で始まる値の前に `'` を付ける）。取り込みの大きさと行数の上限。
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

- 備品のリンク `<server>/e/<item_id>`：`pages.py` に案内ページ（`/m/`・`/c/`・`/d/` と同じ形、中身を明かさない）、Web はそのまま
  「備品」のその詳細を開く。会話に貼るとカード（DRIVE.md §25 の `/d/` のカードと同じ作り）は後で。
- Desktop / Web の「管理 → QR のラベル」で、選んだ備品の QR（リンク）・名前・管理番号を A4 のラベルの格子に並べて印刷する。QR の
  符号化は小さな関数を `apps/desktop` に持つ（依存を足すかは L7 で決める。足すなら 1 つ、バージョンを固定したもの）。
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
| **L7** CSV と QR のラベル | M173 | `export.csv`・`import`（dry run と当てる、§5.4）、Desktop の取り込みの画面（差分の表）、`/e/<id>` の案内ページと Web の遷移、QR のラベルの印刷 | pytest：取り込みの冪等（2 回目は unchanged）、数式の注入の防ぎ、行のエラー。Desktop で 300 行の CSV を取り込み、ラベルを印刷してスマホのカメラで読むと Web のその備品が開く |

- 使い始められるのは L4 の後（台帳を作って Desktop / Web で借りる・返すができ、知らせも届く）。L5・L6 は並行してよい。L7 は台帳を
  スプレッドシートから移すときに要るので、利用者の今の表の大きさ次第で L4 の直後に回す。
- 見積もりの目安：L1 3 日、L2 3 日、L3 4 日、L4 1 週、L5・L6 各 4 日、L7 3 日。
