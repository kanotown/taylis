"""Links pinned to the top of a conversation (M15f)."""

from collections.abc import Callable

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.channel_links import service as links_service
from app.modules.users.models import User
from tests.helpers import make_user


async def test_channel_links(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    outsider = await make_user(db, "outsider")
    guest = await make_user(db, "guest", role="guest")
    as_user(alice)
    cid = (await client.post("/api/v1/channels", json={"name": "design"})).json()["id"]
    for user in (bob, guest):
        await client.post(f"/api/v1/channels/{cid}/members", json={"user_id": str(user.id)})
    base = f"/api/v1/channels/{cid}/links"

    first = await client.post(
        base, json={"title": " デザイン  資料 ", "url": "https://example.com/figma"}
    )
    assert first.status_code == 201
    assert [(link["title"], link["position"]) for link in first.json()] == [("デザイン 資料", 0)]
    as_user(bob)
    both = (
        await client.post(base, json={"title": "ダッシュボード", "url": "http://grafana.local/d/1"})
    ).json()
    assert [link["title"] for link in both] == ["デザイン 資料", "ダッシュボード"]

    # Only http(s); titles and URLs are validated.
    for bad in (
        "javascript:alert(1)",
        "data:text/html,x",
        "ftp://example.com",
        "https://",
        "https://a b",
    ):
        assert (await client.post(base, json={"title": "x", "url": bad})).status_code == 422
    assert (
        await client.post(base, json={"title": "   ", "url": "https://example.com"})
    ).status_code == 422

    # Move, rename, delete.
    dashboard = both[1]["id"]
    moved = (
        await client.patch(f"{base}/{dashboard}", json={"position": 0, "title": "監視"})
    ).json()
    assert [(link["title"], link["position"]) for link in moved] == [
        ("監視", 0),
        ("デザイン 資料", 1),
    ]
    left = (await client.delete(f"{base}/{dashboard}")).json()
    assert [(link["title"], link["position"]) for link in left] == [("デザイン 資料", 0)]
    assert (await client.delete(f"{base}/{dashboard}")).status_code == 404

    # Members read; outsiders cannot; guests read but do not edit.
    as_user(outsider)
    assert (await client.get(base)).status_code == 403
    as_user(guest)
    assert len((await client.get(base)).json()) == 1
    assert (
        await client.post(base, json={"title": "x", "url": "https://x.example"})
    ).status_code == 403

    # In an announcement channel only owners and administrators change the bar.
    as_user(alice)
    await client.patch(f"/api/v1/channels/{cid}", json={"posting_policy": "owners"})
    as_user(bob)
    refused = await client.post(base, json={"title": "x", "url": "https://x.example"})
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "posting_restricted"

    # Every change reached the members with the whole bar.
    rows = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "channel.links_updated")
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    )
    assert [r.audience_type for r in rows] == ["channel"] * 4
    assert [len(r.payload["links"]) for r in rows] == [1, 2, 2, 1]


async def test_link_limit(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(links_service, "MAX_LINKS", 1)
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = (await client.post("/api/v1/channels", json={"name": "one"})).json()["id"]
    base = f"/api/v1/channels/{cid}/links"
    assert (
        await client.post(base, json={"title": "a", "url": "https://a.example"})
    ).status_code == 201
    full = await client.post(base, json={"title": "b", "url": "https://b.example"})
    assert full.status_code == 409 and full.json()["error"]["code"] == "too_many_links"
