# SSO: Google でログイン (M48)

**状態 (2026-09-30)**: サーバ・Web・Desktop (Tauri の deep link)・iOS (ASWebAuthenticationSession)・Android
(Custom Tabs) まで実装済み。本物の Google を通した確認は、SSO を有効にしたサーバで行う (まだ)。実装で決めた細部 (既定のチャンネルの設定、レートリミットの枠、
仮パスワードの人の結び付け、アドレスの先取りの防止) は下の各節に書いた。

大学の Google Workspace のアカウントでログインできるようにする。サーバごとの設定で有効にし、許可したドメインの
アカウントだけを受け付ける。2026-09-30 に利用者と決めたこと:

- 新しく立てるサーバでは、大学のドメイン (Google Workspace) のアカウントだけがサインインできる。
- **案B**: そのドメインの人は、初めてのログインで一般メンバー (`member`) として自動で作られる。管理者はあとから
  止められる (無効化)。今のサーバ (研究室) は設定しなければ今までどおり (パスワードだけ)。
- パスワードでのログインは残す (管理者の緊急用、SSO を使わないサーバ)。

## 1. 方針

- OpenID Connect の認可コードフロー + PKCE。**Google とやり取りするのはサーバだけ** (client secret はサーバにだけ置く)。
  クライアント (Web / Desktop / iOS / Android) は、サーバの開始 URL をブラウザで開き、戻ってきた使い捨ての
  チケットを今までと同じトークン (access / refresh) に交換する。以後のセッション・失効・端末登録は今のまま。
- Google を埋め込み WebView で開かない (Google が拒否する。Tauri のウィンドウも埋め込み WebView)。
  iOS は `ASWebAuthenticationSession`、Android は Custom Tabs (または既定のブラウザ)、Desktop は既定のブラウザ、
  Web は同じタブで開く。
- アプリへの戻りはカスタム URL スキーム `chikuwachat://sso` (Web は同じオリジンのページ)。スキームは他のアプリにも
  登録できてしまうので、**チケットだけでは交換できない**: 開始時にアプリが作った秘密 (`verifier`) の
  SHA-256 (`challenge`) をサーバに渡し、交換のときに `verifier` を出させる (RFC 7636 と同じ考え方)。
- ログイン CSRF を防ぐため、開始から callback までを同じブラウザに縛る (開始時に Cookie を置き、callback で照合)。
- 後から Apple などを足せるよう、ユーザーと外部アカウントの対応は別の表 (`user_identities`) に置き、
  Google とのやり取りは `OIDCProvider` の実装 (`GoogleOIDC`) に閉じ込める (テストでは偽物に替える)。

## 2. 設定 (環境変数、サーバごと)

| 変数 | 意味 |
|---|---|
| `SSO_GOOGLE_CLIENT_ID` | Google Cloud の OAuth クライアント ID (種類は「ウェブ アプリケーション」) |
| `SSO_GOOGLE_CLIENT_SECRET_FILE` | client secret を置いたファイルのパス (秘密はリポジトリにも環境変数の一覧にも書かない。`SSO_GOOGLE_CLIENT_SECRET` も可) |
| `SSO_GOOGLE_ALLOWED_DOMAINS` | 受け付ける Workspace のドメイン (カンマ区切り、例 `example.ac.jp`)。**空なら SSO は無効** (誤ってすべての Google アカウントを受け付けないため) |
| `SSO_AUTO_PROVISION` | `true` で案B (初回ログインで作成)。既定 `false`: 管理者が作った (メールアドレスが一致する) 人だけ |
| `SSO_DEFAULT_CHANNELS` | **非推奨 (M90)**。案B で作った人が入る公開チャンネルの名前 (カンマ区切り、例 `general,お知らせ`)。無い名前・非公開・アーカイブ済みは飛ばす (ログに警告)。既定は空。管理者が「既定のチャンネル」(MEMBERSHIP.md §6) を一度も保存していない間だけ使い、保存した後 (空の一覧でも) は無視する。管理の「設定」タブにその間だけ値を出す |
| `SSO_RATE_LIMIT_PER_IP` | 開始・callback・交換の IP ごとの回数 / 分 (既定 30。1 回のログインで 3 回) |
| `PUBLIC_BASE_URL` | このサーバの公開 URL (例 `https://chat.example.ac.jp`)。callback の URL と Web への戻り先に使う |

