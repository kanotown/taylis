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


async def test_search_context_is_bounded_ordered_and_anchored_to_thread_parent(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = (await client.post("/api/v1/channels", json={"name": "context"})).json()["id"]
    before = await _post(client, cid, "before")
    deleted = await _post(client, cid, "deleted")
    parent = await _post(client, cid, "anchor")
    reply = await _post(client, cid, "reply", parent["id"])
    await client.delete(f"/api/v1/messages/{deleted['id']}")
    after = await _post(client, cid, "after")
    await _post(client, cid, "outside window")
    for anchor in (parent, reply):
        response = await client.get(f"/api/v1/messages/{anchor['id']}/context", params={"limit": 1})
        assert response.status_code == 200
        rows = response.json()
        assert [row["id"] for row in rows] == [before["id"], parent["id"], after["id"]]
        assert rows[1]["reply_count"] == 1
        assert all(row["parent_id"] is None for row in rows)
    assert (
        await client.get(f"/api/v1/messages/{parent['id']}/context", params={"limit": 101})
    ).status_code == 422
    assert (await client.get(f"/api/v1/messages/{deleted['id']}/context")).status_code == 404


async def test_search_context_requires_channel_membership(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = (await client.post("/api/v1/channels", json={"name": "context"})).json()["id"]
    parent = await _post(client, cid, "private content")
    reply = await _post(client, cid, "private reply", parent["id"])
    as_user(bob)
    for anchor in (parent, reply):
        assert (await client.get(f"/api/v1/messages/{anchor['id']}/context")).status_code == 403


async def _setup(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> tuple[User, User, User, str]:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    for user in (bob, carol):
        as_user(user)
        await client.post(f"/api/v1/channels/{channel['id']}/join")
    return alice, bob, carol, str(channel["id"])


async def _threads(client: AsyncClient, **params: Any) -> dict[str, Any]:
    response = await client.get("/api/v1/threads", params=params)
    assert response.status_code == 200, response.text
    result: dict[str, Any] = response.json()
    return result


async def _summary(client: AsyncClient) -> dict[str, int]:
    bootstrap = (await client.get("/api/v1/sync/bootstrap")).json()
    result: dict[str, int] = bootstrap["threads"]
    return result


async def test_replies_auto_follow_and_count_unread(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice, bob, carol, cid = await _setup(client, db, as_user)
    as_user(alice)
    parent = await _post(client, cid, "topic")  # seq 1
    assert (await _threads(client))["items"] == []  # no replies yet: nothing to follow
    as_user(bob)
    reply = await _post(client, cid, f"<@{carol.id}> look", parent["id"])  # seq 2

    # The parent author follows with one unread reply.
    as_user(alice)
    page = await _threads(client)
    assert len(page["items"]) == 1
    item = page["items"][0]
    assert item["parent"]["id"] == parent["id"]
    assert item["state"] == {
        "parent_id": parent["id"],
        "channel_id": cid,
        "following": True,
        "last_read_seq": 0,
        "unread_count": 1,
        "mention_count": 0,
        "reply_count": 1,
        "last_reply_at": item["parent"]["last_reply_at"],
        "participant_ids": [str(alice.id), str(bob.id), str(carol.id)],
    }
    assert page["summary"] == {"unread_count": 1, "mention_count": 0}
    assert await _summary(client) == {"unread_count": 1, "mention_count": 0}

    # The replier follows too, with their own reply already read.
    as_user(bob)
    page = await _threads(client)
    assert page["items"][0]["state"]["last_read_seq"] == reply["seq"]
    assert page["items"][0]["state"]["unread_count"] == 0
    assert (await _threads(client, filter="unread"))["items"] == []
    assert await _summary(client) == {"unread_count": 0, "mention_count": 0}

    # Someone mentioned in the thread follows and sees the mention.
    as_user(carol)
    state = (await _threads(client, filter="unread"))["items"][0]["state"]
    assert state["unread_count"] == 1 and state["mention_count"] == 1
    assert await _summary(client) == {"unread_count": 1, "mention_count": 1}

    # thread.updated went to every follower via the outbox, with the reason.
    events = list((await db.execute(select(OutboxEvent).order_by(OutboxEvent.id))).scalars())
    updated = [e for e in events if e.event_type == "thread.updated"]
    assert {(e.audience_type, e.audience_id) for e in updated} == {
        ("user", alice.id),
        ("user", bob.id),
        ("user", carol.id),
    }
    assert {e.payload["reason"] for e in updated} == {"reply"}
    for_alice = next(e for e in updated if e.audience_id == alice.id)
    assert for_alice.payload["unread_count"] == 1 and for_alice.payload["channel_id"] == cid


async def test_thread_read_is_monotonic_and_clamped(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice, bob, _carol, cid = await _setup(client, db, as_user)
    as_user(alice)
    parent = await _post(client, cid, "topic")  # seq 1
    as_user(bob)
    await _post(client, cid, "r1", parent["id"])  # seq 2
    second = await _post(client, cid, "r2", parent["id"])  # seq 3

    as_user(alice)
    read = f"/api/v1/messages/{parent['id']}/thread/read"
    state = (await client.put(read, json={"last_read_seq": 2})).json()
    assert state["last_read_seq"] == 2 and state["unread_count"] == 1
    # Lower positions never move it back; a reply id addresses the same thread.
    state = (
        await client.put(f"/api/v1/messages/{second['id']}/thread/read", json={"last_read_seq": 1})
    ).json()
    assert state["last_read_seq"] == 2
    # Ahead of the newest reply is clamped to it.
    state = (await client.put(read, json={"last_read_seq": 999})).json()
    assert state["last_read_seq"] == 3 and state["unread_count"] == 0
    assert (await _threads(client, filter="unread"))["items"] == []
    assert await _summary(client) == {"unread_count": 0, "mention_count": 0}

    events = list((await db.execute(select(OutboxEvent).order_by(OutboxEvent.id))).scalars())
    reads = [
        e
        for e in events
        if e.event_type == "thread.updated"
        and e.payload["reason"] == "read"
        and e.audience_id == alice.id
    ]
    assert [e.payload["last_read_seq"] for e in reads] == [2, 3]  # no event for the no-op

    # Deleting an unread reply lowers the counts for the others.
    as_user(bob)
    third = await _post(client, cid, "r3", parent["id"])  # seq 4
    as_user(alice)
    assert (await _threads(client))["items"][0]["state"]["unread_count"] == 1
    as_user(bob)
    assert (await client.delete(f"/api/v1/messages/{third['id']}")).status_code == 200
    as_user(alice)
    assert (await _threads(client))["items"][0]["state"]["unread_count"] == 0

    # Non-members cannot touch the thread.
    dave = await make_user(db, "dave")
    as_user(dave)
    assert (await client.put(read, json={"last_read_seq": 1})).status_code == 403


async def test_unfollow_removes_thread_from_list_and_from_push_targets(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice, bob, _carol, cid = await _setup(client, db, as_user)
    as_user(alice)
    parent = await _post(client, cid, "topic")  # seq 1
    as_user(bob)
    await _post(client, cid, "r1", parent["id"])  # seq 2

    as_user(alice)
    follow = f"/api/v1/messages/{parent['id']}/thread/follow"
    state = (await client.put(follow, json={"following": False})).json()
    assert state["following"] is False and state["participant_ids"] == [str(bob.id)]
    assert (await _threads(client))["items"] == []
    assert await _summary(client) == {"unread_count": 0, "mention_count": 0}

    # A new reply does not re-follow, and alice is no longer a push target.
    as_user(bob)
    reply = await _post(client, cid, "r2", parent["id"])  # seq 3
    as_user(alice)
    assert (await _threads(client))["items"] == []
    events = list((await db.execute(select(OutboxEvent).order_by(OutboxEvent.id))).scalars())
    created = next(
        e
        for e in events
        if e.event_type == "message.created" and e.payload["message"]["id"] == reply["id"]
    )
    assert created.payload["parent_thread"]["participant_ids"] == [str(bob.id)]
    assert not [
        e
        for e in events
        if e.event_type == "thread.updated"
        and e.audience_id == alice.id
        and e.payload["reason"] == "reply"
        and e.payload["reply_count"] == 2
    ]

    # Following again lists it with the unread replies since the last read position.
    state = (await client.put(follow, json={"following": True})).json()
    assert state["following"] is True and state["unread_count"] == 2
    assert [i["parent"]["id"] for i in (await _threads(client))["items"]] == [parent["id"]]

    # Pagination: newest reply first, cursor continues the list.
    as_user(alice)
    other = await _post(client, cid, "other topic")  # seq 4
    as_user(bob)
    await _post(client, cid, "r", other["id"])  # seq 5
    as_user(alice)
    page = await _threads(client, limit=1)
    assert [i["parent"]["id"] for i in page["items"]] == [other["id"]]
    page2 = await _threads(client, limit=1, cursor=page["next_cursor"])
    assert [i["parent"]["id"] for i in page2["items"]] == [parent["id"]]
    assert (await _threads(client, limit=1, cursor=page2["next_cursor"]))["items"] == []
