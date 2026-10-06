"""Custom sidebar sections (M14f)."""

import json
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.users.models import User
from tests.helpers import make_user

SECTION_ICON_CASES: list[dict[str, Any]] = json.loads(
    (Path(__file__).resolve().parents[2] / "apps" / "shared" / "section-icons.json").read_text(
        encoding="utf-8"
    )
)["cases"]


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


async def test_letter_badge_icons_are_validated(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """M114: `letter:<text>:<colour>` icons, the cases every client parses (apps/shared)."""
    cases = SECTION_ICON_CASES
    as_user(await make_user(db, "alice"))
    made = await client.post("/api/v1/sidebar/sections", json={"name": "修論指導"})
    section_id = made.json()[0]["id"]
    for case in cases:
        icon = case["icon"]
        if not icon.startswith("letter:"):
            continue
        response = await client.patch(
            f"/api/v1/sidebar/sections/{section_id}", json={"emoji": icon}
        )
        if case["letter"] is None:
            assert response.status_code == 422, icon
        else:
            assert response.status_code == 200, (icon, response.text)
            assert response.json()[0]["emoji"] == icon
    created = await client.post(
        "/api/v1/sidebar/sections", json={"name": "卒論指導", "emoji": " letter:B:green "}
    )
    assert created.status_code == 201
    assert {r["name"]: r["emoji"] for r in created.json()}["卒論指導"] == "letter:B:green"


async def test_sections_and_default_sections_keep_a_sort(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """2026-10-07 (DATA_MODEL.md 「並べ替え」): name / recent / manual per section, the default
    お気に入り / チャンネル / ダイレクトメッセージ too; synced to my devices by sidebar.updated."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    a = (await client.post("/api/v1/channels", json={"name": "a"})).json()["id"]
    b = (await client.post("/api/v1/channels", json={"name": "b"})).json()["id"]

    defaults = (await client.get("/api/v1/sidebar/defaults")).json()
    assert defaults == [
        {"key": "favorites", "sort": "name", "manual_order": []},
        {"key": "channels", "sort": "name", "manual_order": []},
        {"key": "dms", "sort": "recent", "manual_order": []},
    ]
    rows = (await client.post("/api/v1/sidebar/sections", json={"name": "研究"})).json()
    section = rows[0]["id"]
    assert rows[0]["sort"] == "name" and rows[0]["manual_order"] == []

    # A section by hand: the order is kept as sent (each id once).
    changed = await client.patch(
        f"/api/v1/sidebar/sections/{section}",
        json={"sort": "manual", "manual_order": [b, a, b]},
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()[0]["sort"] == "manual" and changed.json()[0]["manual_order"] == [b, a]
    recent = await client.patch(f"/api/v1/sidebar/sections/{section}", json={"sort": "recent"})
    assert recent.json()[0]["sort"] == "recent" and recent.json()[0]["manual_order"] == [b, a]
    bad = await client.patch(f"/api/v1/sidebar/sections/{section}", json={"sort": "size"})
    assert bad.status_code == 422

    # A default section: a row appears on the first change; the others keep their default.
    out = await client.patch(
        "/api/v1/sidebar/defaults/channels", json={"sort": "manual", "manual_order": [b, a]}
    )
    assert out.status_code == 200, out.text
    assert out.json()[1] == {"key": "channels", "sort": "manual", "manual_order": [b, a]}
    out = await client.patch("/api/v1/sidebar/defaults/dms", json={"sort": "name"})
    assert [d["sort"] for d in out.json()] == ["name", "manual", "name"]
    assert (await client.patch("/api/v1/sidebar/defaults/times", json={})).status_code == 422
    extra = await client.patch("/api/v1/sidebar/defaults/dms", json={"position": 1})
    assert extra.status_code == 422

    booted = (await client.get("/api/v1/sync/bootstrap")).json()
    assert [d["sort"] for d in booted["sidebar_defaults"]] == ["name", "manual", "name"]
    assert booted["sidebar_sections"][0]["sort"] == "recent"

    # The event carries both lists (the last one: the dms change).
    event = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "sidebar.updated")
                .order_by(OutboxEvent.id.desc())
            )
        )
        .scalars()
        .first()
    )
    assert event is not None and event.audience_id == alice.id
    assert [d["sort"] for d in event.payload["defaults"]] == ["name", "manual", "name"]
    assert event.payload["sections"][0]["sort"] == "recent"

    # Personal: bob still has the defaults.
    as_user(bob)
    assert [d["sort"] for d in (await client.get("/api/v1/sidebar/defaults")).json()] == [
        "name",
        "name",
        "recent",
    ]
