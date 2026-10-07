# 在室状況（attendance、M140）

メンバーが「在室」「学内」「学外」「帰宅」のような今いる場所をワンタップで切り替え、ワークスペースの全員がボード（誰がどこにいるか）で
見られる機能。外のシステム（研究室や会社の Web サイトの在室ボードなど）と、送信 Webhook と受信 API で双方向に同期できる。

研究室の要望（2026-10-07）から作るが、**汎用の機能**として作る：リポジトリに特定のサイト・人・状態の名前は持たない。既定は
**オフ**で、管理者が有効にする。

**状態**：設計（本書）と、サーバ・Desktop / Web を実装（2026-10-07、移行 0100）。iOS・Android も §9 のとおり実装（2026-10-07）。
マイルストーンの番号 M140 は仮
（並行する作業と重なれば振り直す）。

## 0. 名前（presence と attendance）

`presence` は M11b からオンライン表示（online / away / offline、WS の揮発フレーム `presence`、bootstrap の `presence`）の名前として
使っている。混ざらないよう、この機能はコード・API・イベント・テーブル・ナビの鍵で **`attendance`** と呼ぶ（表示名は「在室状況」）。
本書のファイル名だけ依頼のとおり PRESENCE.md にした。

| 呼び方 | 意味 |
| --- | --- |
| 在席（presence） | 今アプリを開いているか。自動（M11b） |
| 在室状況（attendance） | 本人が選ぶ「今どこにいるか」。本書 |
| ステータス（status_emoji / status_text） | 本人が書く一言と絵文字（M11d）。在室状況とは別に残す |

## 1. 方針

- **1 人 1 行**：今の状態は人ごとに 1 行（`attendance_current`）。変更の履歴は追記だけの記録（`attendance_log`）。
- **状態は 2 種類**：
  - **ワークスペースの状態**：管理者が作る。全員のボタンに出る。
  - **個人の状態**：許された人が自分用に足す（「会議」「出張」など）。本人のボタンにだけ出て、ボードではその人の行に出る。
- **状態の分類 `kind`** は固定の 4 つ。グループ分けと「在室 n 人」の数に使う。名前・絵文字・色はワークスペースのデータ。

  | kind | 意味 | 既定の状態（有効にした管理者の言語で作る） | アイコン | 絵文字 | 色 |
  | --- | --- | --- | --- | --- | --- |
  | `in_room` | その部屋にいる（数える対象） | 在室 / In the room / 在室 | `in_room` | 🟢 | green |
  | `on_site` | 部屋にはいないが敷地内（学内・社内） | 学内 / On site / 校内 | `on_site` | 🏫 | blue |
  | `off_site` | 外出・外で仕事中 | 学外 / Off site / 校外 | `off_site` | 🚶 | purple |
  | `gone` | 今日は終わり・不在 | 帰宅 / Gone home / 已回家 | `gone` | 🏠 | red |

  既定の 4 つは、最初に有効にしたとき状態が 1 つも無ければ作る。そのあとの名前・アイコン・色は管理者が自由に変えられる（翻訳は既定の
  作成のときだけ）。色は 2026-10-07 に学外 orange → purple、帰宅 gray → red に変えた（4 つの色をはっきり分けるため）。**すでに有効に
  したワークスペースの色は変えない**（管理の「在室状況」タブの色の見本で変えられる）。
- **見られる人**：ゲストでない有効なアカウント（ボットを除く）。ゲスト（MEMBERSHIP.md）には見せない（ボードの API は `403 guest_restricted`、
  イベントも届かず、bootstrap は null）。ゲストは自分の在室状況も持たない。ボードに載るのもゲストでない有効な人だけ。
- **変えられる人**：アプリからは本人だけ。管理者は他人のを変えられる（監査 `attendance.set_by_admin`）。外のシステムからは連携の
  トークン（§6）。
- **オフのとき**：データ（状態・今の値・記録・連携）は残すが、ボード・ボタン・Webhook・受信 API は止まる（受信は `409 attendance_disabled`）。
  もう一度有効にすると元の値で戻る。オフにした時点で送っていない配送は取り消し（`cancelled`）、有効に戻しても送らない（§5.1）。

## 2. データ（移行 0100）

