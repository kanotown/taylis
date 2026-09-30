"""C3 (MOBILE_POLISH.md): a thread parent names who replied (MessageOut.reply_user_ids)."""

import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import event, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.messages import repository as repo
from app.modules.messages.models import Message, with_replier
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


async def _people(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], n: int
) -> tuple[list[User], str]:
    """`n` users in #general (the first created it)."""
    users = [await make_user(db, f"user{i}") for i in range(n)]
    as_user(users[0])
    cid: str = (await client.post("/api/v1/channels", json={"name": "general"})).json()["id"]
    for user in users[1:]:
        as_user(user)
        await client.post(f"/api/v1/channels/{cid}/join")
    return users, cid


async def _repliers(client: AsyncClient, message_id: str) -> list[str]:
    body = (await client.get(f"/api/v1/messages/{message_id}")).json()
    ids: list[str] = body["reply_user_ids"]
    return ids


async def _events(db: AsyncSession, event_type: str) -> list[OutboxEvent]:
    rows = (await db.execute(select(OutboxEvent).order_by(OutboxEvent.id))).scalars()
    return [e for e in rows if e.event_type == event_type]


def test_with_replier_moves_to_the_front_and_keeps_five() -> None:
    a, b, c, d, e, f = (uuid.uuid4() for _ in range(6))
    assert with_replier([], a) == [a]
    assert with_replier([a, b, c], c) == [c, a, b]
    assert with_replier([a, b, c, d, e], f) == [f, a, b, c, d]
    assert with_replier([a, b, c, d, e], e) == [e, a, b, c, d]


