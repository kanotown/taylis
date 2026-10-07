# 操作ボタン（actions、M143）

許された人がワンタップで外の装置やサービスを動かすボタン。押すと Taylis が **署名つきの HTTP リクエストを 1 回だけ** 管理者の決めた
中継（relay）に送り、中継の答え（「解錠しました」など）をその場で押した人に見せる。

研究室の要望（2026-10-07）から作る：メンバーが研究室の SwitchBot の鍵を開け閉めし、教授は自分の部屋の Sesame の鍵を開ける。
ただし Taylis は **汎用** のまま作る（ほかの研究室・会社も使う）：リポジトリに SwitchBot・Sesame・特定のサイトの名前や API は持たない。
SwitchBot / Sesame の API への翻訳は中継（研究室の Web サイト。別に作る）の仕事。既定は **オフ** で、管理者が有効にする。

**状態**：設計（本書）と、サーバ・Desktop / Web を実装（2026-10-07、移行 0106）。機器の状態の表示（§12）をサーバ・Desktop / Web に実装（2026-10-08、移行 0107。テスト：server `tests/test_action_status.py`）。iOS（§9.2）・Android（§9.3）を実装（2026-10-08）
（IMPLEMENTATION_PLAN.md の M143）。テスト：server `tests/test_actions.py`、desktop `tests/actions.test.tsx`、iOS `ActionsTests`・`ActionStatusTests`、Android `ActionsTest.kt`。
マイルストーンの番号 M143 は仮（並行する作業と重なれば振り直す）。

## 1. 問題

- 鍵の開け閉めは **押した 1 回が 1 回だけ、今** 起きなければならない。チャットのメッセージや在室状況の Webhook と違い、
  **遅れて届く・2 回届く** ことが危険になる（夜中に誰もいない部屋の鍵が、30 分前に押した「開ける」の再送で開く、など）。
- 押せる人を絞りたい（研究室の鍵はメンバー全員、教授の部屋の鍵は教授だけ。ゲスト・卒業生・ボットは押せない）。
- 誰がいつ押したか、成功したかを後から見たい。
- 鍵のサービスの API キーを Taylis に持たせたくない（中継が持つ）。Taylis が持つのは中継に送るときの署名の鍵だけで、それも DB に入れない。

## 2. 決めたこと（2026-10-07、利用者の決定。★ が選んだもの）

