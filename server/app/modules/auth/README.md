# auth / users モジュール

users / auth の API、認証依存、admin から呼ぶセッション失効を実装済み。
以下は実装範囲と連携契約。M1 のクローズは admin・認証込みの通し確認後に行う。
仕様の正は [docs/SECURITY.md](../../../../docs/SECURITY.md) §2 と
[docs/DATA_MODEL.md](../../../../docs/DATA_MODEL.md) (`users` / `devices` / `sessions`)。

## 実装範囲

1. **users モジュール** (`app/modules/users/`): `schemas.py` (`UserPublic`, `UserMe` と変換関数)、
   `repository.py`、`service.py`、`router.py`。
   エンドポイント: `GET /users`、`GET /users/me`、`PATCH /users/me`、`GET /users/{user_id}`
   (`/users/me` を `/users/{user_id}` より先に定義する)。
2. **auth モジュール** (`app/modules/auth/`): `schemas.py`、`repository.py`、`service.py`、`deps.py` の本実装、`router.py`。
   エンドポイント:
   - `POST /auth/login` `{username, password, device: {platform, device_name?, app_version?}}` → トークン応答
     (`access_token`, `refresh_token`, `token_type`, `expires_in`, `session_id`, `device`, `user`)
   - `POST /auth/refresh` `{refresh_token}` → 同じ形
   - `POST /auth/logout` → 204
   - `GET /auth/sessions` (端末情報と `current` フラグ付き)、`DELETE /auth/sessions/{session_id}` → 204
   - `PUT /devices/current` `{device_name?, app_version?}` (プッシュ項目は M5)
   - `PUT /users/me/password` `{current_password, new_password}` → 204
3. `app/main.py` の `build_api_router()` に両ルータを登録する。
4. admin モジュール (`/admin/users*`) と CLI (`create-admin` / `create-user`) は実装済み。ユーザー作成は
   `app.modules.admin.service.create_user` にあるので、users モジュールから重複実装しない。

## 他モジュールが依存する契約 (名前を変えない)

| 場所 | 契約 |
| --- | --- |
| `app.modules.auth.deps` | `get_current_user`、`get_current_admin`、`CurrentUser`、`CurrentAdmin` |
| `app.modules.auth.service` | `revoke_all_sessions(db, user_id, reason, now) -> int` (admin の無効化・パスワードリセット・セッション失効から呼ぶ。対象セッションの端末も `enabled=false`。同一トランザクション内で更新し、commit は呼び出し元が行う) |
| `app.state.limiters` | ログイン用レートリミッタ。`core/ratelimit.RateLimiter` を `settings.login_rate_limit_per_ip` / `_per_account` で作り `create_app()` で載せる |

## 使える部品

- `app/core/security.py`: `hash_password`、`verify_password` (存在しないユーザーでもハッシュ比較して時間差を出さない)、
  `generate_refresh_token`、`hash_token` (sha256)、`create_access_token` / `decode_access_token` (JWT HS256)、
  `generate_temporary_password`
- `app/core/errors.py`: `unauthorized` / `forbidden` / `conflict` / `rate_limited` など
- `app/core/db.py`: `Db` 依存。サービスは最後に `await db.commit()`。読み取りだけなら commit 不要
- `app/core/settings.py`: `access_token_ttl_seconds`、`refresh_token_ttl_days`、`refresh_token_max_days`、
  `refresh_grace_seconds`、`login_rate_limit_per_ip`、`login_rate_limit_per_account`
- モデル: `users.models.User`、`auth.models.Device` / `UserSession` (`is_valid(now)`)

## 挙動の要点

- users の公開応答はメールアドレスと `must_change_password` を含まず、`UserMe` だけが返す。
  プロフィール更新は `display_name` / `email` が対象。省略した項目を保持し、`email: null` で解除する。
  無効化済みユーザーも一覧・取得で表示を残す。
- access token の検証は毎リクエスト: 署名と `exp` → `sid` の `sessions` 行を読み、`revoked_at IS NULL`、
  `expires_at > now`、`sub` と `user_id` の一致、`users.deactivated_at IS NULL` を確認。
- `must_change_password` が true のユーザーは `403 password_change_required`。例外は
  `GET /users/me`、`PUT /users/me/password`、`POST /auth/logout`、`/auth/sessions`。
- refresh: 提示トークンが現在値なら回転。`prev_token_hash` に一致し `rotated_at` から
  `refresh_grace_seconds` 以内なら再度回転して返す。それ以外の `prev` 一致は再利用とみなし、
  セッションを `reuse_detected` で失効 (**失効を commit してから** `401 session_revoked`)。
  回転時は `expires_at = min(now + ttl_days, created_at + max_days)`。
- login: IP とアカウントのレートリミット (超過は `429` + `Retry-After`)、`devices` 行を作成、`sessions` 行を作成。
- logout: セッション失効 + 端末 `enabled=false` (`disabled_reason='logout'`)。
- パスワード変更: 現在値を確認、`must_change_password=false`、現在以外のセッションを `password_changed` で失効。
- login / refresh / 失効 / パスワード変更は user → session の順に行ロックを取り、
  同時実行を直列化する。refresh はロック取得後に提示トークンを再照合する。
- エラーコード: `missing_token`、`invalid_token`、`token_expired`、`session_revoked`、`session_expired`、
  `invalid_credentials`、`password_change_required`、`admin_required`、`rate_limited`。

## 動作確認

1. 動作確認用のユーザーは CLI で作る:
   `uv run python -m app.cli create-admin --username <name>` (パスワードを対話入力) /
   `uv run python -m app.cli create-user --username <name>` (仮パスワードを表示)。
2. `uv run ruff check .`、`uv run ruff format --check .`、`uv run mypy`、`uv run pytest -q` を回す。
   `tests/test_auth_api.py` / `tests/test_users_api.py` は常時実行する。
3. API を変更したら `uv run python -m app.cli export-openapi` で仕様を再生成する。

## 受け入れ条件 (`tests/test_auth_api.py` に実装済み)

1. ログイン → `GET /users/me` が通る。
2. 誤ったパスワードと存在しないユーザーは同じ `401 invalid_credentials`。
3. 連続ログイン失敗で `429` と `Retry-After`。
4. refresh で回転し、猶予内の旧トークン再送は成功、猶予後の旧トークンは `401 session_revoked` になり
   セッション全体 (新トークン、access token) が無効になる。
5. logout 後の access token は `401`。
6. `must_change_password` の強制と、パスワード変更後の解除。
7. 無効化されたユーザーはログインできず、既存の access token も `401`。
