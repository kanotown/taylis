"""L8: the Times feed and is:times (docs/TIMES_FEED.md)."""

import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.messages.models import Message
from app.modules.search.query import parse_query
from app.modules.users.models import User
from tests.helpers import make_user


async def _post(client: AsyncClient, channel_id: str, body: str, **extra: Any) -> dict[str, Any]:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body, **extra},
    )
    assert response.status_code == 201, response.text
    return dict(response.json())


async def _times(client: AsyncClient) -> str:
    return str((await client.post("/api/v1/times")).json()["id"])


async def _feed(client: AsyncClient, **params: Any) -> dict[str, Any]:
    response = await client.get("/api/v1/times/feed", params=params)
    assert response.status_code == 200, response.text
    return dict(response.json())


def _bodies(page: dict[str, Any]) -> list[str]:
    return [m["body"] for m in page["items"]]


async def test_the_feed_has_the_timeline_of_the_times_i_follow_newest_first(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(bob)
    bobs = await _times(client)
    as_user(carol)
    carols = await _times(client)  # alice does not follow it
    await _post(client, carols, "carol の実験")
    as_user(alice)
    alices = await _times(client)
    assert (await _feed(client)) == {"items": [], "next_cursor": None}
    await client.post(f"/api/v1/channels/{bobs}/join")
    plain = (await client.post("/api/v1/channels", json={"name": "general"})).json()["id"]
    await _post(client, plain, "ふつうのチャンネル")

    as_user(bob)
    first = await _post(client, bobs, "実験の準備")
    await _post(client, bobs, "スレッドだけの返信", parent_id=first["id"])
    await _post(client, bobs, "チャンネルにも", parent_id=first["id"], also_in_channel=True)
    gone = await _post(client, bobs, "消す")
    assert (await client.delete(f"/api/v1/messages/{gone['id']}")).status_code in (200, 204)
    as_user(alice)
    await _post(client, alices, "自分の times")

    page = await _feed(client)
    assert _bodies(page) == ["自分の times", "チャンネルにも", "実験の準備"]
    assert page["next_cursor"] is None
    assert all(m["type"] == "user" for m in page["items"])
    assert page["items"][2]["reply_count"] == 2

    # Muted times leave the feed; all-read with scope times reads only the feed's channels.
    await client.put(
        f"/api/v1/channels/{bobs}/notification-preference", json={"level": None, "muted": True}
    )
    assert _bodies(await _feed(client)) == ["自分の times"]
    as_user(bob)
    await _post(client, bobs, "ミュート中")
    as_user(alice)
    await client.put(
        f"/api/v1/channels/{bobs}/notification-preference", json={"level": None, "muted": False}
    )
    as_user(carol)
    await client.post(f"/api/v1/channels/{plain}/join")
    await _post(client, plain, "general の新着")
    as_user(alice)
    states = (await client.post("/api/v1/channels/read-all", json={"scope": "times"})).json()
    assert {s["channel_id"] for s in states} == {alices, bobs}
    assert all(s["unread_count"] == 0 for s in states)
    # general (carol's new post) is untouched: still unread.
    assert (await client.get("/api/v1/sync/summary")).json()["has_unread"] is True
    everything = (await client.post("/api/v1/channels/read-all")).json()
    assert {s["channel_id"] for s in everything} == {alices, bobs, plain}


async def test_archived_times_stay_and_guests_see_only_their_times(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    guest = await make_user(db, "guest", role="guest")
    as_user(alice)
    alices = await _times(client)
    await _post(client, alices, "卒業前の記録")
    await client.post(f"/api/v1/channels/{alices}/members", json={"user_id": str(guest.id)})
    as_user(root)
    rootc = await _times(client)
    await _post(client, rootc, "root の記録")
    await client.post(f"/api/v1/channels/{alices}/join")
    assert (await client.post(f"/api/v1/channels/{alices}/archive")).status_code == 200
    assert _bodies(await _feed(client)) == ["root の記録", "卒業前の記録"]
    as_user(guest)
    assert _bodies(await _feed(client)) == ["卒業前の記録"]


async def test_the_cursor_splits_rows_of_the_same_time_without_gaps_or_repeats(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(bob)
    bobs = await _times(client)
    as_user(alice)
    alices = await _times(client)
    await client.post(f"/api/v1/channels/{bobs}/join")
    posted = []
    for i in range(5):
        posted.append((await _post(client, alices, f"a{i}"))["id"])
        as_user(bob)
        posted.append((await _post(client, bobs, f"b{i}"))["id"])
        as_user(alice)
    # An import can give many rows the same instant.
    same = datetime(2026, 10, 1, 9, 0, tzinfo=UTC)
    await db.execute(update(Message).where(Message.id.in_(posted[2:8])).values(created_at=same))
    await db.commit()

    seen: list[str] = []
    cursor = None
    for _ in range(10):
        page = await _feed(client, limit=3, **({"cursor": cursor} if cursor else {}))
        seen.extend(m["id"] for m in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert sorted(seen) == sorted(posted) and len(seen) == len(set(seen))
    rows = (
        await db.execute(select(Message.id, Message.created_at).where(Message.id.in_(seen)))
    ).all()
    at = {row.id: row.created_at for row in rows}
    expected = sorted(seen, key=lambda i: (at[uuid.UUID(i)], uuid.UUID(i)), reverse=True)
    assert seen == expected
    assert (await client.get("/api/v1/times/feed", params={"cursor": "nope"})).status_code == 400


async def _search(client: AsyncClient, q: str, **params: Any) -> dict[str, Any]:
    response = await client.get("/api/v1/search/messages", params={"q": q, **params})
    assert response.status_code == 200, response.text
    return dict(response.json())


async def test_is_times_searches_times_including_public_ones_not_joined(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    guest = await make_user(db, "guest", role="guest")
    as_user(bob)
    bobs = await _times(client)
    await _post(client, bobs, "装置の校正メモ")
    assert (await client.post(f"/api/v1/channels/{bobs}/archive")).status_code == 200
    as_user(carol)
    secret = (
        await client.post(
            "/api/v1/channels", json={"name": "times-carol-private", "type": "private"}
        )
    ).json()["id"]
    await _post(client, secret, "非公開の校正メモ")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()["id"]
    await _post(client, general, "general の校正メモ")
    await client.post(f"/api/v1/channels/{general}/members", json={"user_id": str(guest.id)})

    # Without is:times my channels and the public ones (bob's archived times too); with it only
    # times, the archived public one included.
    assert sorted(h["message"]["body"] for h in (await _search(client, "校正"))["hits"]) == [
        "general の校正メモ",
        "装置の校正メモ",
    ]
    found = await _search(client, "校正 is:times")
    assert [h["message"]["body"] for h in found["hits"]] == ["装置の校正メモ"]
    assert found["filters"]["is_times"] is True and found["filters"]["text"] == "校正"
    assert [c["id"] for c in found["channels"]] == [bobs]
    assert found["channels"][0]["membership"] is None
    assert (await _search(client, "校正", is_times="true"))["channels"][0]["id"] == bobs
    # in: names a times in range; a channel that is not a times is unresolved.
    named = await _search(client, "校正 is:times in:#times-bob")
    assert [h["message"]["body"] for h in named["hits"]] == ["装置の校正メモ"]
    other = await _search(client, "校正 is:times in:#general")
    assert other["hits"] == [] and other["filters"]["unresolved"] == ["in:#general"]
    assert (await _search(client, "校正", is_times="true", channel_id=general))["hits"] == []

    as_user(guest)
    assert (await _search(client, "校正 is:times"))["hits"] == []
    # Canvases have no is:times: said back as not understood.
    canvases = await client.get("/api/v1/search/canvases", params={"q": "校正 is:times"})
    assert canvases.json()["filters"]["unresolved"] == ["is:times"]


def test_is_times_is_parsed_with_its_alias() -> None:
    for q in ("実験 is:times", "is:TIME 実験"):
        parsed = parse_query(q)
        assert parsed.is_times and not parsed.is_thread and parsed.text == "実験"
    both = parse_query("is:times is:thread")
    assert both.is_times and both.is_thread and both.has_modifiers
