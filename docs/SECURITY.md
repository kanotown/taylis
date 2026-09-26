# SECURITY

認証・認可・添付ファイル・デプロイに関するセキュリティ設計。

## 1. 脅威モデルと前提

配置: Caddy (TLS) だけをインターネットに公開し、app / PostgreSQL / versitygw は Docker の内部ネットワークに置く。
PostgreSQL と versitygw のポートはホストに公開しない。本番では TLS 必須。

| 攻撃者 | 想定される行為 | 主な対策 |
| --- | --- | --- |
| 外部の未認証者 | 総当たりログイン、公開エンドポイントの悪用 | レートリミット、自由登録なし (管理者がユーザーを作成)、高エントロピートークン |
| 認証済みの悪意あるメンバー | 所属外チャンネル / DM の閲覧、他人のファイル取得、他人になりすました投稿・編集、ロールの詐称 | すべてのアクセスをサーバ側でメンバーシップ判定、送信者・ロール・時刻はクライアントから受け取らない |
| 端末 / トークンの盗難 | refresh token の再利用、放置端末からのアクセス | ローテーション + 再利用検知、セッション一覧と失効、短命 access token、端末ごとの資格情報の安全な保存 |
| 管理者アカウントの侵害 | ユーザー操作、パスワードリセットの悪用 | 監査ログ、管理者操作の記録 (完全な防御は範囲外) |

範囲外: サーバホスト自体の侵害、E2E 暗号化、DoS 耐性 (Caddy / ホスト側で対処)。

## 2. 認証

### 2.1 パスワード

- ハッシュは argon2id (`argon2-cffi` の既定パラメータ: m=64 MiB, t=3, p=4)。平文や可逆形式は保存しない。
- 長さは既定で 8〜128 文字 (`PASSWORD_MIN_LENGTH` で引き上げ可)。文字種の強制はしない。8 文字を許容できる
  根拠は、argon2id、ログインのレートリミット、管理者のみのアカウント作成 (自由登録なし) の組み合わせ。
- ログインのレートリミット: IP あたり 10 回 / 分、アカウントあたり 5 回 / 分 (超過は `429`)。
  失敗はユーザー名の存在有無に関わらず同じ応答 (`401 invalid_credentials`)。
- パスワード変更時は、現在のセッション以外を失効させる (`revoke_reason = password_changed`)。

### 2.2 access token (JWT)

- HS256。`SECRET_KEY` は 32 バイト以上のランダム値 (環境変数)。
- claims: `sub` (user_id)、`sid` (session_id)、`iat`、`exp` (発行から 15 分)。role は含めない。
- 検証: 署名と `exp` を確認した後、**`sid` のセッション行を 1 クエリで読み** `revoked_at IS NULL` と
  `expires_at > now()`、および user が無効化されていないことを確認する。これにより失効が即時に効く
  (数十人規模なら 1 クエリのコストは無視できる。必要なら 60 秒のメモリキャッシュを足す)。
- 送信は `Authorization: Bearer` ヘッダのみ。クエリパラメータや cookie では受け付けない。

### 2.3 refresh token とセッション

- 32 バイトのランダム値を base64url で返す。DB には `sha256` のみ保存 (`sessions.refresh_token_hash`)。
  高エントロピーなので slow hash は不要。
- 1 セッション = 1 端末 (`devices`) のログイン。端末の `platform` / `device_name` と共に
  `GET /auth/sessions` で一覧、`DELETE /auth/sessions/{id}` で失効できる (失効は即時)。
- 有効期限: 最終ローテーションから 30 日 (sliding)。作成から 180 日で絶対失効。
- **ローテーション**: `POST /auth/refresh` のたびに新トークンを発行し、旧トークンを `prev_token_hash` に移す。