```sql
CREATE TABLE attendance_settings (            -- 1 行（無ければ既定値として読む）
  singleton           boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled             boolean NOT NULL DEFAULT false,
  personal_rule       text NOT NULL DEFAULT 'nobody',  -- nobody | everyone | admins | groups
  personal_group_ids  uuid[] NOT NULL DEFAULT '{}',   -- rule = groups のとき（グループのメンバー）
  log_retention_days  integer NOT NULL DEFAULT 365,   -- 0 = 消さない
  updated_at, updated_by
);

CREATE TABLE attendance_states (
  id          uuid PRIMARY KEY,
  owner_id    uuid REFERENCES users(id) ON DELETE CASCADE,  -- NULL = ワークスペースの状態
  label       varchar(40) NOT NULL,
  icon        varchar(32),          -- §2.1 のアイコンの鍵（移行 0101）。無くてもよい
  emoji       varchar(32),          -- Unicode の絵文字か :custom: の名前。無くてもよい（アイコンを出せない端末の代わり）
  color       text NOT NULL,        -- apps/shared/text-emoji.json の色の鍵（gray red orange yellow green blue purple pink）
  kind        text NOT NULL,        -- in_room | on_site | off_site | gone
  position    integer NOT NULL,     -- 並び（ワークスペース・人ごと）
  archived_at timestamptz,          -- 消した状態（使っている人がいても壊さないため、行は残す）
  created_at, updated_at
);
-- 名前は、消していない同じ範囲（ワークスペース全体 / その人）で大文字小文字を区別せず重ならない。
-- 個人の状態の名前はワークスペースの状態の名前とも重ならない（受信 API の名前での対応を一意にするため）。

CREATE TABLE attendance_current (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state_id       uuid NOT NULL REFERENCES attendance_states(id),
  since          timestamptz NOT NULL,   -- この状態になった時刻（メモだけの変更では動かない）
  changed_at     timestamptz NOT NULL,   -- 最後に受け付けた変更（状態・メモ）の時刻（移行 0104。§6 の古さの比較に使う）
  note           varchar(100),
  source         text NOT NULL,          -- app | admin | integration | auto
  actor_id       uuid,                   -- 変えた人（本人 / 管理者。連携なら NULL）
  integration_id uuid,                   -- source = integration のとき
  updated_at     timestamptz NOT NULL
);

CREATE TABLE attendance_log (           -- 追記だけ。保持期間（log_retention_days）を過ぎたら消す
  id bigint PRIMARY KEY, user_id, from_state_id, to_state_id, note, at, source, actor_id, integration_id
);

CREATE TABLE attendance_integrations (  -- 外のシステムとの連携（§5・§6）
  id uuid PRIMARY KEY, name varchar(80),
  url text,                 -- 送信先（NULL = 送らない）
  secret_name text,         -- 署名の鍵のファイル名（§5.3。NULL = 送らない）
  token_hash bytea UNIQUE,  -- 受信のトークンの SHA-256（NULL = 受け付けない）
  enabled boolean, created_by, created_at, updated_at, last_inbound_at
);

CREATE TABLE attendance_deliveries (    -- 送信 Webhook の 1 回の配送（outbox の後段）
  id uuid PRIMARY KEY,                  -- = delivery_id（再送でも同じ）
  integration_id uuid REFERENCES attendance_integrations(id) ON DELETE CASCADE,
  log_id bigint,                        -- どの変更か（テスト送信は NULL）
  user_id uuid,
  outbox_event_id bigint,               -- UNIQUE (outbox_event_id, integration_id)：二重に作らない
  body jsonb NOT NULL,                  -- 送る JSON（作った時点の名前で固定。再送も同じ本文）
  status text,                          -- pending | delivered | failed | superseded | cancelled（オフにした。§5.1）
  attempts integer, next_attempt_at, last_status_code, last_error, delivered_at, created_at
);
```

人数は数十人なので、ボードは表を丸ごと読む（1 人 1 行）。

### 2.1 アイコン（2026-10-07、移行 0101）

絵文字は端末で見た目が違い、粗く見えるので、状態には **アイコン** を付ける。`icon` は意味の鍵で、各端末が自分の標準のアイコンで描く。
一覧は **apps/shared/attendance-icons.json**（鍵の順 = 選ぶ画面の並び。サーバの `ICON_KEYS` と各端末の写しはテストで突き合わせる）：

| 鍵 | 意味（ja） | Desktop / Web（lucide-react） | iOS（SF Symbols） | Android（`Icons.Outlined.*`） |
| --- | --- | --- | --- | --- |
| `in_room` | 在室 | DoorOpen | door.left.hand.open | MeetingRoom |
| `on_site` | 建物内 | Building2 | building.2 | Business |
| `off_site` | 外出 | MapPin | mappin.and.ellipse | Place |
| `gone` | 帰宅 | House | house | Home |
| `meeting` | 会議 | Users | person.2 | Groups |
| `class` | 授業・発表 | Presentation | rectangle.inset.filled.and.person.filled | CoPresent |
| `remote` | リモート | Laptop | laptopcomputer | Laptop |
| `lunch` | 食事 | Utensils | fork.knife | Restaurant |
| `trip` | 出張・移動 | Plane | airplane | Flight |
| `away` | 少し離席 | Clock | clock | Schedule |
| `busy` | 取り込み中 | CircleMinus | minus.circle | RemoveCircleOutline |
| `sick` | 体調不良 | Thermometer | thermometer.medium | Thermostat |
| `vacation` | 休暇 | TreePalm | beach.umbrella | BeachAccess |
| `lab` | 実験 | FlaskConical | flask | Science |
| `library` | 図書館 | Library | books.vertical | LocalLibrary |
| `other` | その他 | Circle | circle | Circle |

- API では enum ではなく文字列（後から鍵を足しても古い端末のデコードが壊れない）。サーバは一覧の鍵だけを受け付ける（ほかは 422）。
- 端末は、知らない鍵・`icon` が null のときは絵文字を、それも無ければ名前だけを出す。テキストだけの場所（選択肢・記録の行）は、
  アイコンを描ける状態なら名前だけ、描けなければ「絵文字 名前」。
- 見た目は **塗りつぶしの角丸のバッジ**（§2.2）：背景は状態の色の濃い色、アイコンと名前は白。ライトでもダークでも同じ。
- 新しく状態を作る画面では、アイコンは選ぶまで分類（kind）の既定のアイコンに従う。
- **移行 0101 の補い**：ワークスペースの状態（`owner_id` NULL）で、まだ分類の既定の絵文字のまま（🟢 in_room・🏫 on_site・🚶 off_site・
  🏠 gone）のものに既定のアイコンを付ける。名前ではなく分類と絵文字で見る（名前を変えた既定・ほかの言語で作った既定も見つかり、
  管理者が絵文字を変えた・消した状態はそのまま）。個人の状態と色は変えない。

