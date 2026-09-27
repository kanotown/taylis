"""Bootstrap and delta endpoints (SYNC_PROTOCOL.md §4)."""

import uuid
from collections.abc import Callable

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.helpers import make_user


async def _post(client: AsyncClient, channel_id: str, body: str) -> dict[str, object]:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body},
    )
    assert response.status_code == 201, response.text
    data: dict[str, object] = response.json()
    return data


async def test_bootstrap_lists_users_and_my_channels(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    await _post(client, general["id"], "hi")
    as_user(bob)
    (await client.post("/api/v1/channels", json={"type": "private", "name": "bobs"})).json()

    as_user(alice)
    response = await client.get("/api/v1/sync/bootstrap")
    assert response.status_code == 200
    body = response.json()
    assert body["me"]["username"] == "alice"
    assert [u["username"] for u in body["users"]] == ["alice", "bob"]
    assert [c["name"] for c in body["channels"]] == ["general"]  # only my channels
    assert body["channels"][0]["last_seq"] == 1
    assert body["channels"][0]["membership"]["role"] == "owner"
    assert body["limits"]["max_message_length"] == 20000
    assert body["server_time"].endswith("Z") or "+" in body["server_time"]


async def test_delta_cursor_semantics(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    for i in range(5):
        await _post(client, channel["id"], f"m{i + 1}")
    base = f"/api/v1/channels/{channel['id']}/sync"

    page = (await client.get(base, params={"since_seq": 0, "limit": 2})).json()
    assert [m["seq"] for m in page["messages"]] == [1, 2]
    assert page["has_more"] is True and page["next_since_seq"] == 2

    page = (await client.get(base, params={"since_seq": 2, "limit": 2})).json()
    assert [m["seq"] for m in page["messages"]] == [3, 4]
    assert page["has_more"] is True and page["next_since_seq"] == 4

    page = (await client.get(base, params={"since_seq": 4, "limit": 2})).json()
    assert [m["seq"] for m in page["messages"]] == [5]
    assert page["has_more"] is False and page["next_since_seq"] == 5

    page = (await client.get(base, params={"since_seq": 5})).json()
    assert page["messages"] == [] and page["next_since_seq"] == 5

    assert (await client.get(base)).json()["messages"][0]["seq"] == 1  # defaults: since 0

    as_user(bob)
    denied = await client.get(base)
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "not_a_member"


async def test_unread_summary_follows_the_badge_rules(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """GET /sync/summary (WORKSPACES.md §6): the switcher badge for a workspace not open."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    as_user(bob)
    await client.post(f"/api/v1/channels/{general['id']}/join")
    assert (await client.get("/api/v1/sync/summary")).json() == {"badge": 0, "has_unread": False}

    as_user(alice)
    await _post(client, general["id"], "plain")  # unread, but no badge in a channel
    as_user(bob)
    assert (await client.get("/api/v1/sync/summary")).json() == {"badge": 0, "has_unread": True}

    as_user(alice)
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})).json()
    await _post(client, dm["id"], "one")
    await _post(client, dm["id"], "two")  # every DM message counts
    await _post(client, general["id"], f"<@{bob.id}> look")  # a channel counts mentions
    as_user(bob)
    assert (await client.get("/api/v1/sync/summary")).json() == {"badge": 3, "has_unread": True}

    # A muted conversation only counts mentions: the DM drops out, the channel mention stays.
    muted = {"level": "none"}
    await client.put(f"/api/v1/channels/{dm['id']}/notification-preference", json=muted)
    assert (await client.get("/api/v1/sync/summary")).json() == {"badge": 1, "has_unread": True}

    await client.put(f"/api/v1/channels/{general['id']}/read", json={"last_read_seq": 10})
    assert (await client.get("/api/v1/sync/summary")).json() == {"badge": 0, "has_unread": False}