```
refresh(token):
    s = sessions WHERE refresh_token_hash = sha256(token)
    if s and s.valid:
        rotate(s)                                   # 新トークン発行, prev = 現在, rotated_at = now
        return new tokens
    s = sessions WHERE prev_token_hash = sha256(token)
    if s and s.valid and now - s.rotated_at <= 30s:
        rotate(s)                                   # 直前の応答を取りこぼしたクライアントの再送。もう一度ローテーションして返す
        return new tokens
    if s:                                           # 旧トークンの再利用 = 盗難の疑い
        revoke(s, reason="reuse_detected")
        raise 401 session_revoked
    raise 401 invalid_token
```

再利用検知でセッションを失効させると、正規ユーザーと攻撃者の両方が締め出され、再ログインで
攻撃者だけが排除される。30 秒の猶予は「応答を受け取る前にネットワークが切れた」正規の再送のため。

- ログアウトはセッションを失効させ、紐付く端末を `enabled = false` にする (プッシュ停止)。
- 失効したセッションの WS 接続には `session.revoked` を送って切断する。
- クライアント側の保存場所: iOS は Keychain、Android は Android Keystore の鍵で暗号化した
  DataStore、Desktop は OS の資格情報ストア。平文ファイルに置かない。

### 2.4 WebSocket

- 接続後の最初のフレームで access token を送る (SYNC_PROTOCOL.md §5.1)。URL やヘッダに載せない
  (ログ・プロキシに残さない、WebView の制約)。5 秒以内に認証が無ければ切断。
- WS 接続はセッションに紐付き、access token の期限切れでは切らない。セッション失効で切る。
- Origin 検証は Web クライアント導入時に追加する (今は非ブラウザクライアントのみ)。

### 2.5 ユーザーの作成と初期管理者

- 自由登録のエンドポイントは無い。初期管理者は CLI (`uv run python -m app.cli create-admin`) で作成する。
- 以後のユーザーは管理者が `POST /admin/users` または CLI `create-user` で作成し、仮パスワードを
  本人に別経路で渡す。仮パスワードは応答に 1 回だけ含め、保存しない (ハッシュのみ)。
- 作成直後は `must_change_password = true`。この間、認証済み API は `GET /users/me`、
  `PUT /users/me/password`、`POST /auth/logout`、セッション一覧・失効 (`/auth/sessions`) のみ許可し、
  それ以外は読み取りも `403 password_change_required` で拒否する。login / refresh は利用可能。
  パスワード変更後に false になる。
- パスワードを忘れた場合は管理者が `POST /admin/users/{id}/reset-password` で仮パスワードを再発行する
  (全セッション失効、`must_change_password = true`)。メールによる自己リセットは作らない。
- 招待リンクによる自己登録は将来の選択肢として残すが、現時点では作らない。

### 2.6 端末とプッシュトークン

- 端末 (`devices`) はログイン時に作られ、セッションに紐付く。ログアウト / セッション失効で無効化する。
- APNs / FCM のトークンは秘密ではないが、他人のトークンを登録されても、通知はそのトークンの
  登録ユーザーの内容しか届かないため実害はない。無効なトークンは NULL に戻す。
- プッシュ本文にメッセージ内容を含めるかは `PUSH_INCLUDE_CONTENT` で切り替えられる。

## 3. 認可

### 3.1 ロール

- ワークスペース: `admin` / `member`。admin はユーザー管理・任意チャンネルのアーカイブ・
  任意メッセージの削除ができる。
- チャンネル: `owner` / `member`。owner は作成者。名前・トピック変更、メンバー除外、アーカイブができる。
- 複雑な RBAC は作らない。ロールは text 列で、後から値を追加できる。

### 3.2 操作と権限

| 操作 | public | private | dm / group_dm |
| --- | --- | --- | --- |
| 一覧・参加 | 誰でも | 招待されたメンバーのみ | 固定メンバー |
| メッセージ閲覧・検索・添付取得 | メンバー | メンバー | メンバー |
| 投稿・リアクション | メンバー (アーカイブ済みは不可) | 同左 | 同左 |
| 自分のメッセージ編集・削除 | 投稿者 | 投稿者 | 投稿者 |
| 他人のメッセージ削除 | admin | admin | admin |
| メンバー追加 | メンバー | メンバー | 不可 |
| メンバー除外 | owner / admin | owner / admin | 不可 |
| 名前・トピック変更 | owner / admin | owner / admin | 不可 |
| アーカイブ | owner / admin | owner / admin | 不可 |

