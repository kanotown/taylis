"""REVIEW-v0.1.43 #9: the same report sent twice at once (POST /reports with one
client_report_id, or POST /messages/{id}/report) is one report: 201 and 200, one audit entry
and one notice to the administrators; never a 500. Different keys stay different reports."""

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.models import AuditLog
from app.modules.messages import service as messages
from app.modules.moderation import service
from app.modules.moderation.models import MessageReport
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_moderation import _bot_dm_bodies, _post

Actor = Callable[[User], None]


def _hold_both(
    monkeypatch: pytest.MonkeyPatch, owner: Any, name: str, *, pending: Callable[[Any], bool]
) -> None:
    """Both requests pass `owner.name` (the "already reported?" check) before either inserts:
    the first two calls whose result is `pending` wait for each other."""
    real = getattr(owner, name)
    arrived = 0
    both = asyncio.Event()

    async def held(*args: Any, **kwargs: Any) -> Any:
        nonlocal arrived
        result = await real(*args, **kwargs)
        if pending(result) and not both.is_set():
            arrived += 1
            if arrived >= 2:
                both.set()
            await asyncio.wait_for(both.wait(), timeout=10)
        return result

    monkeypatch.setattr(owner, name, held)


async def _count(db: AsyncSession, model: Any, *where: Any) -> int:
    return int(await db.scalar(select(func.count()).select_from(model).where(*where)) or 0)


async def _twice(send: Callable[[], Awaitable[Response]]) -> list[Response]:
    return list(await asyncio.gather(send(), send()))


async def test_the_same_client_report_id_at_once_is_one_report(
    client: AsyncClient, db: AsyncSession, as_user: Actor, monkeypatch: pytest.MonkeyPatch
) -> None:
    admin = await make_user(db, "admin", role="admin")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    _hold_both(monkeypatch, service, "find_general_report", pending=lambda found: found is None)
    key = str(uuid.uuid4())
    body = {"category": "harassment", "note": "again", "user_id": str(bob.id)}

    responses = await _twice(
        lambda: client.post("/api/v1/reports", json={**body, "client_report_id": key})
    )
    assert sorted(r.status_code for r in responses) == [200, 201], [r.text for r in responses]
    assert responses[0].json() == responses[1].json()
    assert await _count(db, MessageReport, MessageReport.reporter_id == alice.id) == 1
    submitted = AuditLog.action == "moderation.report_submitted"
    assert await _count(db, AuditLog, submitted) == 1
    assert len(await _bot_dm_bodies(db, admin)) == 1

    # A later retry is the same report too.
    again = await client.post("/api/v1/reports", json={**body, "client_report_id": key})
    assert again.status_code == 200 and again.json() == responses[0].json()


async def test_different_client_report_ids_at_once_are_two_reports(
    client: AsyncClient, db: AsyncSession, as_user: Actor, monkeypatch: pytest.MonkeyPatch
) -> None:
    admin = await make_user(db, "admin", role="admin")
    alice = await make_user(db, "alice")
    as_user(alice)
    _hold_both(monkeypatch, service, "find_general_report", pending=lambda found: found is None)

    responses = await _twice(
        lambda: client.post(
            "/api/v1/reports",
            json={"category": "feedback", "note": "hi", "client_report_id": str(uuid.uuid4())},
        )
    )
    assert [r.status_code for r in responses] == [201, 201]
    assert responses[0].json()["id"] != responses[1].json()["id"]
    assert await _count(db, MessageReport, MessageReport.reporter_id == alice.id) == 2
    assert len(await _bot_dm_bodies(db, admin)) == 2


async def test_the_same_message_reported_twice_at_once_is_one_report(
    client: AsyncClient, db: AsyncSession, as_user: Actor, monkeypatch: pytest.MonkeyPatch
) -> None:
    admin = await make_user(db, "admin", role="admin")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(bob)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    message = await _post(client, general["id"], "spam")
    as_user(alice)
    await client.post(f"/api/v1/channels/{general['id']}/join")
    _hold_both(monkeypatch, messages, "get_readable_message", pending=lambda _: True)

    responses = await _twice(
        lambda: client.post(f"/api/v1/messages/{message['id']}/report", json={"reason": "spam"})
    )
    assert sorted(r.status_code for r in responses) == [200, 201], [r.text for r in responses]
    assert responses[0].json() == responses[1].json()
    assert await _count(db, MessageReport, MessageReport.reporter_id == alice.id) == 1
    reported = AuditLog.action == "moderation.message_reported"
    assert await _count(db, AuditLog, reported) == 1
    assert len(await _bot_dm_bodies(db, admin)) == 1