### 2.2 バッジの色（2026-10-07）

研究室の要望で、バッジは **テーマによらず塗りつぶし**（濃い色の背景に白い文字と白いアイコン）にした。それまでは text-emoji の
淡い背景に濃い色の文字で、ダークでは暗い背景に淡い文字だったが、遠目に状態を見分けにくかった。

色は **apps/shared/attendance-badge-colors.json**（状態の `color` の 8 つの鍵 → 1 つの濃い色。ライトとダークで同じ）。各端末は写しを
持ち、テストで JSON と突き合わせ、白との対比を数えて確かめる（Web：tests/attendance.test.tsx、iOS：`AttendanceIconsTests`、
Android：`AttendanceBadgeColorsTest`）：

| 鍵 | 背景 | 白との対比 |
| --- | --- | --- |
| `gray` | `#4B5563` | 7.56 |
| `red` | `#DC2626` | 4.83 |
| `orange` | `#C2410C` | 5.18 |
| `yellow` | `#A16207` | 4.92 |
| `green` | `#15803D` | 5.02 |
| `blue` | `#2563EB` | 5.17 |
| `purple` | `#7C3AED` | 5.70 |
| `pink` | `#BE185D` | 6.04 |

- どれも WCAG AA を満たす：名前（小さな文字）は 4.5 : 1 以上、アイコンは 3 : 1 以上（JSON の `min_text_contrast` /
  `min_icon_contrast`）。黄色と橙は明るい色では白が読めないので、琥珀・焦げ橙の濃さにした。
- 塗りつぶすところ：ボードの見出し、自分用の状態の行、プロフィール・メンバー一覧のチップ、編集のプレビュー、素早い切り替えのピル
  （Web のサイドバー・ホームの見出し、スマホのホームと「自分」）、そのメニュー・シートの行の色つきの四角、アイコンの選択の選んだ
  見本、色の見本。
- **自分の状態のボタン**：今の状態は塗りつぶしのバッジ（白い文字とアイコン、太字、読み上げは「選択中」）。ほかは枠線だけの白地
  （ダークは暗い地）で、**アイコンだけ状態の色**（ライトは上の濃い色、ダークは text-emoji のダークの文字色。濃い色は暗い背景では
  見えにくいため）。塗りと枠線の違いで今の状態がひと目で分かる。
- アイコンが無く絵文字で出す状態も、同じ塗りのバッジの上に絵文字を置く（絵文字は自分の色のまま）。
- 状態を切り替えても、名前の長さが同じならピルの幅も位置も変えない（iOS はアイコンを決まった幅の箱に入れ、切り替えはアニメーション
  なしで描き直す。§9.1）。

## 3. API（すべて `/api/v1`）

### 3.1 ボード（ゲストでない人）

- `GET /attendance` → `AttendanceBoardOut`：

  ```json
  {
    "enabled": true,
    "states": [ { "id", "owner_id": null, "label": "在室", "icon": "in_room", "emoji": "🟢", "color": "green", "kind": "in_room", "position": 0, "archived": false } ],
    "entries": [ { "user_id", "state_id", "since", "note", "source" } ],
    "can_personalize": true
  }
  ```

  `states` はワークスペースの状態（`owner_id` null）と全員の個人の状態。消した状態は、誰かが今使っているものだけ `archived: true` で
  入る（ボードの表示のため。ボタンには出さない）。`entries` は在室状況を持つ人だけ（持たない人は端末が「未設定」に出す）。
  `can_personalize` は自分が個人の状態を足せるか。オフのときは `enabled: false` で、ほかは空。
- `PUT /attendance/me {state_id, note?}` → `AttendanceEntryOut`。自分の状態を変える（ワークスペースの状態か自分の個人の状態。
  ほかは `422 attendance_state_invalid`）。`note` は 100 文字まで（省略 = 空）。状態もメモも今と同じなら何もしない（200、イベントなし）。
  人ごとに 1 分 30 回（`429`）。
- `GET /attendance/log?user_id=&before_id=&limit=50` → `{ items: [AttendanceLogOut], next_before_id }`。自分の記録は誰でも、
  ほかの人のは管理者だけ（`403 admin_required`）。`user_id` を省くと、管理者は全員分、ほかの人は自分の分。

### 3.2 個人の状態（`can_personalize` の人）

- `POST /attendance/my-states {label, icon?, emoji?, color?, kind}` → `AttendanceStateOut`（201）。1 人 10 個まで（`409 attendance_state_limit`）。
  許されていなければ `403 attendance_personal_not_allowed`。名前の重なりは `409 attendance_label_taken`。
- `PATCH /attendance/my-states/{id}`（送った項目だけ変わる。`icon: null`・`emoji: null` で外す）、`DELETE /attendance/my-states/{id}`（消すと `archived`。今その状態の人（本人）はそのまま）。
- 許されなくなった人の個人の状態は残る（表示は続く）が、新しく選べず、足せない。

### 3.3 管理（管理者）

- `GET /admin/attendance/settings` / `PATCH {enabled?, personal_rule?, personal_group_ids?, log_retention_days?}` →
  `AttendanceAdminSettingsOut`（設定 + ワークスペースの状態）。初めて有効にしたとき状態が無ければ §1 の 4 つを作る。
- `POST /admin/attendance/states {label, icon?, emoji?, color?, kind}`、`PATCH /admin/attendance/states/{id}`（個人の状態と同じ）、`DELETE /admin/attendance/states/{id}`（archived）、
  `PUT /admin/attendance/states/order {ids}`。ワークスペースの状態は 20 個まで。最後の 1 つは消せない（`409 attendance_last_state`）。