実装規約: メッセージ・添付・既読・検索のあらゆるアクセスは `channels.require_member(user, channel_id)`
を通す。`sender_id` は必ず認証ユーザーから取り、リクエスト本文から受け取らない。ロール・権限・時刻も同様。
無効化ユーザーは認証できず、全セッションを失効させる。

## 4. 添付ファイル

### アップロード

- 認証必須。既定の上限 100 MB (`ATTACHMENT_MAX_BYTES`)。Caddy 側でも該当パスの本文サイズを制限する。
- `content_type` はクライアント申告を信用せず、先頭バイトから判定した値を保存する
  (`filetype` パッケージ。判定不能なら `application/octet-stream`)。
- ファイル名はパス区切りと制御文字を除去して保存する。ストレージキーは `attachments/{uuid}` で
  ファイル名を含めない。
- バケットは非公開。クライアントはオブジェクトストレージ (versitygw) に直接アクセスしない。
- 画像はサムネイル生成時に Pillow の `MAX_IMAGE_PIXELS` で decompression bomb を防ぎ、EXIF を除去する。

### ダウンロード

- `GET /attachments/{id}/content`: `status = attached` なら `channel_id` のメンバーのみ。
  `status = pending` ならアップローダーのみ。`deleted` は `404`。
- 応答ヘッダ: `Content-Disposition: attachment; filename*=UTF-8''...`、`X-Content-Type-Options: nosniff`、
  `Cache-Control: private, max-age=3600`。
- `?inline=1` は `image/png`、`image/jpeg`、`image/gif`、`image/webp` のみ許可。SVG / HTML / PDF は
  常に attachment (スクリプト実行の余地を残さない)。
- メッセージが削除されると添付は即座に `deleted` になりアクセス不能。バイト列は GC が削除する。

### 未対応 (認識しているギャップ)

- ウイルススキャン (必要になれば ClamAV を GC と同じ周期ジョブに足す)。
- ストレージのクォータ (ユーザー / ワークスペース単位)。

## 5. 入力検証と制限

すべての入力はサーバで Pydantic により検証する。

| 対象 | 制限 |
| --- | --- |
| メッセージ本文 | 20,000 文字。制御文字 (改行・タブ以外) は除去。メンショントークンの user_id は存在確認 |
| 添付 | 1 メッセージ 10 件、1 件 100 MB |
| チャンネル名 | 1〜80 文字。一意 (大文字小文字無視) |
| ユーザー名 | 3〜32 文字、`[a-z0-9._-]` |
| 検索クエリ | 200 文字 |
| ページング `limit` | 最大 200 |

レートリミット (in-memory token bucket、プロセスローカル):

| 対象 | 上限 |
| --- | --- |
| ログイン | IP 10 回 / 分、アカウント 5 回 / 分 |
| メッセージ投稿 | ユーザー 60 回 / 分 |
| 添付アップロード | ユーザー 20 回 / 分 |
| 検索 | ユーザー 30 回 / 分 |
| WS 接続 | ユーザー 10 接続同時、接続試行 30 回 / 分 |

本文サイズは Caddy で制限する (アップロード以外は 1 MB)。

## 6. トランスポートとデプロイ

- TLS は Caddy が終端し、自動で証明書を取得する。HSTS を有効化。
- app はプレーン HTTP で Caddy からのみ受ける。`X-Forwarded-For` は Caddy からの値のみ信用する。
- PostgreSQL / versitygw はホストにポートを公開しない。versitygw の WebUI と admin API は有効にしない
  (`--webui` / `--admin-port` を指定しない)。
