"""Starred channels and 「すべて既読にする」 (M12a)."""

import uuid
from collections.abc import Callable
from typing import Any, cast

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.users.models import User
from tests.helpers import make_user


async def _post(client: AsyncClient, channel_id: str, body: str) -> dict[str, Any]:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body},
    )
    assert response.status_code == 201, response.text
    return cast(dict[str, Any], response.json())


async def _events(db: AsyncSession, event_type: str) -> list[OutboxEvent]:
    rows = await db.execute(
        select(OutboxEvent).where(OutboxEvent.event_type == event_type).order_by(OutboxEvent.id)
    )
    return list(rows.scalars().all())


async def test_favorites_are_personal_and_follow_membership(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    random = (await client.post("/api/v1/channels", json={"name": "random"})).json()
    as_user(bob)
    await client.post(f"/api/v1/channels/{general['id']}/join")

    starred = await client.put(f"/api/v1/channels/{general['id']}/favorite")
    assert starred.status_code == 201
    assert starred.json() == {"channel_id": general["id"], "favorite": True}
    assert (await client.put(f"/api/v1/channels/{general['id']}/favorite")).status_code == 200
    # Only members can star; the star is personal.
    assert (await client.put(f"/api/v1/channels/{random['id']}/favorite")).status_code == 403
    assert (await client.get("/api/v1/sync/bootstrap")).json()["favorites"] == [general["id"]]
    as_user(alice)
    assert (await client.get("/api/v1/sync/bootstrap")).json()["favorites"] == []
    events = await _events(db, "favorite.updated")
    assert [(e.audience_type, e.audience_id, e.payload["favorite"]) for e in events] == [
        ("user", bob.id, True)
    ]

    # Leaving hides the star; unstarring emits once more.
    as_user(bob)
    assert (await client.post(f"/api/v1/channels/{general['id']}/leave")).status_code == 204
    assert (await client.get("/api/v1/sync/bootstrap")).json()["favorites"] == []
    await client.post(f"/api/v1/channels/{general['id']}/join")
    assert (await client.get("/api/v1/sync/bootstrap")).json()["favorites"] == [general["id"]]
    removed = await client.delete(f"/api/v1/channels/{general['id']}/favorite")
    assert removed.status_code == 200 and removed.json()["favorite"] is False
    assert (await client.get("/api/v1/sync/bootstrap")).json()["favorites"] == []
    assert [e.payload["favorite"] for e in await _events(db, "favorite.updated")] == [True, False]


async def test_read_all_moves_every_channel_to_its_end(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    random = (await client.post("/api/v1/channels", json={"name": "random"})).json()
    quiet = (await client.post("/api/v1/channels", json={"name": "quiet"})).json()
    as_user(bob)
    for channel in (general, random, quiet):
        await client.post(f"/api/v1/channels/{channel['id']}/join")
    as_user(alice)
    await _post(client, general["id"], "one")
    await _post(client, general["id"], "two")
    await _post(client, random["id"], "three")

    as_user(bob)
    before = {
        c["id"]: c["read_state"]
        for c in (await client.get("/api/v1/sync/bootstrap")).json()["channels"]
    }
    assert before[general["id"]]["unread_count"] == 2
    assert before[random["id"]]["unread_count"] == 1
    assert before[quiet["id"]]["unread_count"] == 0

    done = await client.post("/api/v1/channels/read-all")
    assert done.status_code == 200
    states = {row["channel_id"]: row for row in done.json()}
    assert set(states) == {general["id"], random["id"], quiet["id"]}
    assert all(row["unread_count"] == 0 and row["mention_count"] == 0 for row in states.values())
    assert states[general["id"]]["last_read_seq"] == 2
    after = {
        c["id"]: c["read_state"]
        for c in (await client.get("/api/v1/sync/bootstrap")).json()["channels"]
    }
    assert all(state["unread_count"] == 0 for state in after.values())
    # Only the channels that moved tell bob's other devices.
    moved = [e for e in await _events(db, "read.updated") if e.audience_id == bob.id]
    assert {e.channel_id for e in moved} == {uuid.UUID(general["id"]), uuid.UUID(random["id"])}
    assert all(e.payload["reason"] == "advance" for e in moved)
