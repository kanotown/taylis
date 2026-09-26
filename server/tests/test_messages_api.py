import uuid
from collections.abc import Callable

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.helpers import make_user


async def test_post_and_read_messages_over_http(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")

    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    base = f"/api/v1/channels/{channel['id']}/messages"

    key = str(uuid.uuid4())
    first = await client.post(base, json={"client_msg_id": key, "body": "hello"})
    assert first.status_code == 201
    assert first.json()["seq"] == 1 and first.json()["client_msg_id"] == key

    replay = await client.post(base, json={"client_msg_id": key, "body": "hello"})
    assert replay.status_code == 200 and replay.json()["id"] == first.json()["id"]

    second = await client.post(base, json={"client_msg_id": str(uuid.uuid4()), "body": "again"})
    assert second.status_code == 201 and second.json()["seq"] == 2

    empty = await client.post(base, json={"client_msg_id": str(uuid.uuid4()), "body": "  "})
    assert empty.status_code == 422 and empty.json()["error"]["code"] == "validation_error"

    history = await client.get(base, params={"limit": 1})
    assert history.status_code == 200
    body = history.json()
    assert body["channel_last_seq"] == 2 and body["has_more"] is True
    assert [m["seq"] for m in body["messages"]] == [2]

    older = await client.get(base, params={"limit": 1, "before_seq": 2})
    assert [m["seq"] for m in older.json()["messages"]] == [1]
    assert older.json()["has_more"] is False

    single = await client.get(f"/api/v1/messages/{first.json()['id']}")
    assert single.status_code == 200 and single.json()["body"] == "hello"

    as_user(bob)
    denied = await client.post(base, json={"client_msg_id": str(uuid.uuid4()), "body": "hi"})
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "not_a_member"
    denied_read = await client.get(f"/api/v1/messages/{first.json()['id']}")
    assert denied_read.status_code == 403