- CORS は Desktop アプリの WebView オリジン (`tauri://localhost`、`http://tauri.localhost`) と Vite 開発サーバ
  (`http://localhost:1420`) だけを許可する (`CORS_ALLOW_ORIGINS`)。トークンは Authorization ヘッダで運ぶので
  credentials 付きの CORS は使わない。Web クライアント導入時はそのオリジンを追加する。
- Docker イメージはタグではなくダイジェストで固定する。

## 7. 秘密情報

- `SECRET_KEY`、DB パスワード、versitygw のルート認証情報 (`ROOT_ACCESS_KEY_ID` / `ROOT_SECRET_ACCESS_KEY`)、APNs の `.p8` 鍵、FCM サービスアカウント、Team ID /
  Key ID / Bundle ID は環境変数またはマウントしたファイル (`/run/secrets/...`) で渡す。
  リポジトリにはコミットしない (`.env.example` のみ。`.gitignore` で `.env` と `*.p8` を除外)。
- `SECRET_KEY` のローテーション: 変更すると access token が無効になるだけ (最大 15 分の影響)。
  refresh token はハッシュ保存なので影響しない。
- ログに出さないもの: パスワード (仮パスワード含む)、トークン (access / refresh / push)、メッセージ本文、
  添付の内容。`DEBUG=true` は SQL のバインドパラメータをログに出すため開発専用とし、本番環境では無視する。

## 8. ログと監査

- 全リクエストに `request_id`。認証済みなら `user_id` と `session_id` を構造化ログに付ける。
- ログイン失敗、refresh の再利用検知、権限エラー (`403`) は WARN で記録する。
- 管理者操作 (ユーザー作成、パスワードリセット、ロール変更、無効化、セッション失効、他人のメッセージ削除) は
  `audit_logs` に記録する (M10)。

## 9. データ保護

- バックアップ: `pg_dump` (毎日) とオブジェクトストレージのディレクトリのファイルコピー (`restic` / `rsync -aX`)。保存先の暗号化はホスト側の責務。
  復元手順を `infra/README.md` に書き、定期的に試す (ARCHITECTURE.md §8)。
- ユーザー削除: 無効化を基本とし、要求があれば表示名を匿名化し、そのユーザーのメッセージを
  トゥームストーン化するコマンドを用意する (M10)。
- 保持期間: DATA_MODEL.md §5。

## 10. 依存関係

- `uv.lock` で固定。CI で `uv run pip-audit` (または同等) を実行する。
- 流行っているという理由だけで依存を足さない。FastAPI / SQLAlchemy / cryptography 系は月次で更新する。

## 11. 将来の課題

| 項目 | 方針 |
| --- | --- |
| OIDC ログイン | `auth` に provider を追加。sessions の仕組みは共通 |
| TOTP 2FA | `users` に secret を追加し、login に第 2 段階を挟む |
| 招待リンクによる自己登録 | `invites` テーブルと `POST /auth/register`。管理者作成と併存可能 |
| Web クライアント | cookie (`HttpOnly`, `Secure`, `SameSite=Strict`) + CSRF トークン、CORS 許可リスト、WS の Origin 検証 |
| E2E 暗号化 | 範囲外 (検索・プッシュ本文・AI 機能と両立しない) |

## 14. リンクプレビューと SSRF (M11g)

メッセージ中の URL の Open Graph 情報はサーバが取りに行く (`GET /link-previews?url=`)。外部へ勝手に接続する
唯一の機能なので、次の制限を `app/modules/link_previews/fetcher.py` に集めている。

- スキームは http / https のみ。URL に認証情報 (`user:pass@`) があれば拒否。
- ホスト名は DNS 解決した **すべての** アドレスが公開アドレスであること (private / loopback / link-local /
  multicast / reserved、IPv4-mapped IPv6 を含む) を要求する。IP リテラルも同じ判定。`localhost` / `*.localhost` /
  `*.local` は解決せずに拒否。クラウドのメタデータ (169.254.169.254) もこれで弾く。
