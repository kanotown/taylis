# ROLES（ワークスペースのロールと権限、M142）

研究室のワークスペースを一緒に回す博士・修士の学生のために、管理者（`admin`）とメンバー（`member`）の間に
**「運営」（コード `manager`）** を置く（利用者の決定、2026-10-07）。運営は日々の運用（招待・名簿・チャンネル・絵文字・在室の
状態・予約枠・報告・テンプレート）ができ、セキュリティ・プライバシー・費用・設定に関わる操作は管理者だけに残す。

**状態**：設計（本書）と、サーバ・Desktop / Web を実装（2026-10-07、移行 0103）。iOS・Android は §8 の最小限（表示と、
知らないロールで落ちないこと）。マイルストーンの番号 M142 は仮（並行する作業と重なれば振り直す）。

## 1. ロール

| コード | 表示（ja / en / zh-Hans） | 意味 |
| --- | --- | --- |
| `admin` | 管理者 / Admin / 管理员 | すべての権限（§3 の表の全部） |
| `manager` | 運営 / Manager / 运营 | 日々の運用（§3 の「運営」の列） |
| `member` | メンバー / Member / 成员 | ふつうの利用者 |
| `guest` | ゲスト / Guest / 访客（M13e） | 参加させられたチャンネルの中だけ（SECURITY.md §3.1） |
| `bot` | BOT（M13a） | ログインしないアカウント |

- `users.role` は今までどおり text 列（`String(16)`）で、**CHECK 制約は無い**（SECURITY.md §3.1「ロールは text 列で、後から値を
  追加できる」）。値の検査は API の入力（`AdminUserCreate` / `AdminUserUpdate` / `InviteCreate` の `role`）で行う。
  運営を足すのに `users` のスキーマの変更は要らない。移行 0103 は監査ログに操作した人のロールの列を足すだけ（§6）。
- 「人」の集合（在室状況のボード、既定のチャンネルに入る人、ドキュメントの `workspace` の共有、名簿・分析の並びなど）は
  ゲストとボット以外、つまり **admin・manager・member**。コードでは `app/core/roles.py` の `PERSON_ROLES` を使い、
  `("admin", "member")` を書かない。
- 運営は**チャンネルの中の権限は member と同じ**（チャンネルの owner でなければ owner の権限は無い。§3.3）。
- 運営は自分のロールを変えられず、誰のロールも変えられない。運営にするのも外すのも管理者だけ（§3.1）。

## 2. 権限（capability）の表

ロールごとの権限は **1 か所の表**（`app/core/roles.py` の `ROLE_CAPABILITIES`）で決める。API は
`require_capability("…")`（FastAPI の依存）か、サービスの中の `has_capability(user, "…")` / `ensure_capability(user, "…")`
で確かめ、`role == "admin"` を散らばらせない。新しいロールを作るときは表に 1 行足す。`admin` は**常にすべての権限**
（表の定義の全部。権限を増やしたときに書き忘れても admin からは消えない）。