| # | 論点 | 選んだもの ★ | ほかの案と、選ばなかった理由 |
| --- | --- | --- | --- |
| D1 | Taylis と鍵のサービスの境界 | ★ 汎用の「署名つきの HTTP を中継に送る」ボタン。翻訳は中継 | SwitchBot / Sesame を直に呼ぶ：特定の製品の API・キーを Taylis に入れることになり、汎用でなくなる。製品ごとの保守も Taylis に来る |
| D2 | 誰が作るか | ★ 管理者（`integrations.manage`）。ワークスペースで 1 組（在室状況の連携と同じ） | 運営や本人が作る：外への送信先と鍵のファイル名を決める操作なので、連携と同じく管理者だけにする（ROLES.md §2） |
| D3 | 押したときの流れ | ★ **同期**：`POST /actions/{id}/invoke` の中で権限を確かめ、中継を 1 回呼び、答えを返す | outbox + ワーカー（在室状況の Webhook の形）：押した人は結果を待てず、サーバが落ちた後や中継が戻った後に **遅れて** 送られうる。鍵ではそれが危ない |
| D4 | 再送 | ★ **しない**。失敗・タイムアウトはそのまま押した人に返す（押し直すかは人が決める） | 自動の再送：遅れた「開ける」が後で効くと危ない。タイムアウトは「中継には届いて鍵は開いた」かもしれず、再送は 2 回目の操作になりうる |
| D5 | 二重送信の防止 | ★ 端末が `client_invoke_id` を送り、同じ人が同じ id で送り直したら **前の結果を返して中継は呼ばない** | サーバだけで「3 秒以内の同じ押下は 1 回」とする：通信の再試行（応答が途中で切れた）と、人の 2 回目の押下を区別できない |
| D6 | 連打 | ★ 人ごと・ボタンごとに 3 秒に 1 回（`ACTION_INVOKE_MIN_INTERVAL_SECONDS`、`429`） | 制限なし：誤って何度も押すと中継と鍵のサービスに同じ操作が並ぶ |
| D7 | 押せる人 | ★ ロール（member / manager / admin）・ユーザーグループ（名簿の `@students` `@faculty` などの管理グループも）・個別のユーザーの **どれかに当てはまる人**。ゲストとボットは **いつも押せない** | ロールだけ：教授の部屋の鍵（1 人だけ）を表せない。個別のユーザーだけ：学年が変わるたびに手で入れ替えることになる（グループなら名簿の同期で自動） |
| D8 | 確認 | ★ 押す前の確認のダイアログ（既定でオン、文言は変えられる） | 確認なし：誤タップで鍵が開く。オフにもできる（照明など害のない操作のため） |
| D9 | 中継への署名 | ★ 在室状況の Webhook と同じ形（`X-Taylis-Signature: sha256=HMAC(鍵, 時刻 + "." + 本文)`）。鍵は **ファイル**（`ACTION_SECRETS_DIR/<secret_name>`） | 鍵を DB に入れる：バックアップに秘密が混ざる（PRESENCE.md §5.3 と同じ理由）。署名なし：URL を知った人が鍵を開けられる |
| D10 | 送信先 | ★ https の公開の URL だけ（SSRF の検査、リダイレクトを追わない、全体で 10 秒） | 私的なアドレスも：サーバの中の網を叩けてしまう（SECURITY.md §14）。開発では `ACTION_ALLOW_PRIVATE=true`（本番では効かない） |
| D11 | 送信の部品 | ★ 在室状況の送信の部品を共通の `app/modules/outbound/signed.py` に移して両方で使う | 写して使う：SSRF・タイムアウト・応答の上限の直しが片方にしか入らなくなる |
| D12 | 中継の答え | ★ 2xx は成功、それ以外は失敗。JSON の `message`（文字列、200 文字まで、プレーンテキスト）があれば押した人に見せる | 中継の答えを見せない：「電池切れ」「すでに開いています」のような理由が人に届かない。HTML や長い本文は見せない（`message` だけ） |
| D13 | 記録 | ★ 押すたびに `action_invocations` に 1 行（誰・いつ・結果・HTTP の番号・時間・`message`）。監査ログにも `action.invoked`。保持は既定 365 日 | 監査ログだけ：管理画面で「最近押された記録」を出しにくい |
| D14 | 会話への通知 | ★ ボタンごとに任意（既定はオフ）：成功したら選んだチャンネルに「🔓 山田 太郎 が 研究室の鍵：開ける を実行」 | いつも投稿：多くの操作では要らない（照明など）。失敗は投稿しない（記録で見る） |
| D15 | 機能の切り替え | ★ ワークスペースの設定（`action_settings.enabled`、既定オフ）。オフのあいだは押せない（`409 actions_disabled`）、一覧は空 | 常にオン：使わないワークスペースに画面が増える |
| D16 | アイコン | ★ 在室状況のアイコンの一覧（apps/shared/attendance-icons.json）を使い、絵文字を代わりに（🔓 🔒 💡 など） | 新しいアイコンの一覧：鍵のアイコンが無いのは不便だが、一覧を増やすと 3 端末の写しとテストも増える。今は絵文字で足りる（§10） |
| D17 | 置き場所 | ★ 自分の画面「操作」（サイドバーのメニュー・ホームのタイル。apps/shared/nav-items.json の `actions`）。機能が有効で、押せるボタンが 1 つ以上ある人にだけ出す。在室状況の画面の上と在室状況のピルのメニューにも出すかはワークスペースの設定「在室状況のページにも表示する」（`show_on_attendance`、既定オフ） | 在室状況の中だけ：汎用の機能を研究室向けの 1 つの画面に縛ることになり、在室状況を使わないワークスペースでは置き場所が無い（利用者の決定 2026-10-07 で退けた） |

## 3. データ（移行 0106）

```sql
CREATE TABLE action_settings (            -- 1 行（無ければ既定値：オフ）
  singleton          boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled            boolean NOT NULL DEFAULT false,
  show_on_attendance boolean NOT NULL DEFAULT false, -- 在室状況の画面とピルにも出す（D17）
  log_retention_days integer NOT NULL DEFAULT 365,   -- 0 = 消さない
  updated_at, updated_by
);

CREATE TABLE actions (
  id                uuid PRIMARY KEY,
  name              varchar(40) NOT NULL,      -- ボタンの名前（「開ける」）
  group_label       varchar(40),               -- まとまりの名前（「研究室の鍵」）。同じ名前のボタンを 1 つの組に並べる
  icon              varchar(32),               -- apps/shared/attendance-icons.json の鍵。無くてもよい
  emoji             varchar(32),               -- 代わりの絵文字（🔓）
  action_key        varchar(100) NOT NULL,     -- 中継に送る鍵（`lab-door.unlock` など。英数字と . _ : -）
  url               text NOT NULL,             -- 中継の URL（https の公開の URL）
  secret_name       text NOT NULL,             -- 署名の鍵のファイル名（英小文字・数字・_ -、64 文字まで）
  confirm           boolean NOT NULL DEFAULT true,
  confirm_text      varchar(200),              -- 確認の文（NULL = 端末の既定の文）
  allowed_roles     text[] NOT NULL DEFAULT '{}',   -- admin / manager / member の部分集合
  allowed_group_ids uuid[] NOT NULL DEFAULT '{}',   -- ユーザーグループ
  allowed_user_ids  uuid[] NOT NULL DEFAULT '{}',   -- 個別のユーザー
  notice_channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,  -- 成功を知らせる会話（NULL = 知らせない）
  enabled           boolean NOT NULL DEFAULT true,
  provides_status   boolean NOT NULL DEFAULT false, -- 組の状態をこのボタンの中継に尋ねる（§12、移行 0107。組に 1 つ）
  position          integer NOT NULL,          -- 並び
  created_by, created_at, updated_at
);

CREATE TABLE action_invocations (          -- 押した 1 回（とテスト送信）
  id               uuid PRIMARY KEY,         -- = invoke_id（中継への X-Taylis-Delivery）
  action_id        uuid NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id),
  client_invoke_id uuid,                     -- 端末の冪等キー（テストは NULL）
  kind             text NOT NULL,            -- invoke | test
  status           text NOT NULL,            -- pending | succeeded | failed
  status_code      integer,                  -- 中継の HTTP の番号
  error            text,                     -- timeout | network | relay_error | url_not_allowed | secret_missing | interrupted
  message          varchar(200),             -- 中継の答えの message
  latency_ms       integer,
  created_at, finished_at,
  UNIQUE (user_id, client_invoke_id)
);
```

