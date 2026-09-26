"""Recent mentions (M11h) and channel member counts."""

import uuid
from collections.abc import Callable
from typing import Any

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.helpers import make_user


async def _post(client: AsyncClient, channel_id: str, body: str) -> dict[str, Any]:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body},
    )
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


async def test_recent_mentions_and_member_counts(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    secret = (
        await client.post("/api/v1/channels", json={"name": "secret", "type": "private"})
    ).json()
    as_user(bob)
    await client.post(f"/api/v1/channels/{general['id']}/join")

    as_user(alice)
    direct = await _post(client, general["id"], f"<@{bob.id}> look at this")
    everyone = await _post(client, general["id"], "<!channel> standup in 5")
    await _post(client, general["id"], "no mention here")
    await _post(client, secret["id"], f"<@{bob.id}> bob cannot see this")  # bob is not a member
    as_user(bob)
    await _post(client, general["id"], f"<@{bob.id}> mentioning myself does not count")

    listed = (await client.get("/api/v1/mentions")).json()
    assert [m["id"] for m in listed["items"]] == [everyone["id"], direct["id"]]
    page = (await client.get("/api/v1/mentions", params={"limit": 1})).json()
    assert [m["id"] for m in page["items"]] == [everyone["id"]]
    rest = (
        await client.get("/api/v1/mentions", params={"limit": 1, "cursor": page["next_cursor"]})
    ).json()
    assert [m["id"] for m in rest["items"]] == [direct["id"]]
    as_user(carol)
    assert (await client.get("/api/v1/mentions")).json()["items"] == []

    # Member counts come with the channel list (mine and browsable) and with a single channel.
    as_user(carol)
    browse = (await client.get("/api/v1/channels", params={"include": "public"})).json()
    listed_general = next(c for c in browse if c["id"] == general["id"])
    assert listed_general["member_count"] == 2 and listed_general["membership"] is None
    as_user(alice)
    mine = (await client.get("/api/v1/channels")).json()
    assert {c["name"]: c["member_count"] for c in mine} == {"general": 2, "secret": 1}
    single = (await client.get(f"/api/v1/channels/{general['id']}")).json()
    assert single["member_count"] == 2