| 権限 | admin | manager | 内容 |
| --- | --- | --- | --- |
| `users.view` | ○ | ○ | 「管理 → ユーザー」の一覧（`GET /admin/users`）。運営にはメール・最終ログイン・最終利用・2 段階認証の有無を出さない（`users.view_private`） |
| `users.view_private` | ○ | — | 上の一覧のメールアドレス・最終ログイン・最終利用・2 段階認証の有無（個人の行動がわかる） |
| `users.edit_profile` | ○ | ○ | 他人の表示名・肩書き（`PATCH /admin/users/{id}` の `display_name` / `title`）。運営は member と guest のアカウントだけ（管理者・運営・ボット・自分は不可） |
| `users.manage` | ○ | — | アカウントの直接作成（仮パスワードの発行）、ロールの変更（運営にする・外すを含む）、ユーザー名の変更、無効化・再有効化、パスワードのリセット、セッションの失効、2 段階認証のリセット、削除（匿名化）、管理者・運営を招待するリンク |
| `invites.manage` | ○ | ○ | 招待リンクの作成・一覧・取り消し（`/admin/invites`）。運営が作れるのは member と guest の招待だけ（admin / manager の招待は `users.manage`） |
| `roster.manage` | ○ | ○ | 名簿の行（所属・職位・学年・指導教員・研究テーマ）の変更と削除（`PUT/DELETE /lab/roster/{id}`）。運営は自分の行と管理者の行は変えない（§4.2） |
| `lab.rollover` | ○ | — | 年度更新（`/lab/rollover*`）：ロールを変え（卒業生をゲストに）チャンネルから外すため |
| `channels.manage` | ○ | ○ | チャンネルの名前・トピック・説明・投稿制限・公開 → 非公開、アーカイブと戻す、メンバーの除外、オーナーの付け外し（owner と同じ操作）、times の持ち主の設定、既定のチャンネル（`PATCH /admin/workspace-settings` の `default_channel_ids`、`POST …/apply-default-channels`）。運営は公開チャンネルと、自分がメンバーの非公開チャンネルだけ |
| `channels.manage_any` | ○ | — | 上の操作を、自分がメンバーでない非公開チャンネルにも（今までの管理者のまま） |
| `channels.make_public` | ○ | — | 非公開 → 公開（さらにそのチャンネルのメンバーであること。L4） |
| `channels.moderate` | ○ | — | 会話の中身への owner と同等の権限を、owner でなくても：他人のメッセージ・システム行の削除、投稿制限のチャンネルへの投稿、他人の予定・タスク・キャンバス・投票・フィード・ワークフロー・定期投稿・会話のリンクの操作、確認の催促、通話の終了 |
| `emoji.manage` | ○ | ○ | カスタム絵文字のパックの作成・取り込み・変更・削除、他人が追加した絵文字の変更・削除 |
| `templates.manage` | ○ | ○ | ワークスペースの投稿テンプレート（M30）とキャンバスのテンプレート（M41）の作成・変更・削除 |
| `attendance.manage` | ○ | ○ | 在室状況の状態（作成・変更・並べ替え・削除）、他人の今の状態の設定、設定の閲覧（`GET /admin/attendance/settings`） |
| `attendance.configure` | ○ | — | 在室状況の設定の変更（有効・無効、自分用の状態の規則、記録の保持）、他人の記録（`GET /attendance/log?user_id=…` と全員分。いつどこにいたかがわかる）。連携は `integrations.manage` |
| `reservations.manage` | ○ | ○ | 予約枠の作成、すべての枠の設定・担当者・削除と操作（作った人と同じ。予約した人のメールアドレスも見える） |
| `reports.manage` | ○ | ○ | 「管理 → 報告」の一覧と「対応済み」「未対応に戻す」。運営には、自分が読めない会話（メンバーでない非公開チャンネル・DM）のメッセージの写しを出さない（§4.3） |
| `reports.read_private` | ○ | — | 報告の写しを、自分が読めない会話のものも見る（報告した人が管理者に見せることを選んだもの。§4.3） |
| `workspace.settings` | ○ | — | ワークスペースの設定（参加・退出の表示、参加前のプレビュー、アプリ内通話）、アイコン |
| `groups.manage` | ○ | — | ユーザーグループの作成・変更・削除（グループはドキュメントや予約枠の共有の相手になるので、自分を足して読めるようにならないように） |
| `integrations.manage` | ○ | — | 受信 Webhook、在室状況の連携（送信 Webhook・受信トークン・テスト・配送の記録）、フィードのボットの引き継ぎ |
| `ai.manage` | ○ | — | AI のボット・利用量・プロバイダ |
| `analytics.view` | ○ | — | 分析（人ごとの利用がわかる） |
| `docs.admin` | ○ | — | ドキュメントの管理（全ページの題名と共有の一覧、監査付きの引き取り、ゴミ箱からの完全削除） |

`guest` と `bot` と `member` は管理の権限を持たない（空）。知らないロール（将来の値・壊れた行）も空として扱う。

### 2.1 クライアントへの公開

`GET /users/me` と bootstrap の `me` に **`capabilities: string[]`**（自分の権限、昇順）を足す。クライアントは画面の出し分けを
ロールではなく権限で決める（Desktop / Web は M142 から。iOS・Android は当面ロールのままでよい。§8）。権限はサーバが決めるもので、
クライアントの出し分けは見た目のためだけ（すべての操作はサーバで確かめる）。古いサーバ（`capabilities` が無い）では、
Desktop は `role == "admin"` ならすべて、それ以外は無しとして扱う。

ロールが変わると `user.updated` が全員に届く。Desktop は自分の `user.updated` を受けたら `GET /users/me` を読み直し、
権限を入れ替える（管理画面のタブもすぐ変わる）。

## 3. 何ができるか（ロール別のまとめ）

### 3.1 運営ができること

- 招待リンク（member・guest、名簿の行と times の指定、チャンネルの指定は今までどおり公開か自分がメンバーの非公開だけ）。
- ユーザーの一覧（メール・最終ログインなどは出ない）と、member・guest の表示名・肩書きの変更。
- 名簿の行の変更・削除（自分と管理者の行を除く）。
- チャンネルの作成（今までどおり member と同じ）、公開チャンネルと自分がメンバーの非公開チャンネルの名前・トピック・
  投稿制限・アーカイブ・メンバーの除外・オーナーの付け外し・times の持ち主、既定のチャンネルの設定と「今いる人も全員入れる」。