- ボタンは 50 個まで。人数は数十人なので、権限の判定は行を全部読んで端末ごとに絞る。
- 押せる人の配列にある、消したグループ・ユーザーの id は害がない（当てはまる人がいない）。管理の出力では、もう無いグループの id を外して返す。
  アカウントを匿名化すると、全ボタンの `allowed_user_ids` からその人を外す（`actions.forget_in_tx`）。記録の行は残る（名前は匿名化後のもの）。
- 記録は `log_retention_days` を過ぎたら消す（定期の整理。在室状況の記録と同じ）。ボタンを消すと、その記録も消える（監査ログには残る）。

## 4. 押したときの流れ（`POST /actions/{id}/invoke`）

1. 認証。機能がオフなら `409 actions_disabled`。ボタンが無ければ `404 action_not_found`、止めてあれば `409 action_disabled`、
   押せない人（ゲスト・ボット・当てはまらない人）は `403 action_not_allowed`。
2. **同じ `client_invoke_id` の行**（同じ人）があれば、中継を呼ばずにその結果を返す（`repeated: true`）。別のボタンの id なら
   `409 action_invoke_id_reused`。まだ `pending` なら、終わるまで（タイムアウト + 2 秒まで）待って返す。それより古い `pending`
   （送っている途中でサーバが落ちた）は `failed`（`interrupted`）にして返す。**再送はしない**。
3. 連打の制限（人ごと・ボタンごとに 3 秒に 1 回、`429 rate_limited` と `Retry-After`）。送り直し（2）は数えない。
4. `pending` の行を書いてコミット（同じ id の同時の 2 つ目は一意の制約で 2 に回る）。
5. **DB のトランザクションの外で** 中継に 1 回送る（§5）。DNS の確認・接続・送信・応答の読み取りの **全体** を 10 秒
   （`ACTION_TIMEOUT_SECONDS`）で切る。
6. 結果を行に書き、監査ログ `action.invoked`（`{action_id, name, ok, status_code, error}`）を同じトランザクションで書く。成功で
   `notice_channel_id` があれば、同じトランザクションでその会話に通知を投稿する（§6）。
7. 答え：

```json
{
  "invoke_id": "0192…", "action_id": "0192…",
  "ok": true, "status": "succeeded",       // succeeded | failed | pending
  "status_code": 200, "error": null,
  "message": "解錠しました",                  // 中継の message（無ければ null）
  "at": "2026-10-07T09:15:00Z", "repeated": false
}
```

中継が失敗を返しても HTTP は 200（`ok: false`）。押せなかった理由（権限・オフ・連打）は HTTP のエラー。

- **タイムアウトの意味**：`error: "timeout"` は「中継が 10 秒以内に答えなかった」で、**操作が起きなかったとは限らない**。端末は
  「機器（またはハブ）から応答がありませんでした。実行されたかどうかわかりません」と出す。自動ではやり直さない。

## 5. 中継へのリクエスト

`POST <url>`、`Content-Type: application/json; charset=utf-8`、`User-Agent: Taylis-Actions/1.0`。

```json
{
  "type": "action.invoked",
  "invoke_id": "0192f0c2-…",
  "action_id": "0192…",
  "action_key": "lab-door.unlock",
  "user": { "id": "0192…", "username": "taro", "email": "taro@example.ac.jp", "display_name": "山田 太郎", "role": "member" },
  "workspace": { "id": "0192…", "name": "○○研究室" },
  "at": "2026-10-07T09:15:00.123Z"
}
```

- 本文はキーを並べた詰めた JSON（在室状況と同じ `body_bytes`）。テスト送信は `"type": "action.test"`（中継は鍵を動かさずに 2xx を返す）。
- ヘッダ（在室状況の Webhook と同じ形。PRESENCE.md §5.3）：`X-Taylis-Event: action.invoked`、`X-Taylis-Delivery: <invoke_id>`、
  `X-Taylis-Timestamp: <UNIX 秒>`、`X-Taylis-Signature: sha256=<hex(HMAC-SHA256(鍵, timestamp + "." + 本文))>`。
