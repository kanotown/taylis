"""Thread replies (M8c): parent counters, history / delta shapes, replies endpoint, push targets."""

import uuid
from collections.abc import Callable
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import build_settings
from app.events.models import OutboxEvent
from app.modules.channels import service as channels
from app.modules.notifications.planner import PushPlanner
from app.modules.users.models import User
from tests.helpers import make_user


async def _post(
    client: AsyncClient, channel_id: str, body: str, parent_id: str | None = None
) -> dict[str, Any]:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body, "parent_id": parent_id},
    )
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


async def test_replies_update_the_parent_and_stay_out_of_history(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    cid = channel["id"]
    for user in (bob, carol):
        as_user(user)
        await client.post(f"/api/v1/channels/{cid}/join")

    as_user(alice)
    parent = await _post(client, cid, "topic")  # seq 1
    as_user(bob)
    first = await _post(client, cid, "reply 1", parent["id"])  # seq 2
    as_user(alice)
    second = await _post(client, cid, "reply 2", parent["id"])  # seq 3
    assert first["parent_id"] == parent["id"] and first["seq"] == 2
    assert second["seq"] == 3

    # Replies to replies and cross-channel parents are rejected.
    denied = await client.post(
        f"/api/v1/channels/{cid}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": "x", "parent_id": first["id"]},
    )
    assert denied.status_code == 400 and denied.json()["error"]["code"] == "reply_depth"
    other = (await client.post("/api/v1/channels", json={"name": "other"})).json()
    wrong = await client.post(
        f"/api/v1/channels/{other['id']}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": "x", "parent_id": parent["id"]},
    )
    assert wrong.status_code == 404

    # The parent carries the thread counters and moved to the last reply's seq.
    current = (await client.get(f"/api/v1/messages/{parent['id']}")).json()
    assert current["reply_count"] == 2 and current["updated_seq"] == 3
    assert current["last_reply_at"] is not None

    history = (await client.get(f"/api/v1/channels/{cid}/messages")).json()
    assert [m["id"] for m in history["messages"]] == [parent["id"]]  # replies are not top-level
    assert history["channel_last_seq"] == 3

    delta = (await client.get(f"/api/v1/channels/{cid}/sync", params={"since_seq": 1})).json()
    assert {m["id"] for m in delta["messages"]} == {parent["id"], first["id"], second["id"]}

    replies = (await client.get(f"/api/v1/messages/{parent['id']}/replies")).json()
    assert [m["body"] for m in replies] == ["reply 1", "reply 2"]

    # Replies are not unread items for members (the parent is).
    as_user(carol)
    bootstrap = (await client.get("/api/v1/sync/bootstrap")).json()
    state = next(c["read_state"] for c in bootstrap["channels"] if c["id"] == cid)
    assert state["unread_count"] == 1

    # Deleting a reply lowers the counter and moves the parent again.
    as_user(bob)
    deleted = await client.delete(f"/api/v1/messages/{first['id']}")
    assert deleted.status_code == 200
    current = (await client.get(f"/api/v1/messages/{parent['id']}")).json()
    assert current["reply_count"] == 1 and current["updated_seq"] == 4
    replies = (await client.get(f"/api/v1/messages/{parent['id']}/replies")).json()
    assert [m["body"] for m in replies] == ["reply 2"]

    # Events carry parent_thread with the participants (push targets).
    events = list((await db.execute(select(OutboxEvent).order_by(OutboxEvent.id))).scalars())
    created = [
        e for e in events if e.event_type == "message.created" and e.payload["message"]["parent_id"]
    ]
    assert created[0].payload["parent_thread"]["reply_count"] == 1
    assert created[0].payload["parent_thread"]["participant_ids"] == [str(alice.id), str(bob.id)]
    assert created[1].payload["parent_thread"]["reply_count"] == 2
    removed = next(e for e in events if e.event_type == "message.deleted")
    assert removed.payload["parent_thread"]["reply_count"] == 1

    # Non-members cannot read a thread.
    dave = await make_user(db, "dave")
    as_user(dave)
    assert (await client.get(f"/api/v1/messages/{parent['id']}/replies")).status_code == 403


async def test_thread_participants_are_push_targets(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    for user in (bob, carol):
        as_user(user)
        await client.post(f"/api/v1/channels/{channel['id']}/join")
    as_user(alice)
    parent = await _post(client, channel["id"], "topic")
    as_user(bob)
    reply = await _post(client, channel["id"], "reply", parent["id"])

    planner = PushPlanner(build_settings(), is_active=lambda _uid: False)
    record = await channels.require_channel(db, uuid.UUID(channel["id"]))
    # Channel default is "mentions": alice is targeted as the parent author, carol is not.
    participants = {alice.id, bob.id}
    targets = await planner.select_recipients(db, record, [alice.id, carol.id], reply, participants)
    assert targets == [alice.id]