- カスタム絵文字（パックを含む）、ワークスペースの投稿テンプレート、キャンバスのテンプレート。
- 在室状況の状態と、他人の今の状態の設定（記録には `source = admin` と操作した人が残る）。
- 予約枠の作成・設定・担当者・削除・操作。
- 報告の一覧と対応済み・未対応に戻す。

### 3.2 管理者だけができること

ロールの変更（運営の任命と解除を含む）、アカウントの直接作成・無効化・削除（匿名化）・パスワードと 2 段階認証のリセット・
セッションの失効・ユーザー名の変更、ワークスペースの設定（SSO / Google、ドメイン、参加前のプレビュー、通話、アイコン）、
AI のボットと利用量、連携（受信 Webhook・在室状況の連携・フィードのボット）、ユーザーグループ、年度更新、分析、
ドキュメントの管理（引き取り・完全削除）、在室状況の設定と他人の記録、会話の中身のモデレーション（`channels.moderate`）、
非公開 → 公開、メンバーでない非公開チャンネルの管理、データの取り込み（CLI）、監査ログ（今は API が無い。DB と CLI）。
通知：報告・退会の知らせ（モデレーションのボットの DM）と予約枠の担当者のいない知らせは今までどおり管理者だけに届く
（運営は「管理 → 報告」の一覧で見る）。

### 3.3 チャンネルの中

運営はチャンネルの中では member と同じ。owner でなければ、他人のメッセージを消す・投稿制限のチャンネルに投稿する・他人の
予定やタスクを変える、などはできない（`channels.moderate` は管理者だけ）。チャンネルの管理（§2 の `channels.manage`）で
自分を owner にすることはできる（監査に残る。§6）。

## 4. 運営が読めないもの（プライバシー）

運営は、メンバーでない非公開チャンネル・DM・共有されていないドキュメントを**読めない**（管理者と同じ。管理者の
読み取りの例外（ドキュメントの題名の一覧と引き取り、報告の写し）は運営には無い）。次の経路を確かめた。

### 4.1 チャンネル

- 運営の `channels.manage` は公開チャンネルと自分がメンバーの非公開チャンネルだけ。メンバーでない非公開チャンネルの
  管理の操作は、メンバーでない人と同じ `403 not_a_member`（`channels.manage_any` を持つ管理者は従来どおり）。
- 招待リンクに付けられる非公開チャンネルは、今までどおり発行する人がメンバーのものだけ。
- メッセージ・検索・添付・キャンバス・予定・タスクの読み取りは今までどおりメンバーシップだけで決まる（ロールを見ない）。

### 4.2 名簿とグループ

名簿の所属（教員・学生・卒業生）は管理されたグループ（`@faculty` など）を動かし、グループはドキュメントや予約枠の共有の
相手になる。運営が**自分の行**を変えて読めないページを読めるようにしないよう、運営は自分の行を変えられない
（`409 cannot_modify_self`）。管理者の行も変えない（`403 admin_required`）。グループそのものの編集は管理者だけ
（`groups.manage`）。他の人の所属を変えるとその人の見えるものが変わることは、運営の操作として監査に残る（§6）。

### 4.3 報告

報告の写し（`body_snapshot`）は、報告した人が管理者に見せることを選んだ本文（MODERATION.md §3）。運営には、
自分がいま読めない会話（メンバーでない非公開チャンネル・DM・グループ DM、ゲストでない運営なら公開チャンネルは読める）の
写しとチャンネル名を出さない（`reports.read_private` が無いとき）：`body_snapshot` は空、`channel_name` は null、`snapshot_hidden: true`（クライアントは「非公開の会話のため、本文は管理者だけが
見られます」と出す）。人の報告・その他の報告・ご意見（M119）は会話の中身ではないので運営にも出す。

### 4.4 ドキュメント・ユーザー

ドキュメントの管理（全ページの題名の一覧・引き取り・完全削除）は管理者だけ。ユーザーの一覧のメールアドレス・
最終ログイン・最終利用・2 段階認証の有無は管理者だけ（運営には `null` / `false`）。

## 5. API

- 新しいエンドポイントは無い。既存の管理 API の判定を権限の表に替える。運営に許す権限の操作に member・guest が来たら
  `403 manager_required`（「管理者または運営だけが行える操作です」）、管理者だけの権限に運営・member が来たら今までどおり
  `403 admin_required`。
- `PATCH /admin/users/{id}`：`display_name`（1〜80 字）と `title`（80 字まで、null で消す）を足す。`role` /
  `deactivated` / `username` を送るのは管理者だけ（運営は `403 admin_required`）。運営が管理者・運営・ボットの
  アカウントや自分を変えようとすると `403 admin_required`（自分は `409 cannot_modify_self`）。