- 中継が確かめること：(1) 時刻が今から **1 分** 以内（鍵の操作なので在室状況の 5 分より短く）、(2) 署名（定数時間で比べる）、
  (3) `invoke_id` を見たことがない（同じ id は 2 回動かさない）、(4) `action_key` と `user`（メールアドレスなど）で、その人がその操作を
  してよいか（中継の側でも絞れる）。
- 答え：2xx なら成功。本文が JSON の `{"message": "解錠しました"}` なら、その文を押した人に見せる。2xx 以外は失敗で、
  `{"message": "電池が切れています"}` があれば理由として見せる。`message` は文字列だけを取り、制御文字を除き空白を詰めて 200 文字で切る
  （プレーンテキストとして出す。HTML は解釈しない）。本文は 4 KB まで読む。リダイレクト（3xx）は追わず失敗。
- 鍵の置き場所：`ACTION_SECRETS_DIR`（既定 `/run/secrets/actions`、compose は `infra/secrets/actions/` を読み取り専用でマウント）の
  `<secret_name>`。前後の空白を除いて 16 バイト以上。無い・短いときは送らず `error: "secret_missing"`。作り方は
  `openssl rand -hex 32 > infra/secrets/actions/<名前> && chmod 644 …`。中継には同じ値を渡す。
- 確かめるための例：鍵 `test-secret-0123456789`、時刻 `1760000000`、本文 `{"type":"action.test"}` →
  `sha256=7e345874dae511795dddf6218ee0c2cdb320f1cb120c17b39c1e1ee1e97dff59`（テスト `test_actions.py` が同じ値を確かめる）。

## 6. 会話への通知（任意）

- ボタンに `notice_channel_id` があれば、**成功したときだけ**、その会話にシステムのボット「操作ボタン」（`system_bots` の `actions`。
  初めて要るときに作り、会話に入れる）が投稿する：「🔓 山田 太郎 が 研究室の鍵：開ける を実行」（絵文字はボタンの絵文字、無ければ 🔘。
  名前の部分はメンションにしない。ワークスペースの言葉（日本語）で書く。I18N.md の「共有の文は ja」）。
- 投稿に失敗しても（アーカイブした会話など）押した結果は変えない（ログに残す）。

## 7. API（すべて `/api/v1`）

### 7.1 使う人

- `GET /actions` → `ActionListOut { enabled, show_on_attendance, actions: [ActionOut] }`。自分が押せるボタンだけ（止めたボタン・押せないボタンは出ない）。
  `ActionOut = { id, name, group_label, icon, emoji, confirm, confirm_text, position }`（URL・`action_key`・鍵の名前・押せる人は出さない）。
  オフのとき・ゲスト・ボットは `{ enabled: false または true, actions: [] }`。
- `POST /actions/{id}/invoke { client_invoke_id }` → `ActionInvokeOut`（§4）。
- `GET /actions/status[?refresh=true]` → `ActionStatusListOut`（操作する機器の状態、§12.3）。`ActionOut` には `provides_status` もある。
- bootstrap の `actions: ActionListOut | null`（ゲストと、オフのときは null）。

### 7.2 管理（`integrations.manage`、管理者だけ）

- `GET /admin/actions/settings` / `PATCH {enabled?, show_on_attendance?, log_retention_days?}` → `ActionSettingsOut`。
- `GET /admin/actions` → `[ActionAdminOut]`（すべてのボタン。`ActionOut` に `action_key, url, secret_name, secret_present,
  allowed_roles, allowed_group_ids, allowed_user_ids, notice_channel_id, enabled, created_at, updated_at, last_invoked_at` を足す。
  `secret_present` は鍵のファイルがあり 16 バイト以上か。**鍵の中身は返さない**）。
- `POST /admin/actions`（201）、`PATCH /admin/actions/{id}`（送った項目だけ。`group_label`・`icon`・`emoji`・`confirm_text`・
  `notice_channel_id` は null で外す）、`DELETE /admin/actions/{id}`（204）、`PUT /admin/actions/order {ids}`。
- `POST /admin/actions/{id}/test` → `ActionInvokeOut`。`action.test` をその場で 1 回送る（記録に `kind: test`。1 分 6 回）。
  機能がオフでも、ボタンを止めていても送れる（有効にする前に中継との疎通を確かめるため。中継は `action.test` で鍵を動かさない）。
- `GET /admin/actions/{id}/invocations?limit=50` → `[ActionInvocationOut]`（新しい順。`user_id, kind, status, status_code, error,
  message, latency_ms, created_at, finished_at`）。
- 設定・ボタンの変更はすべて監査に残す（`action.settings_updated`・`action.created`・`action.updated`・`action.deleted`。鍵の中身は無い）。

### 7.3 エラー（apps/shared/errors.json）

`actions_disabled`（409）、`action_not_found`（404）、`action_disabled`（409）、`action_not_allowed`（403）、
`action_invoke_id_reused`（409）、`action_url_not_allowed`（400）、`action_limit`（409、50 個まで）、`rate_limited`（429）、
`action_status_source_taken`（409、組の状態のボタンは 1 つ、§12）。

## 8. イベント

