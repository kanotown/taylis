"""Pins (channel-wide, seq-consuming) and bookmarks (personal, user event) — M11c."""

import uuid
from collections.abc import Callable
from typing import Any

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
    result: dict[str, Any] = response.json()
    return result


async def _setup(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> tuple[User, User, User, str]:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    as_user(bob)
    await client.post(f"/api/v1/channels/{channel['id']}/join")
    return alice, bob, carol, str(channel["id"])


async def _events(db: AsyncSession, event_type: str) -> list[OutboxEvent]:
    rows = (await db.execute(select(OutboxEvent).order_by(OutboxEvent.id))).scalars()
    return [e for e in rows if e.event_type == event_type]


async def test_any_member_pins_and_the_change_consumes_a_seq(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice, bob, carol, cid = await _setup(client, db, as_user)
    as_user(alice)
    message = await _post(client, cid, "remember this")  # seq 1
    as_user(bob)
    pinned = await client.put(f"/api/v1/messages/{message['id']}/pin")
    assert pinned.status_code == 201
    body = pinned.json()
    assert body["pinned_by"] == str(bob.id) and body["pinned_at"] is not None
    assert body["updated_seq"] == 2  # the pin consumed a seq: delta sync carries it
    again = await client.put(f"/api/v1/messages/{message['id']}/pin")
    assert again.status_code == 200 and again.json()["updated_seq"] == 2

    pins = (await client.get(f"/api/v1/channels/{cid}/pins")).json()
    assert [m["id"] for m in pins] == [message["id"]]
    delta = (await client.get(f"/api/v1/channels/{cid}/sync", params={"since_seq": 1})).json()
    assert delta["messages"][0]["pinned_by"] == str(bob.id)

    updated = await _events(db, "message.updated")
    assert [e.payload["change"] for e in updated] == ["pin"]
    assert updated[0].payload["message"]["pinned_by"] == str(bob.id) and updated[0].seq == 2

    # Unpin (by anyone), then the list is empty and the message carries no pin.
    as_user(alice)
    unpinned = await client.delete(f"/api/v1/messages/{message['id']}/pin")
    assert unpinned.status_code == 200
    assert unpinned.json()["pinned_at"] is None and unpinned.json()["updated_seq"] == 3
    assert (await client.get(f"/api/v1/channels/{cid}/pins")).json() == []

    # Deleting a pinned message drops it from the pins.
    other = await _post(client, cid, "pin then delete")
    await client.put(f"/api/v1/messages/{other['id']}/pin")
    assert len((await client.get(f"/api/v1/channels/{cid}/pins")).json()) == 1
    await client.delete(f"/api/v1/messages/{other['id']}")
    assert (await client.get(f"/api/v1/channels/{cid}/pins")).json() == []

    # Non-members can neither pin nor list.
    as_user(carol)
    assert (await client.put(f"/api/v1/messages/{message['id']}/pin")).status_code == 403
    assert (await client.get(f"/api/v1/channels/{cid}/pins")).status_code == 403


async def test_bookmarks_are_personal_and_sync_to_my_devices(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice, bob, carol, cid = await _setup(client, db, as_user)
    as_user(alice)
    first = await _post(client, cid, "first")
    second = await _post(client, cid, "second")

    as_user(bob)
    saved = await client.put(f"/api/v1/messages/{first['id']}/bookmark")
    assert saved.status_code == 201
    assert saved.json() == {"message_id": first["id"], "bookmarked": True}
    assert (await client.put(f"/api/v1/messages/{first['id']}/bookmark")).status_code == 200
    assert (await client.put(f"/api/v1/messages/{second['id']}/bookmark")).status_code == 201

    # Saving never touches the channel: the messages keep their seq / updated_seq.
    current = (await client.get(f"/api/v1/messages/{first['id']}")).json()
    assert current["updated_seq"] == 1
    bootstrap = (await client.get("/api/v1/sync/bootstrap")).json()
    assert bootstrap["bookmarks"] == [second["id"], first["id"]]  # newest saved first
    listed = (await client.get("/api/v1/bookmarks")).json()
    assert [i["message"]["body"] for i in listed["items"]] == ["second", "first"]
    page = (await client.get("/api/v1/bookmarks", params={"limit": 1})).json()
    assert [i["message"]["body"] for i in page["items"]] == ["second"]
    rest = (
        await client.get("/api/v1/bookmarks", params={"limit": 1, "cursor": page["next_cursor"]})
    ).json()
    assert [i["message"]["body"] for i in rest["items"]] == ["first"]

    # Only bob's devices hear about it; alice has no bookmarks.
    events = await _events(db, "bookmark.updated")
    assert {(e.audience_type, e.audience_id) for e in events} == {("user", bob.id)}
    assert [e.payload["bookmarked"] for e in events] == [True, True]
    assert events[0].payload["channel_id"] == cid
    as_user(alice)
    assert (await client.get("/api/v1/sync/bootstrap")).json()["bookmarks"] == []

    # Removing, and a deleted message disappears from the saved list.
    as_user(bob)
    removed = await client.delete(f"/api/v1/messages/{second['id']}/bookmark")
    assert removed.status_code == 200 and removed.json()["bookmarked"] is False
    assert (await client.get("/api/v1/sync/bootstrap")).json()["bookmarks"] == [first["id"]]
    as_user(alice)
    await client.delete(f"/api/v1/messages/{first['id']}")
    as_user(bob)
    assert (await client.get("/api/v1/bookmarks")).json()["items"] == []
    assert (await client.get("/api/v1/sync/bootstrap")).json()["bookmarks"] == []

    # Non-members cannot save messages of channels they are not in.
    as_user(carol)
    assert (await client.put(f"/api/v1/messages/{second['id']}/bookmark")).status_code == 403