- `PATCH /admin/workspace-settings`：運営は `default_channel_ids` だけを送れる（他の項目を送ると `403 admin_required`）。
  `GET` は運営も読める。
- ロールの値（`AdminUserCreate.role` / `AdminUserUpdate.role` / `InviteCreate.role`）に `manager` を足す。
  `UserPublic.role` / `AdminUserOut.role` / `InviteOut.role` は今までどおり文字列で、クライアントは知らない値でも落ちない
  （§8）。
- `UserMe.capabilities`（§2.1）、`AdminReportOut.snapshot_hidden`（§4.3）。
- 招待リンクで運営を作れる（管理者が作った `role = manager` の招待）。招待の受け入れ画面は「運営として」と出す。

## 6. 監査

- `audit_logs.actor_role`（移行 0103、`varchar(16)`、NULL 可）：記録した時点の操作した人のロール。`record_in_tx` が
  操作した人の行から自動で書く（actor の無い記録・CLI は NULL）。運営の操作は `actor_role = 'manager'` で見分けられる。
- 管理者だけだった操作で運営に開いたものは、すべて監査に残る。今まで記録の無かったものを足した：
  `channel.updated`（オーナーでない人が権限で名前・トピック・説明・投稿制限を変えたとき。変えた項目）、
  `channel.member_removed`（オーナーでない人の除外）、`emoji.updated` / `emoji.deleted`（他人の絵文字）、
  `template.created` / `template.updated` / `template.deleted`（ワークスペースの投稿テンプレート）、
  `canvas_template.created` / `canvas_template.updated` / `canvas_template.deleted`、
  `admin.user_updated` の `display_name` / `title`。
- ロールの変更は今までどおり `admin.user_updated`（`{"role": "manager"}`）。

## 7. 管理画面（Desktop / Web）

- 「設定 → 管理」（とサイドバーの管理）は、権限が 1 つでもあれば出す（運営にも出る）。タブは権限で出し分ける：
  ユーザー（`users.view`）、分析（`analytics.view`）、報告（`reports.manage`）、名簿（`roster.manage`。年度更新のボタンは
  `lab.rollover`）、グループ（`groups.manage`）、招待（`invites.manage`。ロールの選択肢は `users.manage` が無ければ
  member と guest だけ）、Webhook（`integrations.manage`）、ワークフロー（`channels.moderate`）、AI（`ai.manage`）、
  ワークスペース（`workspace.settings`）、チャンネル（既定のチャンネル。`channels.manage`）、絵文字（`emoji.manage`）、
  キャンバスのテンプレート（`templates.manage`）、ドキュメント（`docs.admin`）、在室状況（`attendance.manage`。設定の変更は
  `attendance.configure`、連携は `integrations.manage`）。同じページを使い、運営に使えない部分は出さない。
- ユーザーのタブ：ロールの選択肢に「運営」。ロール・無効化・パスワード・2 段階認証・セッション・削除・ユーザー名・直接の
  作成は `users.manage` のときだけ。運営には member・guest の行に「表示名・肩書きを変更」だけ出す。ロールのバッジと
  絞り込みに「運営」。
- チャンネルの「⋯」の名前の変更・アーカイブ・メンバーの除外・オーナーなどは、owner か `channels.manage`（非公開なら
  メンバーであること、または `channels.manage_any`）で出す。会話の中身の操作（他人のメッセージの削除など）は今までどおり
  owner か `channels.moderate`。
- ディレクトリ・プロフィール・分析のロールの表示に「運営」。
- 文言は ja「運営」、en「Manager」、zh-Hans「运营」。

## 8. iOS・Android（最小限）

- ロールは文字列で持っているので `manager` で落ちない（確認済み）。管理画面は無い（「管理」は Desktop / Web）。
- ロールを表示するところ（Android のディレクトリのバッジ、iOS・Android のプロフィール）に「運営」を出す。
- 画面の出し分けは当面ロールのまま：運営は member と同じ扱い（チャンネルの名前の変更・アーカイブなどのメニューは出ないが、
  サーバは許す。Desktop / Web で行う）。`capabilities` への移行は後で（BACKLOG）。

## 9. テスト

- `tests/test_roles.py`（90 件）：すべての管理の操作（79） × {admin, manager, member, guest} の許可・拒否の表（本書 §2 の表と同じ）を
  パラメータで確かめる。運営の操作の監査（`actor_role`）、ロールの変更は管理者だけ、運営が読めないもの（§4：非公開
  チャンネルの管理・報告の写し・ドキュメントの管理・ユーザーの個人情報）。
- Desktop vitest：権限による管理画面のタブと操作の出し分け。