| type | audience | seq | data |
| --- | --- | --- | --- |
| `actions.updated` | all（ゲストを除く） | — | `{}`。設定かボタンが変わった。押せるボタンは人ごとに違うので中身は載せない。端末は `GET /actions` を読み直す（続けて届いたものは 300 ms でまとめる） |
| `actions.status_updated` | 組のボタンを 1 つでも押せる人（audience `action`） | — | `ActionStatusOut`（§12.3）。押した数秒後の再読、または状態が変わったとき |

押した記録はイベントにしない（押した人は答えで知る。ほかの人には任意の会話の通知）。再接続のあとは bootstrap で正しい一覧に戻る。

## 9. 端末

### 9.1 Desktop / Web（2026-10-07 実装）

- **使う人**：
  - ナビの「操作」（サイドバーのメニュー、`nav-items.json` の `actions`。設定の「メニュー」で隠せる）。機能が有効で、押せるボタンが
    1 つ以上あるときだけ実装済みに数える（無ければメニューにも設定の行にも出ない）。画面は `group_label` ごとの組（見出しと、その組のボタンを
    横に並べる）、組の無いボタンは最後に。ボタンはアイコン（無ければ絵文字）と名前。
  - スマホ幅の Web ではホームのタイル「操作」からも開く。
  - `show_on_attendance` のとき、「在室状況」の画面の一番上に同じ組の「操作」の欄と、ヘッダのピル（在室状況の素早い切り替え、
    PRESENCE.md §7.1）のメニューに「操作」の欄（行は「組：名前」）。オフなら在室状況の画面には何も足さない。
  - 押す → 確認のダイアログ（`confirm` のとき。文は `confirm_text` か「研究室の鍵：開ける を実行しますか？」）→ ボタンにスピナー
    （その間は同じボタンを押せない）→ トーストで中継の `message`（無ければ「実行しました」）か、失敗の理由
    （中継の `message` があればそれ。無ければ HTTP の失敗は「実行できませんでした（HTTP 503）」、タイムアウトは「機器（またはハブ）から
    応答がありませんでした。実行されたかどうかわかりません。状態を確かめてください」、つながらない（DNS・接続の失敗）は
    「機器（またはハブ）に接続できませんでした」、`429` は「少し待ってからもう一度押してください」）。
  - `client_invoke_id` は押すごとに新しく作り、通信の失敗（サーバから答えが無い）のときだけ同じ id で 2 回までやり直す（サーバは前の結果を返し、中継は呼ばない）。
- **管理 →「操作ボタン」タブ**（`integrations.manage`）：有効・無効、記録の保持日数、ボタンの一覧（並べ替え・有効の切り替え・鍵のファイルが
  あるかの印）、作成・編集のフォーム（名前・組・アイコン・絵文字・中継の URL・`action_key`・鍵のファイル名・確認と文・押せる人
  （ロールのチェック、グループと人を選ぶ）・通知の会話）、テスト送信（結果を出す）、最近の記録（50 件）。
- 文言は ja / en / zh-Hans。

### 9.2 iOS（2026-10-08 実装）

- **同期**：bootstrap の `actions`（`Store.actions`。オフ・ゲスト・古いサーバは nil）。`actions.updated` は 300 ms でまとめて
  `GET /actions` を 1 回読み直す（`SyncEngine.loadActions`。ゲストとボットは読まない）。押したときに `actions_disabled`・
  `action_not_found`・`action_disabled`・`action_not_allowed` が返ったら、一覧が古いので読み直す。
- **ホームのタイル「操作」**（アイコン `bolt`、数は出さない、在室状況の後ろ）。`nav-items.json` の `actions` は両方の形
  （`desktop`・`mobile`）。機能が有効で押せるボタンが 1 つ以上あるときだけ実装済みに数え（`ActionRules.visible`）、
  自分 → 表示 →「ホームのタイル」にもそのときだけ行が出る。iPad のサイドバーのタイルも同じ。
- **画面**（`UI/Actions.swift` の `ActionsView`）：`group_label` ごとに List の Section（見出しが組の名前）、その中にボタンを
  横に並べる（幅に合わせて折り返す）。組の無いボタンは最後。ボタンはアイコン（在室状況の一覧の SF Symbol）か絵文字か ⚡ と名前。
  引っ張って読み直す。ボタンが無いときは「押せるボタンはありません」。
- **押す**：`confirm` のときアラート（題は「組：名前」、文は `confirm_text` か「研究室の鍵：開ける を実行しますか？」、
  「キャンセル」「実行」）→ ボタンにスピナー（その間は同じボタンを押せない）→ 成功は下のトースト（中継の `message`、無ければ
  「研究室の鍵：開ける を実行しました」）、失敗は赤いバナー（Desktop / Web と同じ文：中継の `message`、タイムアウトは
  「機器（またはハブ）から応答がありませんでした。実行されたかどうかわかりません。状態を確かめてください」、つながらないは
  「機器（またはハブ）に接続できませんでした。オフラインかもしれません」、`429` は「少し待ってからもう一度押してください」、
  権限・オフなどは apps/shared/errors.json の文）。