3 つ (ID・secret・ドメイン) と `PUBLIC_BASE_URL` がそろったときだけ有効。どれかが欠けたら起動時にログへ理由を出し、
SSO は無効のまま起動する (パスワードは使える)。何も設定していないサーバはログにも何も出さない。

Docker Compose では client secret を `infra/secrets/google_client_secret` に置くと `/run/secrets/google_client_secret`
にマウントされる (`infra/.env` の `GOOGLE_CLIENT_SECRET_FILE`)。`SSO_GOOGLE_CLIENT_SECRET_FILE=/run/secrets/google_client_secret`
とする (infra/.env.example)。

アプリは開始 URL を `PUBLIC_BASE_URL` と同じホストで開くこと (callback は Google から `PUBLIC_BASE_URL` に戻り、
開始時の Cookie はそのホストにしか送られない。ホストが違うと `expired` になる)。

Google Cloud 側の準備 (管理者の作業):

1. Google Cloud でプロジェクトを作り、「OAuth 同意画面」を作る。大学の Workspace の管理者が許せば種類は **内部**
   (その組織のアカウントだけがログイン画面を通れる)。外部でもよい (サーバがドメインを確かめる)。
2. 「認証情報」→「OAuth クライアント ID」→ 種類「ウェブ アプリケーション」。承認済みのリダイレクト URI に
   `<PUBLIC_BASE_URL>/api/v1/auth/sso/google/callback` を 1 つだけ登録する。
3. クライアント ID と secret をサーバに置き、上の環境変数を設定して再起動する。

## 3. API

すべて `/api/v1` の下。認証は不要 (チケットと verifier が認証の代わり)。開始・callback・交換のレートリミットは
IP ごとに 30 回 / 分 (`SSO_RATE_LIMIT_PER_IP`。ログインと別の枠: 1 回のログインで 3 回数えるため)。
SSO が無効なら 3 つとも 404 `sso_disabled`。

### `GET /auth/methods`

ログイン画面が出すボタンを決める。`{"password": true, "google": {"enabled": true}}`。

### `GET /auth/sso/google/start?platform=<web|desktop|ios|android>&challenge=<base64url>`

- `challenge` = base64url(SHA-256(`verifier`))。`verifier` はクライアントが作る 32 バイト以上の乱数 (base64url 43〜128 文字)。
- サーバは `state`・`nonce`・PKCE の `code_verifier` を作り、`sso_requests` に保存 (有効 10 分、1 回だけ)。
- Cookie `chikuwa_sso=<state>` (HttpOnly、Secure (https のとき)、SameSite=Lax、Path=`/api/v1/auth/sso`、10 分) を置き、
  Google の認可 URL へ 302。`scope=openid email profile`、`hd=<許可ドメインが 1 つならそれ>` (画面の絞り込み。
  判定はサーバが ID トークンで行う)、`prompt=select_account`。
- SSO が無効なら 404 `sso_disabled`。

### `GET /auth/sso/google/callback?code&state` (Google から戻る)

1. `state` の行があり、期限内で未使用、かつ Cookie の値と一致すること。行は使用済みにする。
2. `code` を Google の token エンドポイントで交換 (PKCE の `code_verifier`、client secret)。
3. ID トークンを検証: 署名 (Google の JWKS)、`iss` (`https://accounts.google.com` か `accounts.google.com`)、
   `aud` = client ID、`exp`、`nonce`、`email_verified = true`、`hd` が許可ドメインのどれかで、メールアドレスの
   ドメインとも一致すること。
4. ユーザーを決める (§4)。
5. 使い捨てのチケット (32 バイト乱数。DB には SHA-256 だけ) を作る。有効 2 分・1 回だけ・`challenge` と
   `platform` とユーザーに紐づく。
6. 戻す: Web は `<PUBLIC_BASE_URL>/#sso_ticket=<ticket>`、ほかは `chikuwachat://sso?ticket=<ticket>` へ 302。
   フラグメントにするのは、チケットがサーバのアクセスログやリファラに残らないため。

