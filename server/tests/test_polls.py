"""Polls on messages (M14b)."""

import uuid
from collections.abc import Callable
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.users.models import User
from tests.helpers import make_user


async def _poll(client: AsyncClient, channel_id: str, **poll: Any) -> Any:
    body = {
        "client_msg_id": str(uuid.uuid4()),
        "poll": {"question": "ランチはどこ?", "options": ["そば", "カレー", "パスタ"], **poll},
    }
    return await client.post(f"/api/v1/channels/{channel_id}/messages", json=body)


async def test_poll_lifecycle(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    root = await make_user(db, "root", role="admin")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "lunch"})).json()
    for user in (bob, root):
        await client.post(
            f"/api/v1/channels/{channel['id']}/members", json={"user_id": str(user.id)}
        )

    created = await _poll(client, channel["id"])
    assert created.status_code == 201, created.text
    message = created.json()
    assert message["body"] == "📊 ランチはどこ?"
    assert message["poll"] == {
        "question": "ランチはどこ?",
        "options": ["そば", "カレー", "パスタ"],
        "multiple": False,
        "closed_at": None,
        "votes": [[], [], []],
    }
    bad = await _poll(client, channel["id"], options=["ひとつ"])
    assert bad.status_code == 422
    dup = await _poll(client, channel["id"], options=["A", "a"])
    assert dup.status_code == 422

    # Single choice: a second vote moves the first.
    voted = await client.put(f"/api/v1/messages/{message['id']}/poll/votes/0")
    assert voted.status_code == 201 and voted.json()["poll"]["votes"] == [[str(alice.id)], [], []]
    moved = await client.put(f"/api/v1/messages/{message['id']}/poll/votes/2")
    assert moved.status_code == 201 and moved.json()["poll"]["votes"] == [[], [], [str(alice.id)]]
    same = await client.put(f"/api/v1/messages/{message['id']}/poll/votes/2")
    assert same.status_code == 200
    as_user(bob)
    both = await client.put(f"/api/v1/messages/{message['id']}/poll/votes/2")
    assert both.json()["poll"]["votes"][2] == [str(alice.id), str(bob.id)]
    withdrawn = await client.delete(f"/api/v1/messages/{message['id']}/poll/votes/2")
    assert withdrawn.json()["poll"]["votes"][2] == [str(alice.id)]
    invalid = await client.put(f"/api/v1/messages/{message['id']}/poll/votes/9")
    assert invalid.status_code == 400 and invalid.json()["error"]["code"] == "poll_option_invalid"
    plain = (
        await client.post(
            f"/api/v1/channels/{channel['id']}/messages",
            json={"client_msg_id": str(uuid.uuid4()), "body": "no poll"},
        )
    ).json()
    none = await client.put(f"/api/v1/messages/{plain['id']}/poll/votes/0")
    assert none.status_code == 404 and none.json()["error"]["code"] == "poll_not_found"

    # History carries the poll with its votes; every change was announced as message.updated.
    history = await client.get(f"/api/v1/channels/{channel['id']}/messages")
    row = next(m for m in history.json()["messages"] if m["id"] == message["id"])
    assert row["poll"]["votes"] == [[], [], [str(alice.id)]]
    rows = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "message.updated")))
        .scalars()
        .all()
    )
    assert {r.payload["change"] for r in rows} == {"poll"} and len(rows) == 4

    # Only the author or an admin closes; a closed poll takes no votes.
    denied = await client.post(f"/api/v1/messages/{message['id']}/poll/close")
    assert denied.status_code == 403
    as_user(root)
    closed = await client.post(f"/api/v1/messages/{message['id']}/poll/close")
    assert closed.status_code == 200 and closed.json()["poll"]["closed_at"] is not None
    as_user(bob)
    late = await client.put(f"/api/v1/messages/{message['id']}/poll/votes/1")
    assert late.status_code == 409 and late.json()["error"]["code"] == "poll_closed"

    # Multiple choice keeps every vote.
    as_user(alice)
    multi = (await _poll(client, channel["id"], multiple=True)).json()
    await client.put(f"/api/v1/messages/{multi['id']}/poll/votes/0")
    both = await client.put(f"/api/v1/messages/{multi['id']}/poll/votes/1")
    assert both.json()["poll"]["votes"] == [[str(alice.id)], [str(alice.id)], []]
