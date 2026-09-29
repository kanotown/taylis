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
    # M27: a public channel is read before joining (its preview, Slack); see test_preview_*.
    preview = await client.get(f"/api/v1/messages/{first.json()['id']}")
    assert preview.status_code == 200


async def test_preview_reads_a_public_channel_but_changes_nothing(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """M27: anyone but a guest reads a public channel before joining; a private channel stays
    closed, and only members post, react, vote or move a read position."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    guest = await make_user(db, "visitor", role="guest")
    as_user(alice)
    public = (await client.post("/api/v1/channels", json={"name": "open"})).json()
    private = (
        await client.post("/api/v1/channels", json={"name": "closed", "type": "private"})
    ).json()
    posts = {}
    for channel in (public, private):
        posts[channel["id"]] = (
            await client.post(
                f"/api/v1/channels/{channel['id']}/messages",
                json={"client_msg_id": str(uuid.uuid4()), "body": "hello"},
            )
        ).json()
    parent = posts[public["id"]]
    await client.post(
        f"/api/v1/channels/{public['id']}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": "reply", "parent_id": parent["id"]},
    )

    as_user(bob)
    history = await client.get(f"/api/v1/channels/{public['id']}/messages")
    assert history.status_code == 200 and [m["body"] for m in history.json()["messages"]] == [
        "hello"
    ]
    delta = await client.get(f"/api/v1/channels/{public['id']}/sync", params={"since_seq": 0})
    assert delta.status_code == 200
    replies = await client.get(f"/api/v1/messages/{parent['id']}/replies")
    assert replies.status_code == 200 and [m["body"] for m in replies.json()] == ["reply"]
    for path in (
        f"/api/v1/channels/{private['id']}/messages",
        f"/api/v1/messages/{posts[private['id']]['id']}",
    ):
        assert (await client.get(path)).status_code == 403
    react = await client.put(f"/api/v1/messages/{parent['id']}/reactions/👍")
    assert react.status_code == 403
    read = await client.put(f"/api/v1/channels/{public['id']}/read", json={"last_read_seq": 1})
    assert read.status_code == 403

    as_user(guest)
    assert (await client.get(f"/api/v1/channels/{public['id']}/messages")).status_code == 403