async def test_repliers_most_recent_first_distinct_at_most_five(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    users, cid = await _people(client, db, as_user, 7)
    ids = [str(u.id) for u in users]
    as_user(users[0])
    parent = await _post(client, cid, "topic")
    assert parent["reply_user_ids"] == []

    for i in (1, 2, 0, 1):  # the parent's author counts when they reply
        as_user(users[i])
        await _post(client, cid, f"reply by {i}", parent["id"])
    assert await _repliers(client, parent["id"]) == [ids[1], ids[0], ids[2]]

    for i in (3, 4, 5, 6):
        as_user(users[i])
        await _post(client, cid, f"reply by {i}", parent["id"])
    assert await _repliers(client, parent["id"]) == [ids[6], ids[5], ids[4], ids[3], ids[1]]

    # An older replier comes back to the front; the history page carries the same list.
    as_user(users[2])
    await _post(client, cid, "again", parent["id"])
    expected = [ids[2], ids[6], ids[5], ids[4], ids[3]]
    history = (await client.get(f"/api/v1/channels/{cid}/messages")).json()["messages"]
    (row,) = [m for m in history if m["id"] == parent["id"]]
    assert row["reply_user_ids"] == expected and row["reply_count"] == 9
    replies = (await client.get(f"/api/v1/messages/{parent['id']}/replies")).json()
    assert all(r["reply_user_ids"] == [] for r in replies)  # replies are not parents


async def test_deleted_replies_leave_the_list_like_the_count(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    users, cid = await _people(client, db, as_user, 7)
    ids = [str(u.id) for u in users]
    as_user(users[0])
    parent = await _post(client, cid, "topic")
    posted: dict[int, list[str]] = {}
    for i in (2, 1, 1, 3, 4, 5, 6):
        as_user(users[i])
        posted.setdefault(i, []).append((await _post(client, cid, "r", parent["id"]))["id"])
    assert await _repliers(client, parent["id"]) == [ids[6], ids[5], ids[4], ids[3], ids[1]]

    # user1's newer reply goes: their older one still counts, and it is older than user3's.
    as_user(users[1])
    assert (await client.delete(f"/api/v1/messages/{posted[1][1]}")).status_code == 200
    assert await _repliers(client, parent["id"]) == [ids[6], ids[5], ids[4], ids[3], ids[1]]
    # user6's only reply goes: they leave the list, and the sixth replier (user2) comes back in.
    as_user(users[6])
    assert (await client.delete(f"/api/v1/messages/{posted[6][0]}")).status_code == 200
    expected = [ids[5], ids[4], ids[3], ids[1], ids[2]]
    assert await _repliers(client, parent["id"]) == expected
    current = (await client.get(f"/api/v1/messages/{parent['id']}")).json()
    assert current["reply_count"] == 5

    thread = (await _events(db, "message.deleted"))[-1].payload["parent_thread"]
    assert thread["reply_user_ids"] == expected and thread["reply_count"] == 5

    # Every reply gone: an empty list with reply_count 0.
    for i, message_ids in posted.items():
        as_user(users[i])
        for message_id in message_ids:
            await client.delete(f"/api/v1/messages/{message_id}")
    as_user(users[0])
    current = (await client.get(f"/api/v1/messages/{parent['id']}")).json()
    assert current["reply_count"] == 0 and current["reply_user_ids"] == []


async def test_events_and_delta_carry_the_repliers(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    users, cid = await _people(client, db, as_user, 3)
    ids = [str(u.id) for u in users]
    as_user(users[0])
    parent = await _post(client, cid, "topic")
    as_user(users[1])
    await _post(client, cid, "first", parent["id"])
    as_user(users[2])
    await _post(client, cid, "second", parent["id"])

    created = [e for e in await _events(db, "message.created") if e.payload["message"]["parent_id"]]
    assert [e.payload["parent_thread"]["reply_user_ids"] for e in created] == [
        [ids[1]],
        [ids[2], ids[1]],
    ]
    assert created[0].payload["message"]["reply_user_ids"] == []

    # A client that missed the events gets the parent again from delta sync (§4.3).
    delta = (await client.get(f"/api/v1/channels/{cid}/sync", params={"since_seq": 1})).json()
    (row,) = [m for m in delta["messages"] if m["id"] == parent["id"]]
    assert row["reply_user_ids"] == [ids[2], ids[1]]

    # Other changes to the parent (message.updated) carry the list too.
    as_user(users[0])
    reacted = await client.put(f"/api/v1/messages/{parent['id']}/reactions/👍")
    assert reacted.status_code == 201, reacted.text
    updated = (await _events(db, "message.updated"))[-1]
    assert updated.payload["message"]["reply_user_ids"] == [ids[2], ids[1]]


async def test_refresh_recomputes_from_the_rows(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """The bulk rule (the import; migration 0049's backfill) agrees with the reply path."""
    users, cid = await _people(client, db, as_user, 3)
    as_user(users[0])
    parents = [await _post(client, cid, f"topic {n}") for n in range(2)]
    for i in (2, 1, 0, 1):
        as_user(users[i])
        await _post(client, cid, "r", parents[0]["id"])
    as_user(users[2])
    await _post(client, cid, "r", parents[1]["id"])
    as_user(users[0])
    before = [await _repliers(client, p["id"]) for p in parents]
    assert before == [[str(users[1].id), str(users[0].id), str(users[2].id)], [str(users[2].id)]]

    parent_ids = [uuid.UUID(p["id"]) for p in parents]
    await db.execute(update(Message).where(Message.id.in_(parent_ids)).values(reply_user_ids=[]))
    await repo.refresh_reply_user_ids(db, parent_ids)
    await db.commit()
    assert [await _repliers(client, p["id"]) for p in parents] == before


@contextmanager
def _counting(app: FastAPI) -> Iterator[list[str]]:
    statements: list[str] = []
    engine = app.state.db.engine.sync_engine

    def before(_conn: Any, _cursor: Any, statement: str, *_args: Any) -> None:
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", before)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", before)


async def test_history_query_count_does_not_grow_with_thread_parents(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    users, cid = await _people(client, db, as_user, 3)

    async def add_threads(n: int) -> None:
        for _ in range(n):
            as_user(users[0])
            parent = await _post(client, cid, "topic")
            for user in users[1:]:
                as_user(user)
                await _post(client, cid, "r", parent["id"])

    async def history_queries(parents: int) -> int:
        as_user(users[0])
        with _counting(app) as statements:
            response = await client.get(f"/api/v1/channels/{cid}/messages")
        assert response.status_code == 200
        rows = response.json()["messages"]
        assert len(rows) == parents and all(len(m["reply_user_ids"]) == 2 for m in rows)
        return len(statements)

    await add_threads(2)
    few = await history_queries(2)
    await add_threads(6)
    assert await history_queries(8) == few
