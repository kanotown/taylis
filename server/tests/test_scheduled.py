"""Scheduled messages (M12d): the API, the worker, idempotency and attachment reservation."""

import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any, cast

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.attachments.models import Attachment
from app.modules.scheduled import service as scheduled
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_attachments import upload


async def _schedule(
    client: AsyncClient, channel_id: str, body: str, **extra: object
) -> dict[str, Any]:
    payload = {
        "client_msg_id": str(uuid.uuid4()),
        "body": body,
        "send_at": (utcnow() + timedelta(hours=1)).isoformat(),
    } | extra
    response = await client.post(f"/api/v1/channels/{channel_id}/scheduled", json=payload)
    assert response.status_code == 201, response.text
    return cast(dict[str, Any], response.json())


async def test_schedule_list_cancel_and_validation(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    row = await _schedule(client, general["id"], "明日の朝に届く")
    assert row["status"] == "pending" and row["channel_id"] == general["id"]
    listed = (await client.get("/api/v1/scheduled")).json()
    assert [r["id"] for r in listed] == [row["id"]]
    # Too soon, too far, non-members and empty bodies are refused.
    soon = await client.post(
        f"/api/v1/channels/{general['id']}/scheduled",
        json={"client_msg_id": str(uuid.uuid4()), "body": "x", "send_at": utcnow().isoformat()},
    )
    assert soon.status_code == 400 and soon.json()["error"]["code"] == "send_at_too_soon"
    far = await client.post(
        f"/api/v1/channels/{general['id']}/scheduled",
        json={
            "client_msg_id": str(uuid.uuid4()),
            "body": "x",
            "send_at": (utcnow() + timedelta(days=400)).isoformat(),
        },
    )
    assert far.status_code == 400
    empty = await client.post(
        f"/api/v1/channels/{general['id']}/scheduled",
        json={
            "client_msg_id": str(uuid.uuid4()),
            "body": "  ",
            "send_at": (utcnow() + timedelta(hours=1)).isoformat(),
        },
    )
    assert empty.status_code == 422
    as_user(bob)
    assert (await client.get("/api/v1/scheduled")).json() == []
    denied = await client.post(
        f"/api/v1/channels/{general['id']}/scheduled",
        json={
            "client_msg_id": str(uuid.uuid4()),
            "body": "x",
            "send_at": (utcnow() + timedelta(hours=1)).isoformat(),
        },
    )
    assert denied.status_code == 403
    assert (await client.delete(f"/api/v1/scheduled/{row['id']}")).status_code == 404
    as_user(alice)
    assert (await client.delete(f"/api/v1/scheduled/{row['id']}")).status_code == 204
    assert (await client.get("/api/v1/scheduled")).json() == []
    events = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "scheduled.updated")))
        .scalars()
        .all()
    )
    assert [e.payload["scheduled"]["status"] for e in events] == ["pending", "cancelled"]
    assert {e.audience_id for e in events} == {alice.id}


async def test_worker_posts_at_the_time_once_and_marks_failures(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    doomed = (await client.post("/api/v1/channels", json={"name": "doomed"})).json()
    parent = (
        await client.post(
            f"/api/v1/channels/{general['id']}/messages",
            json={"client_msg_id": str(uuid.uuid4()), "body": "topic"},
        )
    ).json()
    reply = await _schedule(client, general["id"], "scheduled reply", parent_id=parent["id"])
    other = await _schedule(client, doomed["id"], "never lands")
    wrong_parent = await client.post(
        f"/api/v1/channels/{doomed['id']}/scheduled",
        json={
            "client_msg_id": str(uuid.uuid4()),
            "body": "x",
            "parent_id": parent["id"],
            "send_at": (utcnow() + timedelta(hours=1)).isoformat(),
        },
    )
    assert wrong_parent.status_code == 400
    assert (await client.post(f"/api/v1/channels/{doomed['id']}/archive")).status_code == 200

    # The worker runs in its own session, as in production (a rollback there must not touch
    # the session the API calls below share with this test).
    later = utcnow() + timedelta(hours=2)
    async with app.state.db.session_factory() as worker_db:
        assert await scheduled.send_due(worker_db, now=utcnow()) == 0  # not yet
        assert await scheduled.send_due(worker_db, now=later) == 1
        assert await scheduled.send_due(worker_db, now=later) == 0  # nothing left
    replies = (await client.get(f"/api/v1/messages/{parent['id']}/replies")).json()
    assert [r["body"] for r in replies] == ["scheduled reply"]
    assert replies[0]["client_msg_id"] == reply["client_msg_id"]
    assert (await client.get("/api/v1/scheduled")).json() == []
    events = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "scheduled.updated")
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    )
    by_id: dict[str, list[str]] = {}
    for event in events:
        by_id.setdefault(event.payload["scheduled"]["id"], []).append(
            event.payload["scheduled"]["status"]
        )
    assert by_id[reply["id"]] == ["pending", "sent"]
    assert by_id[other["id"]] == ["pending", "failed"]
    failed = [e for e in events if e.payload["scheduled"]["id"] == other["id"]][-1]
    assert failed.payload["scheduled"]["error"] == "channel_archived"


async def test_send_now_and_attachment_reservation(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    kept = (await upload(client, "kept.txt", b"kept", "text/plain")).json()["id"]
    dropped = (await upload(client, "dropped.txt", b"dropped", "text/plain")).json()["id"]
    first = await _schedule(client, general["id"], "with a file", attachment_ids=[kept])
    second = await _schedule(client, general["id"], "", attachment_ids=[dropped])
    assert [a["filename"] for a in first["attachments"]] == ["kept.txt"]
    statuses = {
        a.filename: a.status for a in (await db.execute(select(Attachment))).scalars().all()
    }
    assert statuses == {"kept.txt": "scheduled", "dropped.txt": "scheduled"}
    # The same upload cannot be used twice.
    reuse = await client.post(
        f"/api/v1/channels/{general['id']}/scheduled",
        json={
            "client_msg_id": str(uuid.uuid4()),
            "body": "again",
            "attachment_ids": [kept],
            "send_at": (utcnow() + timedelta(hours=1)).isoformat(),
        },
    )
    assert reuse.status_code == 400

    sent = await client.post(f"/api/v1/scheduled/{first['id']}/send-now")
    assert sent.status_code == 200, sent.text
    assert sent.json()["body"] == "with a file"
    assert [a["filename"] for a in sent.json()["attachments"]] == ["kept.txt"]
    assert (await client.post(f"/api/v1/scheduled/{first['id']}/send-now")).status_code == 404
    assert (await client.delete(f"/api/v1/scheduled/{second['id']}")).status_code == 204
    db.expire_all()
    statuses = {
        a.filename: a.status for a in (await db.execute(select(Attachment))).scalars().all()
    }
    assert statuses == {"kept.txt": "attached", "dropped.txt": "deleted"}
