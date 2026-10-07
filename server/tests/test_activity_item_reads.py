"""2026-10-07 (MOBILE_UI.md §6.4): activity items stay unread until opened one by one
(PUT /activity/items/read), read in their conversation (mentions, thread replies), marked read all
at once (PUT /activity/read) or done (reservation to-dos). Looking at the list reads nothing."""

import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.activity.models import ActivityItemRead
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_canvas_phase2 import _add, _canvas, _channel, _save
from tests.wiki_helpers import create_page, save, set_access

API = "/api/v1"
Actor = Callable[[User], None]
ALL = {"include": ["canvas_mention", "reservation", "page_mention", "page_shared"]}


async def _post(client: AsyncClient, channel_id: str, body: str, **extra: Any) -> Any:
    payload = {"client_msg_id": str(uuid.uuid4()), "body": body, **extra}
    response = await client.post(f"{API}/channels/{channel_id}/messages", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _feed(client: AsyncClient) -> dict[str, dict[str, Any]]:
    """The items by id."""
    items = (await client.get(f"{API}/activity", params=ALL)).json()["items"]
    return {i["id"]: i for i in items}


async def _count(client: AsyncClient) -> int:
    return int((await client.get(f"{API}/activity/summary", params=ALL)).json()["unread_count"])


async def _open(client: AsyncClient, *ids: str) -> dict[str, Any]:
    r = await client.put(f"{API}/activity/items/read", params=ALL, json={"item_ids": list(ids)})
    assert r.status_code == 200, r.text
    return dict(r.json())


async def _rows(db: AsyncSession, user: User) -> int:
    return int(
        await db.scalar(
            select(func.count())
            .select_from(ActivityItemRead)
            .where(ActivityItemRead.user_id == user.id)
        )
        or 0
    )


async def _back_an_hour(db: AsyncSession) -> None:
    await db.execute(update(User).values(activity_read_at=utcnow() - timedelta(hours=1)))
    await db.commit()


async def test_message_items_are_read_when_opened_and_only_for_me(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    await _back_an_hour(db)
    as_user(alice)
    general = (await client.post(f"{API}/channels", json={"name": "general"})).json()
    secret = (await client.post(f"{API}/channels", json={"name": "s", "type": "private"})).json()
    hidden = await _post(client, secret["id"], "only mine")
    mine = await _post(client, general["id"], "my plan")
    for other in (bob, carol):
        as_user(other)
        await client.post(f"{API}/channels/{general['id']}/join")
    as_user(bob)
    await client.put(f"{API}/messages/{mine['id']}/reactions/👍")
    mention = await _post(client, general["id"], f"<@{alice.id}> <@{carol.id}> look")
    reply = await _post(client, general["id"], "a reply", parent_id=mine["id"])
    await db.execute(delete(OutboxEvent))
    await db.commit()

    as_user(alice)
    feed = await _feed(client)
    assert {(i["kind"], i["id"]) for i in feed.values()} == {
        ("mention", mention["id"]),
        ("thread_reply", reply["id"]),
        ("reaction", mine["id"]),
    }
    assert {i["read"] for i in feed.values()} == {False}
    # Looking (the list, the summary, again) reads nothing.
    assert await _count(client) == 3
    assert {i["read"] for i in (await _feed(client)).values()} == {False}

    # Opening the mention: read in the feed and gone from the badge; the others stay.
    summary = await _open(client, mention["id"])
    assert summary["unread_count"] == 2 and summary["mention_unread"] is False
    feed = await _feed(client)
    assert feed[mention["id"]]["read"] is True
    assert feed[reply["id"]]["read"] is False and feed[mine["id"]]["read"] is False
    # Twice is the same (idempotent).
    assert (await _open(client, mention["id"]))["unread_count"] == 2
    # My other devices hear which items (audience: me only).
    items_read = select(OutboxEvent).where(OutboxEvent.event_type == "activity.items_read")
    sent = (await db.execute(items_read)).scalars().all()
    assert sent and all(e.audience_type == "user" and e.audience_id == alice.id for e in sent)
    assert sent[0].payload["item_ids"] == [mention["id"]] and sent[0].payload["read_at"]

    # The reply and the reaction item; ids that are not my items are ignored and not stored.
    summary = await _open(client, reply["id"], mine["id"], hidden["id"], str(uuid.uuid4()))
    assert summary["unread_count"] == 0
    assert await _rows(db, alice) == 4  # mention, reply, reaction, and my own message (hidden)
    as_user(bob)
    assert (await _open(client, hidden["id"]))["unread_count"] == 0
    assert await _rows(db, bob) == 0  # not in a conversation of his

    # Carol was mentioned too: her item is still unread.
    as_user(carol)
    assert await _count(client) == 1
    assert [i["read"] for i in (await _feed(client)).values()] == [False]

    # A later reaction makes the reaction item unread again (it happened again).
    await client.put(f"{API}/messages/{mine['id']}/reactions/🎉")
    as_user(alice)
    feed = await _feed(client)
    assert feed[mine["id"]]["read"] is False and feed[mention["id"]]["read"] is True
    assert await _count(client) == 1

    # An empty list is refused.
    bad = await client.put(f"{API}/activity/items/read", json={"item_ids": []})
    assert bad.status_code == 422


async def test_mark_all_reads_everything_and_purges_the_rows(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await _back_an_hour(db)
    as_user(alice)
    general = (await client.post(f"{API}/channels", json={"name": "general"})).json()
    as_user(bob)
    await client.post(f"{API}/channels/{general['id']}/join")
    first = await _post(client, general["id"], f"<@{alice.id}> one")
    await _post(client, general["id"], f"<@{alice.id}> two")
    await _post(client, general["id"], f"<@{bob.id}> self")
    as_user(alice)
    await _open(client, first["id"])
    assert await _rows(db, alice) == 1 and await _count(client) == 1

    read = await client.put(
        f"{API}/activity/read", params=ALL, json={"read_at": utcnow().isoformat()}
    )
    assert read.status_code == 200 and read.json()["unread_count"] == 0
    assert await _rows(db, alice) == 0
    assert {i["read"] for i in (await _feed(client)).values()} == {True}
    assert (
        await db.scalar(
            select(func.count())
            .select_from(OutboxEvent)
            .where(OutboxEvent.event_type == "activity.read")
        )
    ) == 1


async def test_canvas_page_and_reservation_items_are_read_when_opened(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    op = await make_user(db, "op")
    op2 = await make_user(db, "op2")
    admin = await make_user(db, "boss", role="admin")
    await _back_an_hour(db)

    # A canvas mention.
    as_user(alice)
    cid = await _channel(client, "lab")
    await _add(client, cid, bob, carol)
    canvas = await _canvas(client, cid, f"# 予定\n<@{bob.id}> と <@{carol.id}>\n")
    # A Docs page mention.
    page = await create_page(client, title="Plan", access_="private")
    await set_access(
        client, page["id"], [("user", str(alice.id), "full"), ("user", str(bob.id), "view")]
    )
    page = (await client.get(f"{API}/wiki/pages/{page['id']}")).json()
    assert (await save(client, page, f"ask <@{bob.id}>")).status_code == 200

    as_user(bob)
    feed = await _feed(client)
    kinds = {i["kind"]: i for i in feed.values()}
    assert set(kinds) == {"canvas_mention", "page_mention", "page_shared"}
    assert all(i["id"] == (i["canvas"] or i["page"])["item_id"] for i in feed.values())
    assert await _count(client) == 3
    summary = await _open(client, kinds["canvas_mention"]["id"], kinds["page_mention"]["id"])
    assert summary["unread_count"] == 1 and summary["mention_unread"] is True
    feed = await _feed(client)
    assert feed[kinds["canvas_mention"]["id"]]["read"] is True
    assert feed[kinds["page_mention"]["id"]]["read"] is True
    assert feed[kinds["page_shared"]["id"]]["read"] is False
    as_user(carol)
    assert await _count(client) == 1  # her canvas mention is hers to open

    # Mentioned again after opening: a new item (the opened one is read and stays).
    as_user(alice)
    await _save(client, canvas, "なし")
    await _save(client, canvas, f"<@{bob.id}> 再び")
    as_user(bob)
    canvas_items = [i for i in (await _feed(client)).values() if i["kind"] == "canvas_mention"]
    assert sorted(i["read"] for i in canvas_items) == [False, True]
    assert await _count(client) == 2

    # A reservation to-do: the operator who opens it has read it; the other operator not.
    as_user(admin)
    made = await client.post(
        f"{API}/reservation-pools",
        json={"name": "Seat", "capacity": 1, "operator_ids": [str(op.id), str(op2.id)]},
    )
    assert made.status_code == 201, made.text
    as_user(alice)
    assert (await client.post(f"{API}/reservation-pools/{made.json()['id']}/reserve")).is_success
    as_user(op)
    todo = next(i for i in (await _feed(client)).values() if i["kind"] == "reservation")
    assert todo["id"] == todo["reservation"]["item_id"] and todo["read"] is False
    assert (await _open(client, todo["id"]))["unread_count"] == 0
    assert (await _feed(client))[todo["id"]]["read"] is True
    as_user(op2)
    assert await _count(client) == 1
