"""Keyword notifications (M12g): a keyword in a body counts as a mention of its owner."""

import uuid
from collections.abc import Callable

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.helpers import make_user


async def _post(client: AsyncClient, channel_id: str, body: str) -> dict:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body},
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _mention_count(client: AsyncClient, channel_id: str) -> int:
    booted = (await client.get("/api/v1/sync/bootstrap")).json()
    return next(c for c in booted["channels"] if c["id"] == channel_id)["read_state"][
        "mention_count"
    ]


async def test_keywords_count_as_mentions_for_members_only(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    as_user(bob)
    await client.post(f"/api/v1/channels/{general['id']}/join")
    saved = await client.patch(
        "/api/v1/users/me", json={"notify_keywords": [" ボブ ", "Deploy", "deploy", "", "ボブ"]}
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["notify_keywords"] == ["ボブ", "Deploy"]
    too_many = await client.patch(
        "/api/v1/users/me", json={"notify_keywords": [f"k{i}" for i in range(21)]}
    )
    assert too_many.status_code == 422
    assert (
        await client.patch("/api/v1/users/me", json={"notify_keywords": ["x" * 41]})
    ).status_code == 422
    as_user(carol)
    assert (
        await client.patch("/api/v1/users/me", json={"notify_keywords": ["ボブ"]})
    ).status_code == 200

    # Alice's message mentions bob by keyword (case-insensitive), not carol (not a member).
    as_user(alice)
    hit = await _post(client, general["id"], "ボブさん、DEPLOY 手順を確認してください")
    assert hit["mentioned_user_ids"] == [str(bob.id)]
    miss = await _post(client, general["id"], "関係ない話")
    assert miss["mentioned_user_ids"] == []
    as_user(bob)
    assert await _mention_count(client, general["id"]) == 1
    listed = (await client.get("/api/v1/mentions")).json()
    assert [m["id"] for m in listed["items"]] == [hit["id"]]
    # Bob's own keyword in his own message is not a self-mention.
    own = await _post(client, general["id"], "ボブです")
    assert own["mentioned_user_ids"] == []

    # Editing re-evaluates: the keyword goes away, so does the mention; a real mention stays.
    as_user(alice)
    edited = await client.patch(
        f"/api/v1/messages/{hit['id']}", json={"body": "手順を確認してください"}
    )
    assert edited.status_code == 200 and edited.json()["mentioned_user_ids"] == []
    both = await client.patch(
        f"/api/v1/messages/{hit['id']}", json={"body": f"<@{bob.id}> deploy お願いします"}
    )
    assert both.json()["mentioned_user_ids"] == [str(bob.id)]
    as_user(bob)
    cleared = await client.patch("/api/v1/users/me", json={"notify_keywords": []})
    assert cleared.json()["notify_keywords"] == []