失敗したら同じ戻り先に `sso_error=<code>` を付けて戻す。コードは `cancelled` (Google で取り消し、`error=access_denied`)、`expired`
(state が無い・期限切れ・使用済み・Cookie 不一致)、`domain_not_allowed`、`email_not_verified`、`not_registered`
(自動作成が無効で、一致する人がいない)、`account_disabled`、`provider_error` (Google との通信・検証の失敗、
`nonce` の不一致、`access_denied` 以外の Google のエラー)。
アプリはこれを日本語の文 (`apps/shared/errors.json`) で出す。

- `state` の行がまったく無いときは、どのアプリが始めたか分からないので Web の戻り先 (`#sso_error=expired`) に戻す。
- `state` の行は、見つかった時点で (以降の検査が失敗しても) 使用済みにして commit する。Google との通信はその後で、
  DB のロックを持たない。
- callback の応答は `chikuwa_sso` Cookie を消し、`Cache-Control: no-store`・`Referrer-Policy: no-referrer` を付ける。

### `POST /auth/sso/exchange`

`{"ticket": "...", "verifier": "...", "device": DeviceCreate}` → `TokenResponse` (`/auth/login` と同じ。Web は
refresh token を Cookie に移す)。チケットが無い・期限切れ・使用済み・`SHA-256(verifier)` が一致しない・
`platform` が違う → 401 `invalid_ticket`。1 回だけ使える (成功しても失敗しても使用済みにする)。
callback と交換のあいだに無効化された人は 401 `account_disabled`。`verifier` の形 (base64url 43〜128 文字) が
違えば 422。

## 4. ユーザーの決め方

1. `user_identities (provider='google', subject=<sub>)` があれば、その人。
2. 無ければ、メールアドレス (大文字小文字を区別しない) が一致するユーザーがいれば、その人に結び付ける
   (管理者が先に作った人、または以前パスワードで作られた人。M91 の Slack の取り込みが `--activate-domain` で作った
   有効なアカウントもここで結び付く: パスワード無し・`must_change_password = false` で、アドレスは
   `--email-domain-map` で許可ドメインに替えたもの)。
   - その人がまだ仮パスワードのまま (`must_change_password = true`、本人が一度もパスワードを決めていない) なら、
     仮パスワードを消して Google だけの人にする (`password_hash` NULL、`must_change_password = false`)。
     そうしないと、アプリは知らされていない仮パスワードの変更を求める画面を出してしまう。管理者は必要なら
     パスワードのリセットで改めてパスワードを渡せる。
3. それも無く `SSO_AUTO_PROVISION=true` なら作る (案B): 招待の受諾と同じ `create_user_in_tx` を使い、
   「既定のチャンネル」に入れる。M90 からは `create_user_in_tx` の中の 1 か所 (MEMBERSHIP.md §6) が管理者の一覧で決め、
   一覧が一度も保存されていなければ従来どおり `SSO_DEFAULT_CHANNELS` (非推奨) の公開チャンネル。M48 の時点では
   サーバに既定のチャンネルの仕組みが無かったので環境変数で決めていた。
   - ユーザー名: メールアドレスの @ の前を小文字にし、ユーザー名に使えない文字 (`USERNAME_PATTERN` の外) の並びを
     `-` に替え、前後の `-` を落としたもの (32 文字まで。3 文字に満たなければ `-user` を付ける)。
     ユーザー・グループの名前と重複するか `@here` などの予約語なら `-2`、`-3` … を付ける。
   - 表示名: ID トークンの `name` (80 文字まで)、無ければユーザー名。
   - ロール `member`、`must_change_password = false`、パスワードは無し (パスワードでのログインはできない)。
   - 同じ人の同時の初回ログインなどで一意制約にぶつかったら、1 回だけやり直す (それでもだめなら `provider_error`)。
4. それも無ければ `not_registered`。
5. 無効化された人 (と bot) は `account_disabled`。

2 要素認証 (TOTP) は SSO のログインでは求めない (Google 側の 2 段階認証に任せる)。作成・結び付け・ログインは
監査ログに残す (チケット・トークンは載せない): `admin.user_created` (`details.via = "sso"`、actor なし)、
`auth.sso_linked` (結び付け)、`auth.sso_login` (交換でセッションを作ったとき)。

