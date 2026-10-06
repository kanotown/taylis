"""AI bots are `bot_kind = "ai"` (docs/AI.md §2.1): the @-mention suggestions keep people and
AI bots only, so clients must tell them from the other bots."""

import importlib.util
import uuid
from collections.abc import Callable
from datetime import timedelta
from pathlib import Path
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.users.models import User
from tests.helpers import make_user

API = "/api/v1"
MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "versions" / "0093_ai_bot_kind.py"


def _backfill_sql() -> str:
    spec = importlib.util.spec_from_file_location("migration_0093", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return str(module.BACKFILL)


async def _create_agent(client: AsyncClient, username: str) -> dict[str, Any]:
    response = await client.post(
        f"{API}/admin/ai/agents",
        json={"username": username, "name": username, "character": "", "model": "claude-opus-5-5"},
    )
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


async def _users(client: AsyncClient) -> dict[str, dict[str, Any]]:
    return {u["username"]: u for u in (await client.get(f"{API}/sync/bootstrap")).json()["users"]}


async def test_new_ai_bots_are_kind_ai(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    admin = await make_user(db, "admin", role="admin")
    await make_user(db, "hook", role="bot")  # e.g. an incoming webhook's bot
    as_user(admin)
    agent = await _create_agent(client, "ai-chikuwa")
    users = await _users(client)
    assert users["ai-chikuwa"]["bot_kind"] == "ai" and users["ai-chikuwa"]["role"] == "bot"
    assert users["hook"]["bot_kind"] is None
    assert users["admin"]["bot_kind"] is None
    created = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "user.created")))
        .scalars()
        .all()
    )
    bot_id = str(agent["bot_user_id"])
    kinds = [e.payload["user"]["bot_kind"] for e in created if e.payload["user"]["id"] == bot_id]
    assert kinds == ["ai"]
    # Disabling keeps the kind (clients hide disabled bots by GET /ai/status).
    patched = await client.patch(f"{API}/admin/ai/agents/{agent['id']}", json={"enabled": False})
    assert patched.status_code == 200, patched.text
    assert (await _users(client))["ai-chikuwa"]["bot_kind"] == "ai"


async def test_backfill_marks_existing_ai_bots_and_moves_updated_at(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    admin = await make_user(db, "admin", role="admin")
    feed = await make_user(db, "rss", role="bot")
    feed.bot_kind = "feed"
    await db.commit()
    as_user(admin)
    agent = await _create_agent(client, "ai-old")
    bot_id = uuid.UUID(str(agent["bot_user_id"]))
    # As before the migration: no kind, an old updated_at.
    long_ago = utcnow() - timedelta(days=30)
    await db.execute(
        text("UPDATE users SET bot_kind = NULL, updated_at = :at WHERE id = :id"),
        {"at": long_ago, "id": bot_id},
    )
    await db.commit()

    await db.execute(text(_backfill_sql()))
    await db.commit()
    db.expire_all()
    bot = (await db.execute(select(User).where(User.id == bot_id))).scalar_one()
    assert bot.bot_kind == "ai" and bot.updated_at > long_ago
    others = {
        u.username: u.bot_kind
        for u in (await db.execute(select(User).where(User.id != bot_id))).scalars().all()
    }
    assert others == {"admin": None, "rss": "feed"}
    # Running it again changes nothing.
    marked = bot.updated_at
    await db.execute(text(_backfill_sql()))
    await db.commit()
    db.expire_all()
    again = (await db.execute(select(User).where(User.id == bot_id))).scalar_one()
    assert again.updated_at == marked
