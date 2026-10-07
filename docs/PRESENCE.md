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

  | kind | 意味 | 既定の状態（有効にした管理者の言語で作る） | 色 |
  | --- | --- | --- | --- |
  | `in_room` | その部屋にいる（数える対象） | 在室 / In the room / 在室 | green |
  | `on_site` | 部屋にはいないが敷地内（学内・社内） | 学内 / On site / 校内 | blue |
  | `off_site` | 外出・外で仕事中 | 学外 / Off site / 校外 | orange |
  | `gone` | 今日は終わり・不在 | 帰宅 / Gone home / 已回家 | gray |

  既定の 4 つは、最初に有効にしたとき状態が 1 つも無ければ作る。そのあとの名前は管理者が自由に変えられる（翻訳は既定の作成のときだけ）。
- **見られる人**：ゲストでない有効なアカウント（ボットを除く）。ゲスト（MEMBERSHIP.md）には見せない（ボードの API は `403 guest_restricted`、
  イベントも届かず、bootstrap は null）。ゲストは自分の在室状況も持たない。ボードに載るのもゲストでない有効な人だけ。
- **変えられる人**：アプリからは本人だけ。管理者は他人のを変えられる（監査 `attendance.set_by_admin`）。外のシステムからは連携の
  トークン（§6）。
- **オフのとき**：データ（状態・今の値・記録・連携）は残すが、ボード・ボタン・Webhook・受信 API は止まる（受信は `409 attendance_disabled`）。
  もう一度有効にすると元の値で戻る。

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
  emoji       varchar(32),          -- Unicode の絵文字か :custom: の名前。無くてもよい
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
  status text,                          -- pending | delivered | failed | superseded
  attempts integer, next_attempt_at, last_status_code, last_error, delivered_at, created_at
);
```

人数は数十人なので、ボードは表を丸ごと読む（1 人 1 行）。

## 3. API（すべて `/api/v1`）

### 3.1 ボード（ゲストでない人）

- `GET /attendance` → `AttendanceBoardOut`：

  ```json
  {
    "enabled": true,
    "states": [ { "id", "owner_id": null, "label": "在室", "emoji": "🟢", "color": "green", "kind": "in_room", "position": 0, "archived": false } ],
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

- `POST /attendance/my-states {label, emoji?, color?, kind}` → `AttendanceStateOut`（201）。1 人 10 個まで（`409 attendance_state_limit`）。
  許されていなければ `403 attendance_personal_not_allowed`。名前の重なりは `409 attendance_label_taken`。
- `PATCH /attendance/my-states/{id}`、`DELETE /attendance/my-states/{id}`（消すと `archived`。今その状態の人（本人）はそのまま）。
- 許されなくなった人の個人の状態は残る（表示は続く）が、新しく選べず、足せない。

### 3.3 管理（管理者）

- `GET /admin/attendance/settings` / `PATCH {enabled?, personal_rule?, personal_group_ids?, log_retention_days?}` →
  `AttendanceAdminSettingsOut`（設定 + ワークスペースの状態）。初めて有効にしたとき状態が無ければ §1 の 4 つを作る。
- `POST /admin/attendance/states`、`PATCH /admin/attendance/states/{id}`、`DELETE /admin/attendance/states/{id}`（archived）、
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
- 1 回の送信は 10 秒まで。応答の本文は先頭 200 文字だけ記録する。
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
- `at`（省略可）：その変更が起きた時刻。未来は今にそろえ、24 時間より前は `422`。今の `since` より古い変更は反映しない
  （`200 {applied: false, reason: "stale"}`。受け手と送り手が行き違ったときに古い値で上書きしない）。
- `note`（省略可）：100 文字まで。省略すると空。
- 今と同じ状態・メモなら何もしない（`200 {applied: false, reason: "unchanged"}`）。これで、Taylis から送った変更を外のサイトが
  送り返してきても止まる（同じ連携へはそもそも送り返さない。§5.1）。
- 反映すると `200 {applied: true, user_id, state_id, since}`。source は `integration`、記録に連携の id。
- トークンは `tya_` で始まる。無効なトークン・無効にした連携・受信をやめた連携は `401 invalid_token`（無ければ
  `401 missing_token`）。24 時間より前の `at` は `422 attendance_change_too_old`。機能がオフなら `409 attendance_disabled`。
  連携ごとに 1 分 60 回（まとめて 30 回）。

## 7. 画面（Desktop / Web）

- **ナビの「在室状況」**（有効なときだけ）：
  - 上に自分のボタン（ワークスペースの状態、続けて自分の個人の状態）。押すとすぐ変わる（今の状態は押された見た目）。
    メモの欄（Enter で保存）。
  - ボード：kind の順（`in_room` → `on_site` → `off_site` → `gone` → 未設定）に状態ごとの見出し（絵文字・名前・人数）と、
    アバター・名前・メモ・「9:15 から」。見出しの上に「在室 n 人」。
  - 個人の状態の編集（`can_personalize` のとき）：名前・絵文字・色・分類、足す・直す・消す。
  - キーボード：ボタンは Tab で選び Enter / Space。ボードの人は Enter でプロフィールカード。
- **小さなチップ**：プロフィールカードとチャンネルのメンバー一覧の名前の横に、状態の絵文字と名前（色は控えめ）。オフなら出さない。
- **管理 →「在室状況」タブ**：有効・無効、ワークスペースの状態（名前・絵文字・色・分類・並び・消す）、個人の状態の規則（誰も /
  全員 / 管理者 / グループ）、記録の保持日数、他人の状態を変える（ユーザーを選んで状態）、連携（作成・URL・鍵の名前・有効・トークンの
  作り直し・テスト送信・配送の記録）、最近の記録。
- 文言は ja / en / zh-Hans。

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

## 10. やらないこと（今は）

- 自動の切り替え（毎晩「帰宅」に戻す、Wi-Fi・位置での判定）。`source = auto` だけ予約しておく。
- 受信 API の HMAC 署名（トークンで足りる。外のサイトが送るたびに鍵を持つのはトークンと同じ）。
- 在室の通知（「〇〇さんが在室になりました」）。
