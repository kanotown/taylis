"""Message search over public channels the caller has not joined, archived ones too (SECURITY.md
§3.2, docs/SEARCH.md): Slack-imported archives have no members, and their messages must still be
found. Guests keep to their own channels; private channels and DMs never widen."""

import statistics
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy import insert, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.channels.models import Channel, ChannelMember
from app.modules.messages.models import Message
from app.modules.users.models import User
from tests.helpers import make_user

API = "/api/v1"


async def _post(client: AsyncClient, channel_id: str, body: str) -> dict[str, Any]:
    response = await client.post(
        f"{API}/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body},
    )
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


async def _get(client: AsyncClient, q: str, **params: Any) -> Any:
    return await client.get(f"{API}/search/messages", params={"q": q, **params})


async def _search(client: AsyncClient, q: str, **params: Any) -> dict[str, Any]:
    response = await _get(client, q, **params)
    assert response.status_code == 200, response.text
    result: dict[str, Any] = response.json()
    return result


def _bodies(result: dict[str, Any]) -> list[str]:
    return sorted(hit["message"]["body"] for hit in result["hits"])


async def _channel(client: AsyncClient, name: str, type: str = "public") -> str:
    response = await client.post(f"{API}/channels", json={"name": name, "type": type})
    assert response.status_code in (200, 201), response.text
    return str(response.json()["id"])


async def _empty_archive(db: AsyncSession, channel_id: str) -> None:
    """As a Slack import leaves it: archived, and nobody is a member."""
    await db.execute(
        update(Channel)
        .where(Channel.id == uuid.UUID(channel_id))
        .values(archived_at=datetime.now(UTC))
    )
    await db.execute(
        ChannelMember.__table__.delete().where(  # type: ignore[attr-defined]
            ChannelMember.channel_id == uuid.UUID(channel_id)
        )
    )
    await db.commit()


