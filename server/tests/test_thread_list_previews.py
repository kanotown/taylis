"""GET /threads previews each thread's newest replies (THREADS.md §5, latest_replies)."""

import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

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


async def _items(client: AsyncClient, **params: Any) -> list[dict[str, Any]]:
    response = await client.get("/api/v1/threads", params=params)
    assert response.status_code == 200, response.text
    items: list[dict[str, Any]] = response.json()["items"]
    return items


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


async def test_latest_replies_are_the_newest_two_oldest_first(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice, bob, carol, cid = await _setup(client, db, as_user)
    as_user(alice)
    parent = await _post(client, cid, "topic")
    single = await _post(client, cid, "second topic")
    for i, user in enumerate((bob, carol, bob, carol)):
        as_user(user)
        await _post(client, cid, f"r{i}", parent["id"])
    as_user(bob)
    await _post(client, cid, "only", single["id"])
    reply = await _post(client, cid, "liked", parent["id"])
    as_user(alice)
    assert (await client.put(f"/api/v1/messages/{reply['id']}/reactions/👍")).status_code == 201

    items = await _items(client)
    by_parent = {item["parent"]["id"]: item for item in items}
    main = by_parent[parent["id"]]
    assert [m["body"] for m in main["latest_replies"]] == ["r3", "liked"]
    assert main["state"]["reply_count"] == 5
    assert all(m["parent_id"] == parent["id"] for m in main["latest_replies"])
    # The same MessageOut as the thread view (reactions filled in).
    assert main["latest_replies"][1]["reactions"][0]["emoji"] == "👍"
    assert main["latest_replies"][0]["sender_id"] == str(carol.id)
    assert [m["body"] for m in by_parent[single["id"]]["latest_replies"]] == ["only"]


async def test_latest_replies_skip_deleted_and_blocked(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice, bob, carol, cid = await _setup(client, db, as_user)
    as_user(alice)
    parent = await _post(client, cid, "topic")
    as_user(bob)
    await _post(client, cid, "bob 1", parent["id"])
    as_user(carol)
    await _post(client, cid, "carol 1", parent["id"])
    as_user(bob)
    await _post(client, cid, "bob 2", parent["id"])
    as_user(carol)
    gone = await _post(client, cid, "carol 2", parent["id"])
    assert (await client.delete(f"/api/v1/messages/{gone['id']}")).status_code == 200

    as_user(alice)
    (item,) = await _items(client)
    assert [m["body"] for m in item["latest_replies"]] == ["carol 1", "bob 2"]
    assert item["state"]["reply_count"] == 3

    assert (await client.put(f"/api/v1/users/{bob.id}/block")).status_code == 201
    (item,) = await _items(client)
    # Bob's replies drop out of the preview; the count still has every live reply.
    assert [m["body"] for m in item["latest_replies"]] == ["carol 1"]
    assert item["state"]["reply_count"] == 3
    # Only the blocker's view changes.
    as_user(carol)
    (item,) = await _items(client)
    assert [m["body"] for m in item["latest_replies"]] == ["carol 1", "bob 2"]


async def test_a_page_of_threads_costs_a_bounded_number_of_queries(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice, bob, carol, cid = await _setup(client, db, as_user)

    async def add_threads(n: int) -> None:
        for _ in range(n):
            as_user(alice)
            parent = await _post(client, cid, "topic")
            for user in (bob, carol, bob):
                as_user(user)
                await _post(client, cid, "r", parent["id"])

    async def list_queries(expected: int) -> int:
        as_user(alice)
        with _counting(app) as statements:
            items = await _items(client, limit=50)
        assert len(items) == expected
        assert all(len(item["latest_replies"]) == 2 for item in items)
        return len(statements)

    await add_threads(2)
    few = await list_queries(2)
    await add_threads(18)
    many = await list_queries(20)
    assert many == few, (few, many)