- `PUT /admin/attendance/users/{user_id} {state_id, note?}`：ほかの人の状態を変える（監査 `attendance.set_by_admin`、source `admin`）。
- 連携：`GET /admin/attendance/integrations`、`POST`（作成。受信を使うなら `inbound: true` で作るとトークンを 1 回だけ返す）、
  `PATCH /{id} {name?, url?, secret_name?, enabled?}`、`DELETE /{id}`、`POST /{id}/token`（トークンを作り直す。前のものはすぐ無効）、
  `DELETE /{id}/token`（受信をやめる）、`POST /{id}/test`（テスト送信。その場で送り、結果を返す。1 分 6 回）、
  `GET /{id}/deliveries`（最近の 50 件）。設定・状態・連携の変更はすべて監査に残す（秘密の値は残さない）。

## 4. イベントと bootstrap

| type | audience | seq | data |
| --- | --- | --- | --- |
| `attendance.updated` | all（ゲストを除く） | — | `{ user_id, state_id, since, note, source, log_id }`（`log_id` は Webhook の計画に使う。端末は無視する）。ある人の在室状況が変わった。端末は `user_id` の行を置き換える。`state_id` を知らなければ `GET /attendance` を読み直す |
| `attendance.config_updated` | all（ゲストを除く） | — | `{}`。設定（有効・無効、個人の状態の規則）か状態（ワークスペース・個人）が変わった。中身は人ごとに違う（`can_personalize`）ので載せない。端末は `GET /attendance` を読み直す（続けて届いたものは 300 ms でまとめる） |

- bootstrap の `attendance: AttendanceBoardOut | null`。ゲストと、オフのときは null。再接続のあとも bootstrap（か `GET /attendance`）で
  正しい値に戻る（イベントは取りこぼしうる）。
- ナビの鍵 `attendance`（apps/shared/nav-items.json、desktop と mobile）。端末は **有効なときだけ** 実装済みとして数える（オフなら出さない）。

## 5. 送信 Webhook

### 5.1 流れ（transactional outbox）

1. 状態が変わると、同じトランザクションで `attendance_current` の更新、`attendance_log` の追記、outbox の `attendance.updated` を書く。
2. outbox の relay のハンドラ（`AttendanceWebhookPlanner`）が、有効で送信先と鍵の名前がある連携ごとに `attendance_deliveries` の行を
   作る（`(outbox_event_id, integration_id)` が一意なので、relay がやり直しても 2 つにならない）。**変更が連携 X から来たときは X には
   作らない**（ループ防止）。本文はこの時点で作って保存する（名前は作った時点のもの）。
3. ワーカー（`attendance-webhooks` のループ）が期限の来た行を取り（`FOR UPDATE SKIP LOCKED`、次の試行の時刻を先に進めてコミット）、
   DB のトランザクションの外で送り、結果を書く。

- 送る前に取った行は 2 分のあいだ順番から外す（送っている途中でサーバが落ちたら 2 分後にやり直す。受け手は
  `delivery_id` で重複を捨てる）。
- 2xx：`delivered`。408・429・5xx・接続の失敗・タイムアウト：再送（30 秒、1 分、2 分、5 分、10 分、30 分、1 時間、2 時間。8 回で `failed`）。
  ほかの 4xx・3xx（リダイレクトは追わない）：すぐ `failed`。
- 同じ連携・同じ人について、もっと新しい配送が届いた後に古い配送の番が来たら、送らずに `superseded` にする（古い状態で上書きしない）。
- **オフにしたら送らない**（2026-10-07、レビュー v0.1.43 #3）：管理者が在室状況をオフにすると、同じトランザクションで送っていない配送
  （`pending`。初回待ち・再送待ちとも）を `cancelled`（`last_error = attendance_disabled`）にする。ワーカーも、行を取るときと
  **1 件ずつ送る直前**に全体の `enabled` を読み直し、オフなら送らずに `cancelled` にする（行を取った後にオフにされた分も止まる）。
  送っている途中でオフにされて失敗した配送も再送せず `cancelled` のまま。有効に戻しても取り消した分は送らない：オフのあいだも
  人は動いており、遅れて届く古い状態は外のサイトを誤らせるため（次の変更から送る）。テスト送信もオフのあいだは送らない。
- 送信の部品（署名・SSRF の検査・全体のタイムアウト・応答の上限）は操作ボタン（docs/ACTIONS.md）と共通の
  `app/modules/outbound/signed.py`（2026-10-07 に移した。振る舞いは変えていない）。
- 1 回の送信は 10 秒まで（`ATTENDANCE_WEBHOOK_TIMEOUT_SECONDS`）。この上限は DNS の確認・接続・送信・応答の **全体** にかかる
  （`asyncio.timeout`。httpx の timeout は読み 1 回ごとなので、1 バイトずつ遅れて届く応答では切れない。レビュー v0.1.43 #4）。
  超えたら `timeout` の失敗（再送の対象）として次の配送へ進む。応答は流して読み、2xx は本文を読まない。ほかは本文の先頭
  （800 バイトまで）だけ読み、先頭 200 文字を記録する。
- 配送の行は 30 日で消す。管理画面は連携ごとに最近の 50 件（時刻・人・状態・HTTP の番号・エラー・回数）を出す。

### 5.2 本文（`Content-Type: application/json`）