- **冪等**：`client_invoke_id` は押すごとに新しい UUID。サーバから答えが無い（`ApiError.network`）ときだけ同じ id で 2 回まで
  やり直す（1 秒・2 秒あけて。`ActionRules.invokeOnce`）。サーバの拒否・429・5xx はやり直さない。
- **在室状況**：`show_on_attendance` のとき、在室状況の画面の一番上に「操作」の組（同じボタン）と、ピルのシート（「在室状況を
  変える」）に「操作」の欄（行は「組：名前」）。シートの行は押して答えが返ったらシートを閉じ、トーストかバナーを見せる。
- **機器の状態（§12.4、2026-10-08）**：「操作」の画面と在室状況の画面の上（`show_on_attendance`）で、組の Section の先頭の行に
  色の点（ok 緑・warn 橙・alert 赤・neutral 灰）・太字の文、2 行目に `details`（「電池 85% · ドア 閉」）と「たった今確認」「3 分前に確認」
  （1 時間より前は「10:23 に確認」）、右に更新のボタン（`refresh=true`。回っている間は押せない。失敗（`429` の「少し待ってからもう一度
  押してください」など）は赤いバナーにも）。組の無いボタンは「名前：」を添えて 1 行ずつ。状態を持つ組（`provides_status`）で最初の答えまで
  「状態を確認中…」、中継の失敗は「状態を取得できませんでした：中継から応答がありませんでした」（中継の `message` があればそれ）。
  答えは `group_label`（組の無いボタンは `action_id`）で組に合わせる（`ActionRules.statusKey`：`g:<組>` / `a:<id>`。状態のボタンを
  自分が押せなくても見出しで合う）。画面が出ていてアプリが前面のあいだ、開いたときと 60 秒ごとに `GET /actions/status`
  （`ActionStatusFeed`。バックグラウンドで止め、戻ったら 1 分たっていればすぐ）、`actions.status_updated` で置き換え（`fetched_at` が
  手元より古ければ捨てる）、再接続の後は一度表示した状態を読み直す、機能がオフになったら消す。ピルのシートには出さない（狭い）。
- 管理の画面は作らない（管理者にも何も出さない。Desktop / Web で）。文言は ja / en / zh-Hans。

### 9.3 Android（2026-10-08 実装）

- ホームのタイル「操作」（`HomeTile.ACTIONS`、押せるボタンが 1 つ以上のときだけ。設定の
  「ホームのタイル」にも同じ条件で出る）→ 組ごとの見出しとボタン（アイコンは在室状況の一覧、無ければ絵文字、無ければ稲妻）。
  押す → `AlertDialog` の確認（`confirm` のとき、文は Desktop / Web と同じ）→ ボタンにスピナー（アプリのスコープで送るので画面を
  離れても答えは残る）→ スナックバーに中継の `message` か理由（文は Desktop / Web と同じ。押せなかった理由は共通のエラー表）。
  `show_on_attendance` のときは在室状況の画面の一番上と、ピルのシートの「操作」の欄（行は「組：名前」）にも。bootstrap の
  `actions` と `actions.updated`（300 ms でまとめて `GET /actions`）、ページを開いたときも読み直す。
  `ui/Actions.kt`（規則）・`ui/ActionsPane.kt`、テスト `ActionsTest.kt`（11）。

## 10. やらないこと（今は）

- 中継から Taylis へ状態を送る受信 API（push）：今は Taylis が尋ねる（§12、D18）。即時の通知（ドアが開いたら知らせる）が要るようになったら在室状況の受信 API の形で足す。
- 状態をもとにしたボタンの出し分け（施錠中なら「閉める」を隠す）：状態は数十秒古いことがあり、隠すと押せないときが生まれる。
- 予約と連動した自動の解錠、時間帯の制限（中継の側で絞れる）。
- 鍵・電球などのアイコン：今は絵文字。要望が増えたら attendance-icons.json とは別の一覧を作る。

## 11. セキュリティのまとめ（SECURITY.md §17 にも）

- 押せるかはサーバが毎回確かめる（ロール・グループ・個別のユーザー。ゲストとボットはいつも不可）。端末の出し分けは見た目だけ。
- 中継への要求は HMAC で署名し、`invoke_id` で重複を捨てられ、時刻で古い要求を捨てられる。鍵はファイルで、DB・API・監査・記録に出ない。
- 送信先は管理者が決めた https の公開の URL だけ。送るたびに DNS の結果を確かめ（§14 と同じ）、リダイレクトを追わず、全体で 10 秒、応答は 4 KB まで。
- 遅れた・重なった操作が起きないよう、再送しない・outbox を通さない・同じ `client_invoke_id` では中継を呼ばない・連打を制限する。
- 中継にはメールアドレスを含む本人の情報を送る（中継の側の名簿と突き合わせ、中継でも絞れるように）。送信先は信頼できるサイトだけにする。
- 中継の `message` はプレーンテキストとして 200 文字まで出す（HTML として描かない）。

## 12. 操作する機器の状態（2026-10-08、利用者の要望「状態はわかるようにしておきたい」）

