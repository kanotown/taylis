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
        "anonymous": False,
        "closed_at": None,
        "votes": [[], [], []],
        "counts": [0, 0, 0],
        "mine": [],
        # M53: a choice poll leaves the scheduling fields empty.
        "kind": "choice",
        "slots": [],
        "tz": None,
        "decided": None,
        "answers": [],
        "respondents": [],
        "comments": [],
        "my_answers": None,
        "my_comment": None,
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

    # Only the author closes, not an admin either; a closed poll takes no votes.
    denied = await client.post(f"/api/v1/messages/{message['id']}/poll/close")
    assert denied.status_code == 403
    as_user(root)
    admin = await client.post(f"/api/v1/messages/{message['id']}/poll/close")
    assert admin.status_code == 403
    as_user(alice)
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


async def test_anonymous_poll_names_nobody_but_tells_each_voter_their_own(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """M27: an anonymous poll carries counts, never voter ids; a response to a voter says what
    they voted for (the event, the same for every member, does not)."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "vote"})).json()
    await client.post(f"/api/v1/channels/{channel['id']}/members", json={"user_id": str(bob.id)})
    poll = (await _poll(client, channel["id"], anonymous=True, multiple=True)).json()
    assert poll["poll"]["anonymous"] is True

    as_user(bob)
    voted = (await client.put(f"/api/v1/messages/{poll['id']}/poll/votes/1")).json()["poll"]
    assert voted["votes"] == [[], [], []] and voted["counts"] == [0, 1, 0] and voted["mine"] == [1]
    as_user(alice)
    await client.put(f"/api/v1/messages/{poll['id']}/poll/votes/1")
    mine = (await client.put(f"/api/v1/messages/{poll['id']}/poll/votes/2")).json()["poll"]
    assert mine["counts"] == [0, 2, 1] and mine["mine"] == [1, 2]

    # History, the message itself and the thread of events: counts only; the reader's own votes.
    as_user(bob)
    history = (await client.get(f"/api/v1/channels/{channel['id']}/messages")).json()
    row = next(m for m in history["messages"] if m["id"] == poll["id"])["poll"]
    assert row["votes"] == [[], [], []] and row["counts"] == [0, 2, 1] and row["mine"] == [1]
    single = (await client.get(f"/api/v1/messages/{poll['id']}")).json()["poll"]
    assert single["mine"] == [1]
    events = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "message.updated")))
        .scalars()
        .all()
    )
    for event in events:
        sent = event.payload["message"]["poll"]
        assert sent["votes"] == [[], [], []] and sent["mine"] is None
        assert str(bob.id) not in str(event.payload) and str(alice.id) not in str(sent)


async def test_a_named_poll_says_who_voted_and_what_i_voted_for(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "named"})).json()
    poll = (await _poll(client, channel["id"])).json()
    voted = (await client.put(f"/api/v1/messages/{poll['id']}/poll/votes/0")).json()["poll"]
    assert voted["votes"] == [[str(alice.id)], [], []]
    assert voted["counts"] == [1, 0, 0] and voted["mine"] == [0]