```json
{
  "event": "attendance.changed",
  "delivery_id": "0192f0c2-…",
  "workspace": { "id": "0192…", "name": "○○研究室" },
  "user": { "id": "0192…", "email": "taro@example.ac.jp", "username": "taro", "display_name": "山田 太郎" },
  "from": { "id": "…", "label": "学内", "kind": "on_site" },
  "to": { "id": "…", "label": "在室", "kind": "in_room" },
  "note": "",
  "at": "2026-10-07T09:15:00.123Z",
  "source": "app",
  "integration_id": null
}
```

- `from` は初めて設定したとき null。メモだけ変えたときは `from` と `to` が同じ。
- `source` は `app`（本人）/ `admin`（管理者）/ `integration`（受信 API。`integration_id` にその連携の id）/ `auto`（予約。今は使わない）。
- テスト送信は `"event": "attendance.test"`、`user` は押した管理者、`from` は null、`to` はその人の今の状態（無ければ最初の状態）。
- **送るのは突き合わせに要るものだけ**：外のサイトの名簿と人を対応させるのにメールアドレス（とユーザー名）が要るので入れる。
  ほかのプロフィール（電話・肩書・ステータス）は入れない（SECURITY.md §16）。

### 5.3 署名

- ヘッダ：`X-Taylis-Event`、`X-Taylis-Delivery`（= `delivery_id`）、`X-Taylis-Timestamp`（送った時刻の UNIX 秒）、
  `X-Taylis-Signature: sha256=<hex>`。`<hex>` = HMAC-SHA256（鍵、`timestamp + "." + 本文のバイト列`）の 16 進（小文字）。
- 再送では本文と `delivery_id` は同じで、時刻と署名は新しくする。
- 受け手は：(1) 時刻が今から 5 分以内か、(2) 署名が合うか（定数時間で比べる）、(3) `delivery_id` を見たことがないか（重複を捨てる）、
  (4) `at` が手元の値より新しいか（古い変更で上書きしない）を確かめる。
- 確かめるための例（テスト `test_attendance.py` が同じ値を確かめる）：
  鍵 `test-secret-0123456789`、時刻 `1760000000`、本文 `{"event":"attendance.test"}` →
  `sha256=b9a576549822b5bacf6f6676ed58759787609f141356628a2b14a37f582c255e`。

**鍵の置き場所**：秘密の値は DB に入れない（AI の API キーと同じ、SECURITY.md §7）。連携には **鍵のファイル名** `secret_name`
（英小文字・数字・`_` `-`、64 文字まで）だけを保存し、サーバは送るたびに `ATTENDANCE_WEBHOOK_SECRETS_DIR`（既定 `/run/secrets/attendance`、
compose は `infra/secrets/attendance/` を読み取り専用でマウント）の `<secret_name>` を読む（前後の空白を除いて 16 バイト以上）。
ファイルが無い・短いときは送らず、配送は `failed`（`secret_missing`）。DB にはこのリポジトリで暗号化して秘密を入れる仕組みが無く
（TOTP の鍵は平文、AI のキーはファイル）、バックアップに秘密を含めないためファイルにした。作り方は
`openssl rand -hex 32 > infra/secrets/attendance/<名前> && chmod 644 …`（コンテナのアプリ uid 10001 が読む。フォルダは 700 の `secrets/` の中）。

### 5.4 送信先の制限（SSRF）

リンクプレビュー・フィードと同じ検査（`link_previews.fetcher.validate_public_url`、SECURITY.md §14）：保存するときに形（https、資格情報なし、
`localhost`・`.local`・私的な IP の直書きは不可）を、送るたびに DNS の結果（すべて公開のアドレス）を確かめる。**https だけ**。
リダイレクトは追わない。開発のときだけ `ATTENDANCE_WEBHOOK_ALLOW_PRIVATE=true` で、私的なアドレス・`http`・`localhost` を許す
（`ENVIRONMENT=production` では効かない）。手元の受け手（127.0.0.1 の小さな HTTP サーバ）で試すため。

## 6. 受信 API（外のシステム → Taylis）

`POST /api/v1/integrations/attendance`、`Authorization: Bearer <連携のトークン>`（連携を作るときに 1 回だけ表示。DB には SHA-256 だけ）。

```json
{ "email": "taro@example.ac.jp", "state": "在室", "at": "2026-10-07T09:15:00Z", "note": "" }
```

- 人：`user_id`・`email`・`username` のどれか 1 つ（ゲスト・ボット・無効の人は `404 attendance_user_not_found`）。
- `state`：状態の id か名前（前後の空白を除き、大文字小文字を区別しない）。探す順は、ワークスペースの状態、その人の個人の状態
  （消したものは対象外）。見つからなければ `422 attendance_state_unknown`。**個人の状態は作らない**（打ち間違いでごみが増えるため。
  本人がアプリで足す）。
- `at`（省略可）：その変更が起きた時刻。未来は今にそろえ、24 時間より前は `422`。**最後に受け付けた変更**（`changed_at`）より古い変更は
  反映しない（`200 {applied: false, reason: "stale"}`。受け手と送り手が行き違ったときに古い値で上書きしない）。
  - 比べるのは `since` ではない（2026-10-07、レビュー v0.1.43 #8）：`since` は状態が変わったときしか動かないので、同じ状態のまま
    メモだけ変えた後に、それより古いメモの変更が遅れて届くと上書きしてしまっていた。`changed_at` は状態・メモどちらの変更でも、
    アプリ・管理者・受信 API のどの変更でも進む（アプリと管理者の変更は受け付けた時刻）。移行 0104 は、その人の記録の最後の
    `at`（`since` より前にはしない）で埋める。
  - 今と同じ状態・メモの再送（下の `unchanged`）は何も書かないが、その `at` が `changed_at` より新しければ `changed_at` だけ進める
    （その時刻にもその値だったので、それより前の変更が遅れて届いても戻さない）。古い再送は何も動かさない。