- リダイレクトは 3 回まで、**各ホップで同じ判定**をやり直す (公開ホストから内部へ飛ばす攻撃への対策)。
- タイムアウト 5 秒、本文は先頭 512 KB まで (`<head>` があれば十分)、Content-Type が HTML 以外は捨てる。
  HTML は標準ライブラリの `HTMLParser` で `<head>` だけ読む。
- 結果 (失敗も) は `link_previews` にキャッシュし (成功 7 日、失敗 1 日)、ユーザーごとに 1 分 60 回に制限する。
  拒否 (400 `url_not_allowed`) はキャッシュしない。
- 残る既知のリスク: DNS リバインディング (解決時と接続時で答えが変わる)。数十人の社内利用では受け入れ、
  必要なら解決した IP に直接接続して Host / SNI を付ける実装に置き換える。
- プレビュー画像はクライアントが直接読み込む (サーバは URL を返すだけ)。プロキシが必要になったら添付と同じ
  BlobStore に取り込む。

## 12. M1 レビュー用チェックリスト

2026-09-26 に M1 の実装に対して確認済み (pytest と compose 上の通し確認による)。

- [x] パスワードは argon2id で保存され、平文・可逆形式が残っていない (仮パスワードも同様)
- [x] refresh token は sha256 で保存され、ローテーション・30 秒猶予・再利用検知がテストされている
- [x] access token の検証がセッション行の失効を見ている
- [x] ログインのレートリミットが効く
- [x] 自由登録のエンドポイントが存在しない。`must_change_password` の強制がテストされている
- [x] `sender_id` / ロール / 時刻をリクエスト本文から受け取っていない
- [x] 非メンバーがチャンネルのメッセージを読めない・書けないことがテストされている
- [x] ログにトークン・パスワードが出ない
- [x] `.env` と秘密鍵がコミットされていない
- [x] PostgreSQL / versitygw のポートが compose でホストに公開されていない (本番設定)

## 13. M10 レビュー用チェックリスト

2026-09-26 に M1〜M10 の実装に対して確認済み (pytest 124 件と compose 上の通し確認、復元リハーサルによる)。

- [x] 添付: 申告 MIME を信用せず先頭バイトで判定する。ファイル名からパス区切りと制御文字を除去する。
      ストレージキーにファイル名を含めない。`inline` は画像のみ。`nosniff`。非メンバーは 403、削除後は 404
- [x] 添付: サイズ上限 (`ATTACHMENT_MAX_BYTES`) をアプリと Caddy の両方で制限する。サムネイル生成は
      ピクセル数上限付きで EXIF を持ち越さない。アップロードは 20 回 / 分
- [x] 検索: 権限フィルタ (`channel_members`) を必ず付ける。削除済みを返さない。クエリ 200 文字、30 回 / 分。
      構文エラーはエスケープして再試行し、500 にしない
- [x] 既読・スレッド・リアクション: すべて `require_member` を通る。編集は投稿者、削除は投稿者と admin
- [x] 監査: 管理操作 (作成・更新・パスワードリセット・セッション失効・匿名化)、パスワード変更、
      チャンネルのアーカイブが `audit_logs` に残る。秘密 (パスワード・トークン) と匿名化前の氏名は記録しない
- [x] 保持期間: 失効セッション、無効端末、処理済み outbox、push_deliveries、期限切れアップロードを周期削除する
- [x] 匿名化: 氏名・メール・資格情報を消し、全セッションを失効、端末のプッシュトークンを消す。履歴は残す
- [x] バックアップ: DB → オブジェクトストアの順で取り、チェックサムを付ける。復元手順と
      `verify-attachments` を書き、リハーサルで件数一致を確認した
- [x] `/readyz` がスキーマの適用状況 (alembic head) と outbox の滞留を返す。本番はポートを公開しない
- [ ] 未対応 (認識済み): ウイルススキャン、presigned URL、2FA / OIDC、監査ログの閲覧 UI (今は DB / psql)
