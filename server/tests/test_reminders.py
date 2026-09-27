"""Reminders (M12e): the API, the worker and the push nudge."""

import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any, cast

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.reminders import service as reminders
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_push_planner import add_device, deliveries, relay_with_planner


async def _post(client: AsyncClient, channel_id: str, body: str) -> dict[str, Any]:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body},
    )
    assert response.status_code == 201, response.text
    return cast(dict[str, Any], response.json())


async def test_reminders_are_personal_and_validated(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    as_user(bob)
    await client.post(f"/api/v1/channels/{general['id']}/join")
    as_user(alice)
    message = await _post(client, general["id"], "レビューをお願いします <@" + str(bob.id) + ">")

    as_user(bob)
    later = (utcnow() + timedelta(hours=1)).isoformat()
    created = await client.post(
        f"/api/v1/messages/{message['id']}/reminders",
        json={"remind_at": later, "note": " 返信する "},
    )
    assert created.status_code == 201, created.text
    row = created.json()
    assert row["status"] == "pending" and row["note"] == "返信する"
    assert row["preview"].startswith("レビューをお願いします")
    assert row["channel_id"] == general["id"] and row["message_id"] == message["id"]
    assert [r["id"] for r in (await client.get("/api/v1/reminders")).json()] == [row["id"]]
    soon = await client.post(
        f"/api/v1/messages/{message['id']}/reminders", json={"remind_at": utcnow().isoformat()}
    )
    assert soon.status_code == 400 and soon.json()["error"]["code"] == "remind_at_too_soon"
    # Alice has none; Carol (not a member) cannot set one; cancelling is personal too.
    as_user(alice)
    assert (await client.get("/api/v1/reminders")).json() == []
    assert (await client.delete(f"/api/v1/reminders/{row['id']}")).status_code == 404
    as_user(carol)
    denied = await client.post(
        f"/api/v1/messages/{message['id']}/reminders", json={"remind_at": later}
    )
    assert denied.status_code == 403
    as_user(bob)
    assert (await client.delete(f"/api/v1/reminders/{row['id']}")).status_code == 204
    assert (await client.get("/api/v1/reminders")).json() == []
    events = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "reminder.updated")))
        .scalars()
        .all()
    )
    assert [e.payload["reminder"]["status"] for e in events] == ["pending", "cancelled"]
    assert {e.audience_id for e in events} == {bob.id}


async def test_due_reminders_fire_once_and_nudge_the_owner(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    as_user(bob)
    await client.post(f"/api/v1/channels/{general['id']}/join")
    as_user(alice)
    message = await _post(client, general["id"], "議事録を送ってください")
    as_user(bob)
    later = utcnow() + timedelta(hours=1)
    row = (
        await client.post(
            f"/api/v1/messages/{message['id']}/reminders",
            json={"remind_at": later.isoformat(), "note": "議事録"},
        )
    ).json()

    async with app.state.db.session_factory() as worker_db:
        assert await reminders.fire_due(worker_db, now=utcnow()) == 0
        assert await reminders.fire_due(worker_db, now=later + timedelta(minutes=1)) == 1
        assert await reminders.fire_due(worker_db, now=later + timedelta(minutes=1)) == 0
    listed = (await client.get("/api/v1/reminders")).json()
    assert [(r["id"], r["status"]) for r in listed] == [(row["id"], "fired")]
    assert listed[0]["fired_at"] is not None

    # The fired event becomes a push for bob's device with the note and the preview.
    relay = relay_with_planner(app, test_settings)
    while await relay.process_batch():
        pass
    rows = await deliveries(db)
    assert len(rows) == 1
    payload = rows[0].payload
    assert payload["kind"] == "reminder" and payload["title"] == "リマインダー"
    assert payload["body"] == "議事録 — 議事録を送ってください"
    assert payload["channel_id"] == general["id"] and payload["message_id"] == message["id"]
    assert payload["badge"] >= 1

    # Done: it leaves the list and the badge no longer counts it.
    assert (await client.delete(f"/api/v1/reminders/{row['id']}")).status_code == 204
    assert (await client.get("/api/v1/reminders")).json() == []
    assert await reminders.fired_count(db, bob.id) == 0