- `note`（省略可）：100 文字まで。省略すると空。
- 今と同じ状態・メモなら何もしない（`200 {applied: false, reason: "unchanged"}`）。これで、Taylis から送った変更を外のサイトが
  送り返してきても止まる（同じ連携へはそもそも送り返さない。§5.1）。
- 反映すると `200 {applied: true, user_id, state_id, since}`。source は `integration`、記録に連携の id。
- トークンは `tya_` で始まる。無効なトークン・無効にした連携・受信をやめた連携は `401 invalid_token`（無ければ
  `401 missing_token`）。24 時間より前の `at` は `422 attendance_change_too_old`。機能がオフなら `409 attendance_disabled`。
  連携ごとに 1 分 60 回（まとめて 30 回）。

## 7. 画面（Desktop / Web）

- **ナビの「在室状況」**（有効なときだけ）：
  - 上に自分のボタン（ワークスペースの状態、続けて自分の個人の状態。アイコンと名前）。押すとすぐ変わる（今の状態は色つきで押された見た目）。
    メモの欄（Enter で保存）。
  - ボード：kind の順（`in_room` → `on_site` → `off_site` → `gone` → 未設定）に状態ごとの見出し（状態のバッジ・人数）と、
    アバター・名前・メモ・「9:15 から」。見出しの上に「在室 n 人」。
  - 個人の状態の編集（`can_personalize` のとき）：名前・見た目のプレビュー・色（8 色の見本）・アイコン（§2.1 の 16 個と「なし」の
    見本。名前はツールチップと読み上げ）・絵文字（代わり）・分類、足す・直す・消す。管理のタブも同じ画面。
  - キーボード：ボタンは Tab で選び Enter / Space。ボードの人は Enter でプロフィールカード。
- **小さなチップ**：プロフィールカードとチャンネルのメンバー一覧の名前の横に、状態の小さなバッジ（アイコンと名前）。オフなら出さない。
- **管理 →「在室状況」タブ**：有効・無効、ワークスペースの状態（名前・絵文字・色・分類・並び・消す）、個人の状態の規則（誰も /
  全員 / 管理者 / グループ）、記録の保持日数、他人の状態を変える（ユーザーを選んで状態）、連携（作成・URL・鍵の名前・有効・トークンの
  作り直し・テスト送信・配送の記録）、最近の記録。
- 文言は ja / en / zh-Hans。

### 7.1 素早い切り替え（ピル、2026-10-07）

- **置き場所**：広い画面では、サイドバーの上のワークスペース名の行の右端（その行は名前の右が空いていることが多い）。スマホ幅の Web では
  ホームの見出しのワークスペース名のすぐ右と、「自分」タブの見出しの右。**有効でゲストでないときだけ**。
- **見た目**：今の状態のバッジの形の丸いピル（塗りつぶしの色に白いアイコンと名前（§2.2）、名前は 8 文字ほどで切る）。状態が無いときは点線の丸と「在室状況」の
  枠線だけのピル。
- **狭いとき**：折り返さず、ワークスペース名を押し出さない。行の幅で決める（`pillMode`）：名前を全部出してピル全体が入れば全体、
  入らなければアイコンだけ（ツールチップに「在室状況：学外」）。それでも入らなければ名前の後ろを削って（**最低 4 文字ぶん**は残す）
  アイコンを出し、それも無理ならピルを隠す（サイドバーを最小の 200 px にしたときなど。ナビの「在室状況」と ⌘⇧Y は使える）。
  4 文字にしたのは、研究室・会社の名前は頭の 4 文字で見分けられることが多く、最小幅でもアイコンが入るため。
- **メニュー**：押すと小さなポップオーバー。「在室状況を変える」の見出し、自分の状態（ワークスペースの状態、続けて自分用）を
  1 行ずつ（色つきの四角にアイコン、名前、自分用の印、今の状態にチェック）。押すとすぐ変わって閉じる（同じ状態ならメモは残し、別の
  状態ならメモは空）。下にメモの欄（Enter か「保存」で保存して閉じる。状態があるときだけ）、区切り、「在室状況を開く」。
- **キーボード**：Tab で選び Enter / Space（か ↓）で開く。開くと今の状態（無ければ先頭）にフォーカス。↑ / ↓ / Home / End で移り、
  Enter で選ぶ、Tab でメモへ、Esc で閉じる。**⌘⇧Y / Ctrl+Shift+Y** でどこからでも開く（Slack の「ステータスを設定」と同じキー。
  アプリ内のほかのショートカットと重ならない。ダイアログが開いている間は効かない）。ショートカット一覧（⌘/）にも載せる。

## 8. セキュリティのまとめ（SECURITY.md §16 にも）

- アプリからは本人だけが変える。管理者の変更は監査に残る。外からは連携のトークン（ハッシュで保存、作り直せる、連携ごとに止められる）。
- ゲストには見せない（在室は「いつ部屋にいるか」なので、外部の人に出さない）。
- Webhook はメールアドレスを含む（突き合わせに要る）。送信先は管理者が決めた https の公開の URL だけ。署名つき。
- 記録は保持日数で消える（既定 365 日）。アカウントを匿名化（管理者の操作・本人のアカウント削除）すると、その人の今の値・記録・個人の状態・Webhook の配送（本文にメールアドレスがある）を同じトランザクションで消す（`attendance.forget_in_tx`）。無効化だけならボードから外れるだけで行は残る。
- 外へ送る失敗は管理画面の配送の記録に出る（黙って捨てない）。