`UserMe` に `has_password` (bool) を足す。false の人には、設定の「パスワードを変更」(と 2 要素認証) を出さない。
パスワードの無い人の `PUT /users/me/password` と `POST /auth/totp/setup` は `409 password_not_set`。

**アドレスの先取り (2026-09-30 の実装時に追加)**: 2 の結び付けはメールアドレスだけを頼りにするが、`PATCH /users/me`
では本人が確かめられていないアドレスを設定できる。メンバーが後輩の大学のアドレスを先に自分に設定しておくと、
その後輩が初めて Google でログインしたとき、そのメンバーのアカウントに入ってしまう (後輩の投稿がメンバーの
アカウントから出る)。そこで SSO が有効な間は、本人が許可ドメインのアドレスを新しく設定するのを
`403 email_domain_reserved` で拒む (今のアドレスのままの更新は通す)。許可ドメインのアドレスを付けられるのは
管理者 (作成時) だけ。既存のアカウントを後から Google に結び付ける画面 (ログイン中に「Google と連携」) は今は作らない。

匿名化 (管理者) では `user_identities` と未使用のチケットも消す。

## 5. データ

- `user_identities`: `id`、`user_id`、`provider`、`subject`、`email`、`created_at`、`last_login_at`。
  一意: (`provider`, `subject`)。
- `sso_requests`: `state` (主キー)、`nonce`、`code_verifier`、`challenge`、`platform`、`created_at`、`expires_at`、`used_at`。
- `sso_tickets`: `ticket_hash` (主キー)、`user_id`、`challenge`、`platform`、`created_at`、`expires_at`、`used_at`。
- 期限切れの `sso_requests` / `sso_tickets` は既存の定期掃除 (1 時間ごと) で消す (期限から 1 時間後)。
- マイグレーションは `0048_sso`。
- `users.password_hash` は SSO で作った人では NULL を許す (パスワードの照合は必ず失敗する)。

## 6. クライアント

共通: ログイン画面でサーバの URL を入れたあと (または選んだワークスペースで) `GET /auth/methods` を読み、
Google が有効なら「Google でログイン」を出す。`verifier` を作り、開始 URL を開き、戻ってきたチケットを
同じサーバで交換する。どのサーバで始めたかと `verifier` は、戻るまでメモリ (Web は sessionStorage) に持つ。

| 端末 | 開き方 | 戻り方 |
|---|---|---|
| Web | 同じタブで開始 URL へ | `/#sso_ticket=` を読んだらすぐフラグメントを消し (`history.replaceState`)、それから交換する。`#sso_error=` はログイン画面に日本語の文で出す。sessionStorage に `verifier` が無ければ (別のタブで始めた等) 交換せず `invalid_ticket` の文を出す |
| Desktop (Tauri) | 既定のブラウザ (tauri-plugin-opener)。ログイン画面は「ブラウザでログインを続けてください」と「キャンセル」に替わる | `chikuwachat://sso` を deep link で受ける (`tauri-plugin-deep-link`、スキームは tauri.conf.json でインストーラが macOS / Windows に登録。Windows は `tauri-plugin-single-instance` が 2 つめのプロセスの URL を動いているアプリに渡す)。受けたらウィンドウを前に出す。待っているログインが無いとき (起動した URL、キャンセルの後、2 度目) は無視する。`verifier` はメモリだけに持つ。refresh token はパスワードのログインと同じく資格情報ストア |
| iOS | `ASWebAuthenticationSession` (callbackURLScheme `chikuwachat`) | セッションの完了ハンドラ。トークンは今までどおり Keychain |
| Android | Custom Tabs (無ければ既定のブラウザ) | `chikuwachat://sso` の intent filter (singleTask) |

## 7. やらないこと (今は)

- Sign in with Apple。App Store の審査ガイドライン 4.8 は、Google などのログインを使うアプリにプライバシーに配慮した別のログインも求めるが、「既存の教育機関・企業のアカウントでのログインを必須とする教育・企業向けアプリ」は例外。大学のドメインに限るサーバはこれに当たる見込み (最終的な判断は Apple の審査、2026-09-30 時点の文面)。
- Google 以外の IdP、SAML、グループの同期、Google 側での無効化の自動反映 (無効化は管理者が ChikuwaChat で行う)。
