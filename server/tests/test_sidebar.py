"""Custom sidebar sections (M14f)."""

import uuid
from collections.abc import Callable
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.users.models import User
from tests.helpers import make_user


def _names(rows: list[dict[str, Any]]) -> list[str]:
    return [r["name"] for r in rows]


async def test_sections_group_my_conversations(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(bob)
    foreign = (
        await client.post("/api/v1/channels", json={"name": "bobs", "type": "private"})
    ).json()
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    design = (await client.post("/api/v1/channels", json={"name": "design"})).json()
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})).json()

    assert (await client.get("/api/v1/sidebar/sections")).json() == []
    created = await client.post("/api/v1/sidebar/sections", json={"name": "  プロジェクト  X "})
    assert created.status_code == 201
    rows = created.json()
    assert _names(rows) == ["プロジェクト X"] and rows[0]["position"] == 0
    project = rows[0]["id"]
    rows = (await client.post("/api/v1/sidebar/sections", json={"name": "チーム"})).json()
    team = rows[1]["id"]
    assert (await client.post("/api/v1/sidebar/sections", json={"name": "   "})).status_code == 422

    # Place conversations (DMs too); moving one leaves the other section.
    rows = (await client.put(f"/api/v1/sidebar/sections/{project}/channels/{design['id']}")).json()
    rows = (await client.put(f"/api/v1/sidebar/sections/{project}/channels/{dm['id']}")).json()
    assert rows[0]["channel_ids"] == [design["id"], dm["id"]]
    rows = (await client.put(f"/api/v1/sidebar/sections/{team}/channels/{design['id']}")).json()
    assert rows[0]["channel_ids"] == [dm["id"]] and rows[1]["channel_ids"] == [design["id"]]
    denied = await client.put(f"/api/v1/sidebar/sections/{team}/channels/{foreign['id']}")
    assert denied.status_code == 403

    # Reorder and rename; the bootstrap carries the list.
    rows = (
        await client.patch(
            f"/api/v1/sidebar/sections/{team}", json={"position": 0, "name": "チーム A"}
        )
    ).json()
    assert _names(rows) == ["チーム A", "プロジェクト X"] and [r["position"] for r in rows] == [
        0,
        1,
    ]
    booted = (await client.get("/api/v1/sync/bootstrap")).json()
    assert _names(booted["sidebar_sections"]) == ["チーム A", "プロジェクト X"]

    # Back to the default sections; deleting a section releases its conversations.
    rows = (await client.delete(f"/api/v1/sidebar/channels/{dm['id']}")).json()
    assert rows[1]["channel_ids"] == []
    rows = (await client.delete(f"/api/v1/sidebar/sections/{team}")).json()
    assert _names(rows) == ["プロジェクト X"] and rows[0]["position"] == 0
    rows = (await client.put(f"/api/v1/sidebar/sections/{project}/channels/{general['id']}")).json()
    assert rows[0]["channel_ids"] == [general["id"]]

    # Sections are personal.
    as_user(bob)
    assert (await client.get("/api/v1/sidebar/sections")).json() == []
    stolen = await client.patch(f"/api/v1/sidebar/sections/{project}", json={"name": "mine"})
    assert stolen.status_code == 404
    as_user(alice)
    missing = await client.put(f"/api/v1/sidebar/sections/{uuid.uuid4()}/channels/{general['id']}")
    assert missing.status_code == 404

    events = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "sidebar.updated")))
        .scalars()
        .all()
    )
    assert events and all(e.audience_type == "user" and e.audience_id == alice.id for e in events)


async def test_section_limit(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    for index in range(20):
        assert (
            await client.post("/api/v1/sidebar/sections", json={"name": f"s{index}"})
        ).status_code == 201
    over = await client.post("/api/v1/sidebar/sections", json={"name": "one more"})
    assert over.status_code == 409 and over.json()["error"]["code"] == "too_many_sections"


async def test_sections_have_an_icon_fold_up_and_take_conversations_when_made(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """M26 (Slack): name, icon and conversations in one step; the icon and folding change later."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(bob)
    foreign = (
        await client.post("/api/v1/channels", json={"name": "bobs", "type": "private"})
    ).json()
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    papers = (await client.post("/api/v1/channels", json={"name": "papers"})).json()
    first = (
        await client.post("/api/v1/sidebar/sections", json={"name": "研究", "emoji": "🔬"})
    ).json()
    moved = await client.put(f"/api/v1/sidebar/sections/{first[0]['id']}/channels/{general['id']}")
    assert moved.status_code == 200

    made = await client.post(
        "/api/v1/sidebar/sections",
        json={
            "name": "論文",
            "emoji": ":party_parrot:",
            "channel_ids": [general["id"], papers["id"]],
        },
    )
    assert made.status_code == 201, made.text
    rows = {r["name"]: r for r in made.json()}
    assert rows["研究"]["emoji"] == "🔬" and rows["研究"]["channel_ids"] == []  # general moved
    assert rows["論文"]["emoji"] == ":party_parrot:" and rows["論文"]["collapsed"] is False
    assert set(rows["論文"]["channel_ids"]) == {general["id"], papers["id"]}

    section_id = rows["論文"]["id"]
    folded = await client.patch(
        f"/api/v1/sidebar/sections/{section_id}", json={"collapsed": True, "emoji": "🇯🇵"}
    )
    assert {r["name"]: (r["emoji"], r["collapsed"]) for r in folded.json()}["論文"] == ("🇯🇵", True)
    plain = await client.patch(f"/api/v1/sidebar/sections/{section_id}", json={"emoji": None})
    assert {r["name"]: r["emoji"] for r in plain.json()}["論文"] is None
    kept = await client.patch(f"/api/v1/sidebar/sections/{section_id}", json={"name": "論文 2"})
    assert {r["name"]: r["collapsed"] for r in kept.json()}["論文 2"] is True  # untouched

    bad = await client.post("/api/v1/sidebar/sections", json={"name": "x", "emoji": "two words"})
    assert bad.status_code == 422
    not_mine = await client.post(
        "/api/v1/sidebar/sections", json={"name": "y", "channel_ids": [foreign["id"]]}
    )
    assert not_mine.status_code in (403, 404)
    assert [r["name"] for r in (await client.get("/api/v1/sidebar/sections")).json()] == [
        "研究",
        "論文 2",
    ]