## 9. iOS / Android

- bootstrap の `attendance` を持ち、`attendance.updated` で行を置き換え、`attendance.config_updated` で `GET /attendance` を読み直す。
- ホームのタイル `attendance`（有効なときだけ）：自分のボタンとボード（§7 と同じ並び）。個人の状態の編集は後でもよい。
- プロフィールカードのチップ。
- 管理の画面はスマホには作らない（Desktop / Web で）。

**iOS（2026-10-07）**：

- ストアの `attendance` は bootstrap の値（`enabled: false` は null と同じに扱う）。`attendance.updated` は `user_id` の行を
  置き換え、知らない `state_id` なら `GET /attendance` を読み直す。`attendance.config_updated` は 300 ms でまとめて 1 回読み直す
  （オフになれば null）。読み直しが重なっても、先に始めた読みの答えで後の答えを上書きしない。ゲスト（とボット）は読まない。
- ホームのタイル「在室状況」（数字は「在室 n 人」、赤にしない）は有効なときだけ実装済みに数える：オフのときはタイルも
  「ホームのタイル」の設定の行も出ない。既定の並びでは最後。
- 画面（`AttendanceView`）：上に自分のボタン（ワークスペースの状態、続けて自分用。高さ 48 pt 以上、今の状態は色つきで
  VoiceOver の「選択中」）。押すとすぐ変わり、同じ状態を押せばメモは残り、別の状態ではメモは空になる（Web と同じ）。
  メモの欄（Return か「保存」、100 文字まで）。`can_personalize` なら「自分用の状態」（追加・編集・削除。名前・絵文字・色・分類）。
  ボードは §7 の並び（kind 順、同じ kind ではワークスペースの状態が先、空の状態は出さない、最後に「未設定」）で、見出しに
  状態のチップと人数、行にアバター・名前・メモ・「9:15 から」（前の日は「10/6 18:02 から」）。行を押すとプロフィールカード。
  右上に「在室 n 人」。引っ張って更新。
- チップ：プロフィールカード（メモと「から」も）とチャンネルのメンバー一覧の名前の横。色は text emoji の色（ライト / ダーク）。
- 規則は `UI/Attendance.swift`（Web の ui/attendance.ts と同じ）。テスト：`AttendanceTests`（並び・ボタン・イベント・オフ・ゲスト）。

**Android（2026-10-07 実装）**：

- データ：bootstrap の `attendance` を Store に持つ（保存しない。オフ・ゲストなら null）。`attendance.updated` でその人の行を置き換え、
  知らない状態の id なら `GET /attendance` を読み直す。`attendance.config_updated` は 300 ms でまとめて 1 回読み直す（読み直しが
  重なったら、後に始めた答えだけを使う）。オフになると Store から消え、タイルも消える。ゲストは読みに行かない。
- ホームのタイル「在室状況」（ナビの鍵 `attendance`）：有効でゲストでないときだけ実装済みに数える（タイルと、設定の「ホームの
  タイル」の行）。開くと `GET /attendance` を読む。
- 画面：上に「在室 n 人」、自分のボタン（ワークスペースの状態、続けて自分の状態。高さ 48 dp 以上、今の状態は色で塗り、
  TalkBack は「選択済み」と読む。押すとすぐ変わり、別の状態に変えるとメモは空になる）、メモの欄（完了キーか「保存」）、
  自分用の状態（`can_personalize` のとき。名前・絵文字・色・分類で追加・編集、削除は確認してから）、ボード（§7 と同じ並び。
  アバター・名前・メモ・「9:15 から」、押すとプロフィールカード）。タブレットなど広い画面では人を複数の列に並べる。
- チップ：プロフィールカード（状態のチップ・メモ・時刻）と、チャンネルの詳細のメンバー一覧の名前の横。
- 文言は ja / en / zh-Hans（`strings_attendance.xml`）。管理の画面は作らない。

### 9.1 アイコン・新しい既定の色・素早い切り替え（2026-10-07、iOS・Android とも実装済み）

Web（§2.1・§7.1）と同じ規則で作る：

- **アイコン**：`AttendanceStateOut.icon`（文字列、null 可）を読む。apps/shared/attendance-icons.json の写しを持ち（iOS は `sf`、Android は
  `material` を `Icons.Outlined.<name>` で。テストで JSON と突き合わせる）、知らない鍵・null は絵文字、それも無ければ名前だけ。
  バッジ（塗りつぶしの角丸に白いアイコンと名前、§2.2）をボタン・ボードの見出し・チップで使う。チップは小さなアイコンと名前。
- **自分用の状態の編集**：アイコンの選択（16 個と「なし」の格子。各見本に意味の名前を VoiceOver / TalkBack で）と色の 8 色の見本を
  足す。新しい状態のアイコンは選ぶまで分類の既定に従う。`icon` を作成・変更で送る（`null` で外す）。絵文字の欄は「代わり」として残す。
- **ピル**：
  - **ホーム**：見出しのワークスペース名のすぐ右に状態のチップ（アイコン・色・短い名前。無いときは枠線の「在室状況」）。名前が長く
    幅が足りないときはアイコンだけにし、名前は最低 4 文字残す（Web と同じ）。
  - **「自分」タブ**：一番上（見出しの右）に同じチップ。
  - 押すと **ボトムシート**：状態のボタン（高さ 48 pt / dp 以上、今の状態に印、読み上げは「選択中」）、メモの欄（状態があるとき）、
    「在室状況を開く」。状態を押すとすぐ変わってシートを閉じる（メモの規則は Web と同じ）。
  - 有効でゲストでないときだけ。オフになったら消える。
