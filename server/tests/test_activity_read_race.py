"""REVIEW-v0.1.43 #10: the activity read position never moves back, even when two devices mark
read at once and the older position commits last (it is decided against the stored value)."""

import asyncio
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.activity import repository as repo
from app.modules.activity import service
from app.modules.users.models import User
from tests.helpers import make_user

API = "/api/v1"
Actor = Callable[[User], None]


async def _setup(client: AsyncClient, db: AsyncSession, as_user: Actor) -> tuple[User, datetime]:
    """Alice with a read position an hour back and one mention from Bob; the mention's time."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await db.execute(update(User).values(activity_read_at=utcnow() - timedelta(hours=1)))
    await db.commit()
    as_user(alice)
    general = (await client.post(f"{API}/channels", json={"name": "general"})).json()
    as_user(bob)
    await client.post(f"{API}/channels/{general['id']}/join")
    payload = {"client_msg_id": str(uuid.uuid4()), "body": f"<@{alice.id}> look"}
    sent = await client.post(f"{API}/channels/{general['id']}/messages", json=payload)
    assert sent.status_code == 201, sent.text
    as_user(alice)
    return alice, datetime.fromisoformat(sent.json()["created_at"])


async def _stored(db: AsyncSession, user: User) -> datetime:
    """The stored position (and the test's user object follows it, for the API calls)."""
    await db.refresh(user)
    return user.activity_read_at


async def test_a_stale_older_mark_read_does_not_move_the_position_back(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice, mentioned = await _setup(client, db, as_user)
    factory = app.state.db.session_factory
    # Two devices' requests read the same old user row.
    async with factory() as one, factory() as two:
        first = await one.get(User, alice.id)
        second = await two.get(User, alice.id)
        assert first is not None and second is not None
        newer = utcnow()
        older = mentioned - timedelta(seconds=1)
        out = await service.mark_read(one, first, newer)
        assert out.unread_count == 0 and out.read_at == newer
        # The second still holds the old position in memory and commits last.
        out = await service.mark_read(two, second, older)
        assert out.read_at == newer and out.unread_count == 0
        assert second.activity_read_at == newer
    assert await _stored(db, alice) == newer
    assert (await client.get(f"{API}/activity/summary")).json()["unread_count"] == 0
    # Only the move forward was announced to my devices, with the stored position.
    events = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "activity.read")))
        .scalars()
        .all()
    )
    assert [datetime.fromisoformat(e.payload["read_at"]) for e in events] == [newer]


async def test_concurrent_mark_read_waits_for_the_row_and_keeps_the_newest(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Actor,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The newer request has updated the row but not committed; the older one's UPDATE waits on
    the row lock, then re-checks against the committed value and changes nothing."""
    alice, mentioned = await _setup(client, db, as_user)
    factory = app.state.db.session_factory
    updated = asyncio.Event()
    release = asyncio.Event()
    real_purge = repo.purge_opened
    calls = 0

    async def held(session: AsyncSession, user_id: uuid.UUID, upto: datetime) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            updated.set()
            await asyncio.wait_for(release.wait(), timeout=10)
        await real_purge(session, user_id, upto)

    monkeypatch.setattr(repo, "purge_opened", held)
    newer = utcnow()
    older = mentioned - timedelta(seconds=1)

    async def run(target: datetime) -> Any:
        async with factory() as session:
            actor = await session.get(User, alice.id)
            assert actor is not None
            return await service.mark_read(session, actor, target)

    one = asyncio.create_task(run(newer))
    await asyncio.wait_for(updated.wait(), timeout=10)
    two = asyncio.create_task(run(older))
    waited = False
    for _ in range(200):
        waiting = text("SELECT count(*) FROM pg_locks WHERE NOT granted")
        if await db.scalar(waiting):
            waited = True
            break
        await asyncio.sleep(0.02)
    await db.rollback()
    release.set()
    first, second = await asyncio.gather(one, two)
    assert waited
    assert first.read_at == newer and second.read_at == newer
    assert second.unread_count == 0
    assert calls == 1  # the older request moved nothing, so it purged and announced nothing
    assert await _stored(db, alice) == newer
    assert (await client.get(f"{API}/activity/summary")).json()["unread_count"] == 0


async def test_mark_read_alongside_opening_items_keeps_both(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    """Opening an item on one device while another marks an older position read: the position
    stays where the newest request put it and the item stays read."""
    alice, mentioned = await _setup(client, db, as_user)
    feed = (await client.get(f"{API}/activity")).json()["items"]
    factory = app.state.db.session_factory
    async with factory() as one, factory() as two:
        first = await one.get(User, alice.id)
        second = await two.get(User, alice.id)
        assert first is not None and second is not None
        await service.mark_items_read(one, first, [uuid.UUID(feed[0]["id"])])
        await service.mark_read(two, second, mentioned - timedelta(seconds=5))
        await service.mark_read(one, first, mentioned - timedelta(seconds=10))
    assert await _stored(db, alice) == mentioned - timedelta(seconds=5)
    assert (await client.get(f"{API}/activity/summary")).json()["unread_count"] == 0
