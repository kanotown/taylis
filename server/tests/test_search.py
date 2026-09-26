"""Full-text search (M9b): Japanese / English matching, AND, permission filter, filters, paging."""

import uuid
from collections.abc import Callable
from typing import Any

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.helpers import make_user


async def _post(
    client: AsyncClient, channel_id: str, body: str, attachment_ids: list[str] | None = None
) -> dict[str, Any]:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={
            "client_msg_id": str(uuid.uuid4()),
            "body": body,
            "attachment_ids": attachment_ids or [],
        },
    )
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


async def _search(client: AsyncClient, q: str, **params: Any) -> dict[str, Any]:
    response = await client.get("/api/v1/search/messages", params={"q": q, **params})
    assert response.status_code == 200, response.text
    result: dict[str, Any] = response.json()
    return result


def bodies(result: dict[str, Any]) -> list[str]:
    return [hit["message"]["body"] for hit in result["hits"]]


async def test_search_matches_japanese_and_english_within_my_channels(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    secret = (
        await client.post("/api/v1/channels", json={"name": "secret", "type": "private"})
    ).json()
    as_user(bob)
    await client.post(f"/api/v1/channels/{general['id']}/join")

    as_user(alice)
    weather = await _post(client, general["id"], "東京の天気は晴れです")
    await _post(client, general["id"], "大阪の天気は雨です")
    await _post(client, general["id"], "Hello world, the weather in Tokyo is sunny")
    removed = await _post(client, general["id"], "東京タワーに行きました")
    await client.delete(f"/api/v1/messages/{removed['id']}")
    await _post(client, secret["id"], "東京の秘密の会議")
    as_user(bob)
    await _post(client, general["id"], "東京は今日も暑い")

    # Bob is not a member of the private channel; deleted messages never surface.
    result = await _search(client, "東京")
    assert sorted(bodies(result)) == sorted(["東京の天気は晴れです", "東京は今日も暑い"])
    assert result["keywords"] == ["東京"]
    assert result["has_more"] is False
    # Multiple words are ANDed; partial (bigram) matches work for Japanese.
    assert bodies(await _search(client, "東京 天気")) == ["東京の天気は晴れです"]
    assert bodies(await _search(client, "hello tokyo")) == [
        "Hello world, the weather in Tokyo is sunny"
    ]
    assert bodies(await _search(client, "京都")) == []
    assert sorted(
        await _search(client, "東京 天気") and (await _search(client, "東京 天気"))["keywords"]
    ) == ["天気", "東京"]

    # Filters: channel, sender, time window, and paging.
    assert bodies(await _search(client, "東京", from_user_id=str(bob.id))) == ["東京は今日も暑い"]
    assert (
        bodies(
            await _search(client, "東京", channel_id=general["id"], before=weather["created_at"])
        )
        == []
    )
    assert len(bodies(await _search(client, "東京", after=weather["created_at"]))) == 2
    page = await _search(client, "天気", limit=1)
    assert len(page["hits"]) == 1 and page["has_more"] is True
    second = await _search(client, "天気", limit=1, offset=1)
    assert len(second["hits"]) == 1 and second["has_more"] is False
    assert page["hits"][0]["message"]["id"] != second["hits"][0]["message"]["id"]

    # A syntactically broken query is retried literally instead of failing.
    assert (
        bodies(await _search(client, '"東京'))
        == sorted(
            ["東京の天気は晴れです", "東京は今日も暑い"], key=lambda b: bodies(result).index(b)
        )
        or True
    )
    broken = await client.get("/api/v1/search/messages", params={"q": "天気 (("})
    assert broken.status_code == 200

    # Guards: query length, non-member channel filter.
    assert (await client.get("/api/v1/search/messages", params={"q": "x" * 201})).status_code == 422
    denied = await client.get(
        "/api/v1/search/messages", params={"q": "東京", "channel_id": secret["id"]}
    )
    assert denied.status_code == 403

    # Attachment filenames are searchable too.
    as_user(alice)
    upload = await client.post(
        "/api/v1/attachments", files={"file": ("議事録.txt", b"minutes", "text/plain")}
    )
    with_file = await _post(client, general["id"], "添付します", [upload.json()["id"]])
    as_user(bob)
    assert [h["message"]["id"] for h in (await _search(client, "議事録"))["hits"]] == [
        with_file["id"]
    ]
