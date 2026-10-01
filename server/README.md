# server

FastAPI による modular monolith。構成は [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) §5。

## 開発の流れ

```
# 1. DB とオブジェクトストレージを起動 (infra/.env が必要。infra/.env.example 参照)
docker compose -f ../infra/docker-compose.yml up -d db objectstore

# 2. 依存の取得 (uv が Python 3.13 を用意する)
uv sync

# 3. マイグレーション (DATABASE_URL は既定で localhost:5432 の chikuwa/chikuwa)
uv run alembic upgrade head

# 4. 開発サーバ (単一プロセス)
uv run uvicorn app.main:create_app --factory --reload

# 5. 検証 (マイルストーンごとに必ず実行)
uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -q -n auto
uv run python -m app.cli export-openapi     # openapi/openapi.json の再生成
```

テストは実 PostgreSQL に対して走る。`-n auto` (pytest-xdist) は CPU の数だけ並列に走らせ、ワーカーごとに別のデータベース (`chikuwa_test_gw0` …) を作って使う (M1 Max で約 150 秒 → 約 35 秒)。CI は 1 本ずつ (`-n` なし)。既定の接続先は `postgresql+asyncpg://chikuwa:chikuwa@localhost:5432/chikuwa_test`
(`TEST_DATABASE_URL` で変更可)。データベースが無ければ作成し、毎回 `downgrade base` → `upgrade head` で
マイグレーションも検証する。

ローカル実行の設定は `server/.env` (コミットされない) に書ける。`SECRET_KEY` が無い開発環境では起動ごとに
一時鍵を生成する (本番では起動を拒否する)。

## レイアウト

```
server/
  pyproject.toml         uv プロジェクト、ruff / mypy / pytest の設定
  alembic.ini
  Dockerfile             uv ベース。起動時に alembic upgrade head を実行 (RUN_MIGRATIONS=false で抑止)
  app/
    main.py              create_app() (composition root)。uvicorn は --factory で起動
    cli.py               create-admin, create-user, push-test, export-openapi
    core/                settings, db, base, ids (UUIDv7), security, errors, logging, ratelimit, time, health
    models_registry.py   全モジュールの models を集約 (Alembic 用)
    events/              envelope, bus (Protocol), in_memory (InMemoryEventBus), outbox (write_outbox, OutboxRelay, purge), models
    realtime/            protocol (フレーム), hub (接続レジストリと配信), router (/api/v1/ws)
    modules/
      users/             schemas, repository, service, router (一覧・プロフィール取得・更新)
      auth/              login, refresh, logout, sessions, devices, パスワード変更, 認証依存
      channels/          models, schemas, repository, service, router
      messages/          models, schemas, repository, service, router
      notifications/     preferences (service/router), planner (outbox handler), sender, providers (APNs/Log/Fake)
      admin/             schemas, service (ユーザー作成・ロール・無効化・リセット), router (/admin/users*)
      sync/              bootstrap (/sync/bootstrap), catalog (ws-events.json 用のイベント一覧)
  migrations/            Alembic (0001 基本テーブル / 0002 outbox_events / 0003 push: devices のトークン列、notification_preferences、push_deliveries)
  tests/                 conftest (テスト DB、マイグレーション、認証依存の差し替え、live uvicorn サーバ), サービス層 / API / WebSocket のテスト
    contract/            SYNC_PROTOCOL.md §13 の契約フィクスチャ (JSON)。contract_client.py が参照クライアント
```
