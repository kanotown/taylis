import asyncio
import os
import socket
import threading
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from pathlib import Path

import asyncpg
import pytest
import uvicorn
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings, build_settings
from app.main import create_app
from app.modules.auth.deps import get_current_user
from app.modules.users.models import User

SERVER_DIR = Path(__file__).resolve().parents[1]
TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+asyncpg://chikuwa:chikuwa@localhost:5432/chikuwa_test"
)
TABLES = [
    "attachments",
    "read_states",
    "reactions",
    "push_deliveries",
    "notification_preferences",
    "outbox_events",
    "messages",
    "channel_members",
    "channels",
    "sessions",
    "devices",
    "users",
]


def _run_in_thread(fn: Callable[[], None]) -> None:
    """Alembic's async env uses asyncio.run(); run it outside the test event loop."""
    errors: list[BaseException] = []

    def target() -> None:
        try:
            fn()
        except BaseException as exc:
            errors.append(exc)

    thread = threading.Thread(target=target)
    thread.start()
    thread.join()
    if errors:
        raise errors[0]


async def _ensure_database(url: str) -> None:
    parsed = make_url(url)
    conn = await asyncpg.connect(
        user=parsed.username,
        password=parsed.password,
        host=parsed.host,
        port=parsed.port or 5432,
        database="postgres",
    )
    try:
        exists = await conn.fetchval(
            "SELECT 1 FROM pg_database WHERE datname = $1", parsed.database
        )
        if not exists:
            await conn.execute(f'CREATE DATABASE "{parsed.database}"')
    finally:
        await conn.close()


@pytest.fixture(scope="session")
def test_settings() -> Settings:
    return build_settings(
        environment="test",
        debug=False,
        database_url=TEST_DATABASE_URL,
        secret_key="test-secret-key-" + "0" * 40,
        log_json=False,
        login_rate_limit_per_ip=100_000,
        login_rate_limit_per_account=100_000,
        upload_rate_limit_per_user=100_000,
        search_rate_limit_per_user=100_000,
        attachment_max_bytes=200_000,
    )


@pytest.fixture(scope="session")
def migrated_database() -> str:
    def prepare() -> None:
        asyncio.run(_ensure_database(TEST_DATABASE_URL))
        os.environ["DATABASE_URL"] = TEST_DATABASE_URL
        cfg = Config(str(SERVER_DIR / "alembic.ini"))
        cfg.set_main_option("script_location", str(SERVER_DIR / "migrations"))
        command.downgrade(cfg, "base")
        command.upgrade(cfg, "head")

    _run_in_thread(prepare)
    return TEST_DATABASE_URL


@pytest.fixture
async def app(test_settings: Settings, migrated_database: str) -> AsyncIterator[FastAPI]:
    application = create_app(test_settings)
    try:
        yield application
    finally:
        async with application.state.db.engine.begin() as conn:
            await conn.execute(text(f"TRUNCATE TABLE {', '.join(TABLES)} RESTART IDENTITY CASCADE"))
        await application.state.db.dispose()


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as c:
        yield c


@pytest.fixture
async def db(app: FastAPI) -> AsyncIterator[AsyncSession]:
    async with app.state.db.session_factory() as session:
        yield session


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    """Act as the given user by overriding the auth dependency."""

    def _apply(user: User) -> None:
        app.dependency_overrides[get_current_user] = lambda: user

    return _apply


@dataclass
class LiveServer:
    """A real uvicorn server (with background tasks) for WebSocket and contract tests."""

    app: FastAPI
    base_url: str
    ws_url: str


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture
async def live(test_settings: Settings, migrated_database: str) -> AsyncIterator[LiveServer]:
    settings = test_settings.model_copy(
        update={
            "run_background_tasks": True,
            "outbox_poll_interval_seconds": 0.2,
            "ws_heartbeat_interval_seconds": 1,
            "ws_auth_timeout_seconds": 0.5,
        }
    )
    application = create_app(settings)
    port = _free_port()
    config = uvicorn.Config(
        application, host="127.0.0.1", port=port, log_config=None, access_log=False, lifespan="on"
    )
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    for _ in range(500):
        if server.started:
            break
        await asyncio.sleep(0.02)
    else:
        raise RuntimeError("uvicorn did not start")
    try:
        yield LiveServer(
            app=application,
            base_url=f"http://127.0.0.1:{port}",
            ws_url=f"ws://127.0.0.1:{port}/api/v1/ws",
        )
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, timeout=15)
        async with application.state.db.engine.begin() as conn:
            await conn.execute(text(f"TRUNCATE TABLE {', '.join(TABLES)} RESTART IDENTITY CASCADE"))
        await application.state.db.dispose()