研究室の SwitchBot の鍵（511・507）について、ボタンを押す人が **今の状態**（施錠・解錠、ドアの開閉、電池）を見られるようにする。
Taylis は汎用のまま：Taylis が知るのは「中継が返した短い文と色」だけで、鍵・ドア・電池の意味は中継が決める。

### 12.1 決めたこと（2026-10-08。★ が選んだもの）

| # | 論点 | 選んだもの ★ | ほかの案と、選ばなかった理由 |
| --- | --- | --- | --- |
| D18 | 状態の取り方 | ★ **Taylis が中継に尋ねる**（pull）。署名つきの `action.status` を送り、中継が今の状態を答える | 中継から Taylis に送る（push、在室状況の受信 API の形）：中継の側に「いつ送るか」（SwitchBot の Webhook の購読・ポーリング）が要り、受信の鍵・API が増える。研究室の Web サイトは押されたときに動くだけの作りで、常駐の監視を持たない。必要になったら受信 API を足せる（§10） |
| D19 | どのボタンが状態を持つか | ★ **組ごとに 1 つ**、管理者が選んだボタン（`provides_status`）の中継に尋ねる。組の無いボタンはそれだけで 1 組。2 つ目は `409 action_status_source_taken` | ボタンごと：「開ける」「閉める」は同じ鍵の状態で、2 回尋ねることになる。状態だけの別の欄（ボタンでない「機器」）：表と管理画面が増える。今は組の見出しの下に 1 行あれば足りる |
| D20 | 答えの形 | ★ `{status: {text（80 文字）, tone（ok / warn / alert / neutral）, state?（短い英小文字の語）, details?（6 個まで）}}`。Taylis は文と色をそのまま出す | 鍵の型（`locked: bool` など）を決める：鍵以外（照明・エアコン・プリンタ）に使えなくなり、製品の知識が Taylis に入る（D1 に反する）。`state` は端末やボットが機械的に使える短い語として任意で持つ |
| D21 | 中継を呼ぶ回数 | ★ サーバが **ボタンごとに 30 秒**（`ACTION_STATUS_CACHE_SECONDS`）覚え、その間は何人見ても中継を呼ばない。同じ時に来た読み取りは 1 回の問い合わせを待つ。「更新」（`refresh=true`）は覚えを使わず、人ごとに 5 秒に 1 回（`429`） | 端末が中継を直に呼ぶ：鍵（署名の秘密）を端末に配ることになる。覚えなし：見ている人 × 1 分ごとに中継と SwitchBot を呼び、SwitchBot の 1 日 10,000 回の上限に近づく。覚えはプロセスの中だけ（1 台の構成。複数台にしたら EventBus と同じく外に出す） |
| D22 | 押した後 | ★ 成功した押下の後、その組の覚えを消し、**4 秒後**（`ACTION_STATUS_AFTER_INVOKE_SECONDS`、錠の動きを待つ）にもう一度尋ね、`actions.status_updated` でその組を見られる人に送る | 押した答えに状態を含める：錠は答えの後で動くので古い状態になる。端末が押した後に読み直す：押した人の画面しか変わらない |
| D23 | 変わったことを知らせる | ★ 上の再読と、覚えの切れた読み取りで前と **違う** 成功の答えが来たときに `actions.status_updated`（outbox、audience `action` = その組のボタンを 1 つでも押せる人） | 毎回送る：変わらない状態で outbox が増える。失敗は送らない（見ている人は最後の成功の状態を保ち、自分の読み取りで失敗を知る） |
| D24 | 見られる人 | ★ 組のボタンを **1 つでも押せる人**（状態のボタン自体を押せなくてもよい。たとえば状態は管理者だけの「状態」ボタンから取り、メンバーは「開ける」だけ押せる） | 状態のボタンを押せる人だけ：見るだけの人のために押す権限を配ることになる。全員：押せない人には要らず、在室の推測にもなりうる |
| D25 | 記録 | ★ 状態の問い合わせは押下ではない：`action_invocations` にも監査にも残さない。失敗だけサーバのログに warning | 記録する：30 秒ごとの読み取りで記録が押下より多くなり、押した記録が見えにくくなる |

### 12.2 中継への問い合わせ

`POST <状態のボタンの url>`（押下と同じ送信の部品・署名・SSRF の検査・全体で 10 秒・応答 4 KB まで・再送なし）。

```json
{
  "type": "action.status",
  "request_id": "0192f0c2-…",
  "action_id": "0192…",
  "action_key": "lab-door-511.unlock",
  "user": { "id": "0192…", "username": "taro", "email": "taro@example.ac.jp", "display_name": "山田 太郎", "role": "member" },
  "workspace": { "id": "0192…", "name": "○○研究室" },
  "at": "2026-10-08T09:15:00.123Z"
}
```