async def test_non_guests_search_public_channels_they_have_not_joined_archived_too(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    guest = await make_user(db, "guest", role="guest")
    as_user(bob)
    general = await _channel(client, "general")
    lounge = await _channel(client, "lounge")
    imported = await _channel(client, "old-project")
    secret = await _channel(client, "secret", type="private")
    await client.post(f"{API}/channels/{general}/members", json={"user_id": str(alice.id)})
    await client.post(f"{API}/channels/{general}/members", json={"user_id": str(guest.id)})
    await _post(client, general, "実験の記録 general")
    await _post(client, lounge, "実験の記録 lounge")
    await _post(client, imported, "実験の記録 old-project")
    await _post(client, secret, "実験の記録 secret")
    dm = (await client.post(f"{API}/dms", json={"user_ids": [str(guest.id)]})).json()["id"]
    await _post(client, dm, "実験の記録 dm")
    await _empty_archive(db, imported)

    as_user(alice)
    found = await _search(client, "実験")
    assert _bodies(found) == [
        "実験の記録 general",
        "実験の記録 lounge",
        "実験の記録 old-project",
    ]
    assert found["total"] == 3 and found["filters"]["exclude_archived"] is False
    # The channels of the hits alice is not in: named, without membership, archived said.
    rows = {c["id"]: c for c in found["channels"]}
    assert set(rows) == {lounge, imported}
    assert all(c["membership"] is None for c in rows.values())
    assert rows[imported]["archived"] is True and rows[lounge]["archived"] is False
    assert rows[imported]["name"] == "old-project"

    # in:# and channel_id reach a public channel alice has not joined, archived or not.
    named = await _search(client, "実験 in:#old-project")
    assert _bodies(named) == ["実験の記録 old-project"]
    assert named["filters"]["in_channel"] == "old-project"
    assert _bodies(await _search(client, "実験", channel_id=lounge)) == ["実験の記録 lounge"]
    assert _bodies(await _search(client, "実験", channel_id=imported)) == ["実験の記録 old-project"]
    # Modifiers alone (newest first) cover them too.
    assert _bodies(await _search(client, f"from:@{bob.username}")) == _bodies(found)

    # Leaving the archives out: the joined and the unjoined alike; narrowed to one, nothing.
    active = await _search(client, "実験", exclude_archived="true")
    assert _bodies(active) == ["実験の記録 general", "実験の記録 lounge"]
    assert active["filters"]["exclude_archived"] is True and active["total"] == 2
    assert [c["id"] for c in active["channels"]] == [lounge]
    assert (await _search(client, "実験 in:#old-project", exclude_archived="true"))["hits"] == []
    as_user(bob)
    assert (await client.post(f"{API}/channels/{general}/archive")).status_code == 200
    as_user(alice)
    assert _bodies(await _search(client, "実験", exclude_archived="true")) == ["実験の記録 lounge"]

    # Private channels and DMs alice is not in: never, not even named.
    assert (await _get(client, "実験", channel_id=secret)).status_code == 403
    assert (await _get(client, "実験", channel_id=dm)).status_code == 403
    hidden = await _search(client, "実験 in:#secret")
    assert hidden["hits"] == [] and hidden["filters"]["unresolved"] == ["in:#secret"]

    # A guest: only their own channels; public ones they are not in stay out of reach.
    as_user(guest)
    mine = await _search(client, "実験")
    assert _bodies(mine) == ["実験の記録 dm", "実験の記録 general"]
    assert mine["channels"] == []
    assert (await _get(client, "実験", channel_id=lounge)).status_code == 403
    assert (await _get(client, "実験", channel_id=imported)).status_code == 403
    assert (await _search(client, "実験 in:#old-project"))["filters"]["unresolved"] == [
        "in:#old-project"
    ]


async def test_counts_and_pages_span_joined_and_unjoined_channels(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    mine = await _channel(client, "mine")
    as_user(bob)
    theirs = await _channel(client, "theirs")
    archived = await _channel(client, "archived-one")
    as_user(alice)
    for n in range(4):
        await _post(client, mine, f"議事録 mine {n}")
    as_user(bob)
    for n in range(4):
        await _post(client, theirs, f"議事録 theirs {n}")
        await _post(client, archived, f"議事録 archived {n}")
    await _empty_archive(db, archived)

    as_user(alice)
    seen: list[str] = []
    offset = 0
    while True:
        page = await _search(client, "議事録", limit=5, offset=offset, sort="newest")
        assert page["total"] == 12
        seen.extend(hit["message"]["id"] for hit in page["hits"])
        # Each page names the unjoined channels of its own hits only.
        page_channels = {hit["message"]["channel_id"] for hit in page["hits"]}
        assert {c["id"] for c in page["channels"]} == page_channels - {mine}
        if not page["has_more"]:
            break
        offset += 5
    assert len(seen) == len(set(seen)) == 12
    assert (await _search(client, "議事録", exclude_archived="true"))["total"] == 8


async def test_searching_many_public_channels_stays_fast(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """3,000 messages in 60 channels (30 archived without members, as a Slack import leaves
    them; 20 public ones of someone else's; 10 of the reader's). The search goes through the
    PGroonga index (every hit has a score: the index scores only what it finds) and answers a
    common word, a rare word and modifiers alone in tens of milliseconds (prints with -s)."""
    reader = await make_user(db, "reader")
    other = await make_user(db, "other")
    now = datetime.now(UTC)
    channels: list[dict[str, Any]] = []
    for n in range(60):
        kind = "archived" if n < 30 else "theirs" if n < 50 else "mine"
        channels.append(
            {
                "id": uuid.uuid4(),
                "type": "public",
                "name": f"{kind}-{n}",
                "created_by": other.id,
                "last_seq": 50,
                "archived_at": now if kind == "archived" else None,
            }
        )
    await db.execute(insert(Channel), channels)
    members = [
        {"channel_id": c["id"], "user_id": reader.id if c["name"].startswith("mine") else other.id}
        for c in channels
        if not c["name"].startswith("archived")
    ]
    await db.execute(insert(ChannelMember), members)
    words = ["実験", "装置", "校正", "測定", "解析", "review", "deploy", "meeting"]
    rows: list[dict[str, Any]] = []
    for c_index, c in enumerate(channels):
        for seq in range(1, 51):
            word = words[(c_index + seq) % len(words)]
            rare = " 珍しい語" if (c_index, seq) == (3, 7) else ""
            rows.append(
                {
                    "id": uuid.uuid4(),
                    "channel_id": c["id"],
                    "sender_id": other.id,
                    "seq": seq,
                    "updated_seq": seq,
                    "client_msg_id": uuid.uuid4(),
                    "body": f"{word} のメモ {c_index}-{seq}{rare}",
                    "created_at": now - timedelta(minutes=c_index * 50 + seq),
                }
            )
    for start in range(0, len(rows), 1000):
        await db.execute(insert(Message), rows[start : start + 1000])
    await db.commit()

    def expected(indexes: range) -> int:
        """Messages of `indexes`' channels whose word is 実験 (words[0])."""
        return sum(1 for c in indexes for seq in range(1, 51) if (c + seq) % len(words) == 0)

    as_user(reader)
    timings: dict[str, float] = {}
    for label, q, extra in (
        ("common word", "実験", {}),
        ("common word, newest", "実験", {"sort": "newest"}),
        ("rare word", "珍しい語", {}),
        ("modifiers only", f"from:@{other.username}", {}),
        ("without archives", "実験", {"exclude_archived": "true"}),
    ):
        await _search(client, q, **extra)  # warm up
        runs = []
        for _ in range(5):
            started = time.perf_counter()
            result = await _search(client, q, **extra)
            runs.append((time.perf_counter() - started) * 1000)
        timings[label] = statistics.median(runs)
        if label == "common word":
            assert result["total"] == expected(range(60)) and len(result["hits"]) == 20
            assert all(hit["score"] > 0 for hit in result["hits"])
            assert any(c["archived"] for c in result["channels"])
        if label == "rare word":
            assert [h["message"]["body"] for h in result["hits"]] == [
                f"{words[(3 + 7) % len(words)]} のメモ 3-7 珍しい語"
            ]
            assert result["hits"][0]["score"] > 0
        if label == "without archives":
            assert result["total"] == expected(range(30, 60))
    # The same search over the reader's own 10 channels only (the preview off), for comparison.
    await db.execute(text("UPDATE workspace_settings SET preview_before_join = false"))
    await db.commit()
    own = await _search(client, "実験")
    assert own["total"] == expected(range(50, 60)) and own["channels"] == []
    runs = []
    for _ in range(5):
        started = time.perf_counter()
        await _search(client, "実験")
        runs.append((time.perf_counter() - started) * 1000)
    timings["own channels only"] = statistics.median(runs)
    print("\nsearch over 60 channels / 3,000 messages (median ms):", timings)
    assert max(timings.values()) < 500
