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
    # The failed one stays listed with its error (its text is only there) until dismissed.
    listed = (await client.get("/api/v1/scheduled")).json()
    assert [(r["id"], r["status"], r["error"], r["body"]) for r in listed] == [
        (other["id"], "failed", "channel_archived", "never lands")
    ]
    assert (await client.delete(f"/api/v1/scheduled/{other['id']}")).status_code == 204
    assert (await client.get("/api/v1/scheduled")).json() == []
    assert (await client.delete(f"/api/v1/scheduled/{other['id']}")).status_code == 404
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
    assert by_id[other["id"]] == ["pending", "failed", "cancelled"]
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


async def test_scheduled_post_keeps_priority_ack_and_also_in_channel(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """Functional review v0.1.84 #1: the composer's options survive the schedule (send now and
    the worker), are listed with the row, and get the same checks as an ordinary post."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    as_user(bob)
    assert (await client.post(f"/api/v1/channels/{general['id']}/join")).status_code == 200
    as_user(alice)
    parent = (
        await client.post(
            f"/api/v1/channels/{general['id']}/messages",
            json={"client_msg_id": str(uuid.uuid4()), "body": "topic"},
        )
    ).json()
    flagged = await _schedule(
        client, general["id"], "必ず読んで", priority="urgent", ack_requested=True
    )
    assert (flagged["priority"], flagged["ack_requested"], flagged["also_in_channel"]) == (
        "urgent",
        True,
        False,
    )
    broadcast = await _schedule(
        client, general["id"], "thread and channel", parent_id=parent["id"], also_in_channel=True
    )
    assert broadcast["also_in_channel"] is True and broadcast["priority"] is None
    plain = await _schedule(client, general["id"], "older client")  # options left out
    assert (plain["priority"], plain["ack_requested"], plain["also_in_channel"]) == (
        None,
        False,
        False,
    )
    listed = {r["id"]: r for r in (await client.get("/api/v1/scheduled")).json()}
    assert listed[flagged["id"]]["priority"] == "urgent"
    assert listed[broadcast["id"]]["also_in_channel"] is True

    # The same constraints as MessageCreate.
    for bad in (
        {"also_in_channel": True},  # not a reply
        {"parent_id": parent["id"], "priority": "important"},
        {"parent_id": parent["id"], "ack_requested": True},
        {"priority": "whenever"},
    ):
        refused = await client.post(
            f"/api/v1/channels/{general['id']}/scheduled",
            json={
                "client_msg_id": str(uuid.uuid4()),
                "body": "x",
                "send_at": (utcnow() + timedelta(hours=1)).isoformat(),
            }
            | bad,
        )
        assert refused.status_code == 422, bad

    sent = await client.post(f"/api/v1/scheduled/{flagged['id']}/send-now")
    assert sent.status_code == 200, sent.text
    assert (sent.json()["priority"], sent.json()["ack_requested"]) == ("urgent", True)
    async with app.state.db.session_factory() as worker_db:
        assert await scheduled.send_due(worker_db, now=utcnow() + timedelta(hours=2)) == 2
    as_user(bob)  # another member receives them with the options
    got = (await client.get(f"/api/v1/messages/{sent.json()['id']}")).json()
    assert (got["priority"], got["ack_requested"]) == ("urgent", True)
    replies = (await client.get(f"/api/v1/messages/{parent['id']}/replies")).json()
    assert [(r["body"], r["also_in_channel"]) for r in replies] == [("thread and channel", True)]


async def test_scheduled_post_respects_announcement_channels(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """A member of an owners-only channel may schedule a thread reply but not a post (or a reply
    sent to the channel too): refused when scheduled, not only when it fails at its time."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    news = (await client.post("/api/v1/channels", json={"name": "news"})).json()
    as_user(bob)
    assert (await client.post(f"/api/v1/channels/{news['id']}/join")).status_code == 200
    as_user(alice)
    assert (
        await client.patch(f"/api/v1/channels/{news['id']}", json={"posting_policy": "owners"})
    ).status_code == 200
    parent = (
        await client.post(
            f"/api/v1/channels/{news['id']}/messages",
            json={"client_msg_id": str(uuid.uuid4()), "body": "announcement"},
        )
    ).json()
    as_user(bob)
    base = {
        "client_msg_id": str(uuid.uuid4()),
        "body": "x",
        "send_at": (utcnow() + timedelta(hours=1)).isoformat(),
    }
    top = await client.post(f"/api/v1/channels/{news['id']}/scheduled", json=base)
    assert top.status_code == 403 and top.json()["error"]["code"] == "posting_restricted"
    also = await client.post(
        f"/api/v1/channels/{news['id']}/scheduled",
        json=base | {"parent_id": parent["id"], "also_in_channel": True},
    )
    assert also.status_code == 403
    await _schedule(client, news["id"], "a reply is fine", parent_id=parent["id"])