- 既定の色（学外 purple・帰宅 red）はサーバが作るので端末の変更は要らない。

**iOS（2026-10-07 実装）**：

- 写しは `UI/AttendanceIcons.swift`（鍵・SF Symbols・ja / en / zh-Hans の意味の名前・`defaults`）。`AttendanceIconsTests` が JSON と
  突き合わせ、どの SF Symbol もこの OS にあることも見る。知らない鍵・null は絵文字（カスタム絵文字は画像）、無ければ名前だけ。
  テキストだけの読み上げ（`stateText`）は、アイコンを描ける状態なら名前だけ。
- バッジ：ボタン（選んでいない状態はアイコンだけ状態の色、選んだ状態は全体を塗る）、ボードの見出し、「自分用の状態」の行、
  プロフィールカードとメンバー一覧のチップ。色は `AttendancePalette`（§2.2 の写し。`solid` と白の `onSolid`、ボタンのアイコンの `tint`）。
- アイコンは決まった幅の箱（`AttendanceIcons.boxWidth`、高さの 1.2 倍）に置く。SF Symbols は記号ごとに幅が違い、ホームの見出しの
  ピルが「在室 → 学内 → 学外 → 帰宅」の切り替えで 61.7〜68.3 pt と伸び縮みして揺れて見えた（2026-10-07）。ピルは切り替えを
  アニメーションしない（`.transaction { $0.animation = nil }`、名前は `.contentTransition(.identity)`）。テストで同じ長さの名前の
  状態どうしのピルの大きさが同じことを見る。
- 自分用の状態の編集：「見た目」（バッジの見本）、名前、「アイコン」（「なし」と 16 個の格子、各セルに意味の名前、VoiceOver も）、
  「色」（8 色の丸、選んだ色に印）、絵文字（「アイコンを表示できない古いアプリでの代わり」）、分類。新しい状態のアイコンは選ぶまで
  分類の既定に従う。
- ピル：ホームの見出し（`HomeHeaderTitle`、ワークスペース名のすぐ右。幅は測って `pillMode`：全体 → アイコンだけ（名前は最低 4 文字）
  → 出さない）と「自分」の見出しの右（設定がシートのときは左）。名前は 8 文字ほどで切る。読み上げは「在室状況：学外」。押すと
  ボトムシート（高さは中身に合わせる：開くときに一覧の高さを 1 回測り、`.height(測った高さ)` と large。medium では状態 4 つと
  メモで「在室状況を開く」が下に隠れていた（2026-10-07）。画面より高い（状態が多い、iPhone SE、大きな文字）ときは large で、
  中がスクロールする。iOS 17 は medium / large のまま）：状態の行（高さ 48 pt 以上、色つきの四角にアイコン、自分用の印、今の状態にチェックと「選択中」）、
  メモ（状態があるとき、Return か「保存」で保存して閉じる）、「在室状況を開く」（ホームのタブに画面だけを出す。iPad は詳細の列）。
  行を押すとすぐ変わって閉じる（失敗したらシートは開いたままでバナー）。有効でゲストでないときだけ、オフになればシートも閉じる。

**Android（2026-10-07 実装）**：

- 一覧の写しは `ui/AttendanceIcons.kt`（鍵・`material` の名前・`Icons.Outlined.*` を書き並べる。リフレクションを使わないので R8 でも消えない）。
  意味の名前は `strings_attendance.xml` の `attendance_icon_<鍵>`。`AttendanceIconsTest` が鍵の順・名前・ベクターの名前（`Outlined.<名前>`）・
  3 言語の名前・`defaults` を JSON と突き合わせる。
- バッジ（`StatePill`）：塗りつぶしの角丸に白いアイコンと名前（ボードの見出し・自分用の状態・チップ・編集のプレビュー。色は
  `AttendanceBadgeColors`、§2.2 の写し）。ボタンは押されていなくてもアイコンは状態の色（`attendanceTint`）。Material のアイコンは
  どれも同じ正方形の大きさなので、ピルは同じ長さの名前どうしで幅が変わらない（エミュレータで確かめた）。知らない鍵・null は絵文字（`SectionIcon`、カスタム絵文字も）、無ければ名前だけ。
- 編集：名前の下に見た目のプレビュー、色の 8 色の見本、アイコンの格子（「なし」と 16 個、各 48 dp、TalkBack は意味の名前と選択状態）、
  絵文字（「代わり」の説明つき）、分類。新しい状態のアイコンは選ぶまで分類の既定。
- チップ（`AttendanceQuickSwitch`）：ホームの見出しのワークスペース名の右（`WorkspaceTitle`。名前と幅を測り `AttendanceRules.chipMode`
  で全体 / アイコンだけ / 隠す。名前は最低 4 文字）と、「自分」タブの見出しの右端。名前は 8 文字で「…」。TalkBack は「在室状況：学外」。
  押すとボトムシート（行は 52 dp、ラジオの並びで今の状態にチェック、メモの欄、「在室状況を開く」はホームのタブに在室状況を開く）。

## 10. やらないこと（今は）

- 自動の切り替え（毎晩「帰宅」に戻す、Wi-Fi・位置での判定）。`source = auto` だけ予約しておく。
- 受信 API の HMAC 署名（トークンで足りる。外のサイトが送るたびに鍵を持つのはトークンと同じ）。
- 在室の通知（「〇〇さんが在室になりました」）。