- ヘッダ：`X-Taylis-Event: action.status`、`X-Taylis-Delivery: <request_id>`、`X-Taylis-Timestamp`、`X-Taylis-Signature`（§5 と同じ）。
- `user` は覚えの切れた読み取りをした人（押した後の再読は押した人）。中継はこれで絞ってもよいが、多くの人に同じ答えが配られる（D21）ので、人によって答えを変えないこと。
- 中継が確かめること：時刻（1 分以内）と署名。状態の問い合わせは **何も動かさない読み取り** なので、`request_id` の重複を捨てなくてよい。`action.status` で機器を動かしてはならない。
- 答え（2xx）：

```json
{ "status": { "text": "施錠中・ドア閉・電池 85%", "tone": "ok", "state": "locked",
              "details": [ { "label": "電池", "value": "85%" } ] } }
```

  `text` は必須（制御文字を除き空白を詰めて 80 文字まで）。`tone` は ok（あるべき状態）/ warn（注意：解錠中・ドアが開いている）/ alert（異常：
  動作不良）/ neutral（それ以外・不明）で、知らない値は neutral。`state` は英小文字・数字・`_` `-` の 32 文字までの語（`locked`・`unlocked`・
  `jammed`・`unknown` など。合わなければ捨てる）。`details` は `label`（40 文字）と `value`（80 文字）の組を 6 個まで。すべてプレーンテキスト。
- `text` の無い 2xx は `invalid_answer`。2xx 以外は失敗で、`{"message": "…"}` があれば理由として見せる（§5 と同じ 200 文字）。

### 12.3 API とイベント

- `GET /actions/status[?refresh=true]` → `ActionStatusListOut { enabled, statuses: [ActionStatusOut] }`。見られる組（D24）ごとに 1 つ、ボタンの並び順。
  `ActionStatusOut = { action_id（状態のボタン）, group_label, ok, status: {text, tone, state, details} | null, error, message, fetched_at }`。
  `error` は timeout / network / relay_error / invalid_answer / url_not_allowed / secret_missing。中継の失敗も HTTP は 200（`ok: false`）。
  機能がオフなら `{enabled: false, statuses: []}`、ゲスト・ボットは空。組ごとの問い合わせは並べて行う（それぞれ 10 秒まで）。
- `ActionOut.provides_status`（このボタンが組の状態を持つか）。端末は、状態を持つ組で最初の答えまで「状態を確認中…」を出すのに使う。
  状態のボタンが自分の押せないボタンのときは `ActionOut` に無いので、答えが来たら組の見出し（`group_label`、組の無いボタンは `action_id`）で合わせる。
- 管理：`ActionCreate` / `ActionUpdate` / `ActionAdminOut` の `provides_status`（組に 1 つ、`409 action_status_source_taken`）。
  `POST /admin/actions/{id}/status` →`ActionStatusOut`（「状態を確認」：そのボタンの中継にその場で尋ねる。覚えを使わず、状態のボタンでなくても・止めていても・
  機能がオフでも送れる。テスト送信と同じく 1 分 6 回）。ボタンや設定を変えると覚えを捨てる。
- イベント `actions.status_updated`（audience：組のボタンを 1 つでも押せる人、seq なし）：data は `ActionStatusOut`。端末は `fetched_at` が手元より古ければ捨てる。
  再接続の後は `GET /actions/status` を読み直す（イベントは状態の写しで、取りこぼしても次の読み取りで揃う）。
- 設定：`ACTION_STATUS_CACHE_SECONDS`（30）、`ACTION_STATUS_REFRESH_MIN_INTERVAL_SECONDS`（5）、`ACTION_STATUS_AFTER_INVOKE_SECONDS`（4）。

### 12.4 端末

- **Desktop / Web（2026-10-08 実装）**：「操作」の画面と（`show_on_attendance` のとき）在室状況の画面の上で、組の見出しの下に 1 行：色の点
  （ok 緑・warn 黄・alert 赤・neutral 灰）・文・`details`（「電池 85%」）・「たった今確認」「3 分前に確認」・更新のボタン（回っている間は押せない）。
  組の無いボタンは名前を添えて 1 行ずつ。最初の答えまで「状態を確認中…」、失敗は「状態を取得できませんでした：中継から応答がありませんでした」
  （中継の `message` があればそれ）。画面を開いたときに読み、見えている間は 60 秒ごと（隠れている間は止め、戻ったら古ければすぐ）、
  `actions.status_updated` で置き換える。ピルのメニューには出さない（狭い）。管理のフォームに「状態の取得に使う」、一覧に「状態」の印と「状態を確認」。
- **iOS（2026-10-08 実装）**：同じ規則（§9.2）。更新の失敗は赤いバナーにも出す。
- **Android（後の作業）**：同じ規則。

### 12.5 中継の例（研究室の SwitchBot の鍵）

研究室の Web サイトの中継（別のリポジトリ）は `action_key` から機器を引き、SwitchBot の `GET /v1.1/devices/{id}/status`（Smart Lock：
`lockState` locked / unlocked / jammed、`doorState` opened / closed、`battery`）を読んで、施錠かつドア閉 → ok「施錠中・ドア閉」、解錠 →
warn「解錠中」、ドアが開いている → warn、動作不良 → alert、電池 20% 未満で「電池残りわずか」を添える、のように訳す。7 秒で打ち切る。
