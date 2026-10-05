"""M111: my sidebar items / home tiles (UserMe.nav_items), set and reset through PATCH /users/me and
carried to my other devices like the other private settings (SYNC_PROTOCOL.md §6)."""

import json
import re
from collections.abc import Callable
from pathlib import Path

import httpx
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.users.models import User
from app.modules.users.schemas import MAX_NAV_ITEMS, NAV_ITEM_KEY_PATTERN
from tests.conftest import LiveServer
from tests.helpers import http_login, make_user
from tests.test_realtime import PASSWORD, _connect, _recv_type, _wait_outbox_drained

CATALOGUE = Path(__file__).resolve().parents[2] / "apps" / "shared" / "nav-items.json"


async def test_set_and_reset_nav_items(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    assert (await client.get("/api/v1/users/me")).json()["nav_items"] is None
    # My order, a hidden item, and a key this server knows nothing about (a newer client's): kept.
    chosen = [
        {"key": "saved", "visible": True},
        {"key": "files", "visible": False},
        {"key": "threads", "visible": True},
        {"key": "some-future-page", "visible": True},
    ]
    updated = await client.patch("/api/v1/users/me", json={"nav_items": chosen})
    assert updated.status_code == 200, updated.text
    assert updated.json()["nav_items"] == chosen
    await db.refresh(alice)
    assert alice.nav_items == chosen
    # Other fields leave it alone.
    await client.patch("/api/v1/users/me", json={"title": "M2"})
    assert (await client.get("/api/v1/users/me")).json()["nav_items"] == chosen
    reset = await client.patch("/api/v1/users/me", json={"nav_items": None})
    assert reset.status_code == 200 and reset.json()["nav_items"] is None
    assert await db.scalar(select(User.nav_items).where(User.id == alice.id)) is None
    # An empty list is a list (every catalogue item then shows by its default, nav-items.json).
    empty = await client.patch("/api/v1/users/me", json={"nav_items": []})
    assert empty.status_code == 200 and empty.json()["nav_items"] == []


async def test_nav_items_validation(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    good = [{"key": "threads", "visible": False}]
    first = await client.patch("/api/v1/users/me", json={"nav_items": good})
    assert first.status_code == 200, first.text
    too_many = [{"key": f"k{i}", "visible": True} for i in range(MAX_NAV_ITEMS + 1)]
    for bad in (
        [{"key": "threads", "visible": True}, {"key": "threads", "visible": False}],
        [{"key": "Threads", "visible": True}],
        [{"key": "", "visible": True}],
        [{"key": "a" * 33, "visible": True}],
        [{"key": "files"}],
        [{"key": "files", "visible": True, "label": "x"}],
        [{"key": "files", "visible": "maybe"}],
        ["files"],
        too_many,
    ):
        result = await client.patch("/api/v1/users/me", json={"nav_items": bad})
        assert result.status_code == 422, bad
        assert result.json()["error"]["code"] == "validation_error"
    await db.refresh(alice)
    assert alice.nav_items == good
    exactly = [{"key": f"k{i}", "visible": i % 2 == 0} for i in range(MAX_NAV_ITEMS)]
    assert (await client.patch("/api/v1/users/me", json={"nav_items": exactly})).status_code == 200


def test_shared_catalogue_fits_the_server() -> None:
    """apps/shared/nav-items.json: every key is one the server accepts, and they fit in one list."""
    doc = json.loads(CATALOGUE.read_text(encoding="utf-8"))
    keys = [item["key"] for item in doc["items"]]
    assert len(keys) == len(set(keys)) <= MAX_NAV_ITEMS
    assert all(re.fullmatch(NAV_ITEM_KEY_PATTERN, key) for key in keys)
    assert "reservations" in keys
    for platform in ("desktop", "mobile"):
        assert sorted(doc["order"][platform]) == sorted(keys)
    for item in doc["items"]:
        assert set(item["platforms"]) <= {"desktop", "mobile"} and item["platforms"]
    # What a client saves (its `full` list) is accepted as is.
    for case in doc["cases"] + doc["reorder"]:
        assert all(re.fullmatch(NAV_ITEM_KEY_PATTERN, item["key"]) for item in case["full"])
        assert len({item["key"] for item in case["full"]}) == len(case["full"])


async def test_change_reaches_my_other_devices(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    chosen = [{"key": "calendar", "visible": True}, {"key": "drafts", "visible": False}]
    before = {e.id for e in (await db.execute(select(OutboxEvent))).scalars()}
    await client.patch("/api/v1/users/me", json={"nav_items": chosen})
    events = [e for e in (await db.execute(select(OutboxEvent))).scalars() if e.id not in before]
    assert [e.event_type for e in events] == ["user.updated"]
    # The event is everyone's (UserPublic): the private list is not in it.
    assert events[0].audience_type == "all"
    assert events[0].payload["user"]["id"] == str(alice.id)
    assert "nav_items" not in events[0].payload["user"]
    # My other device reads it from the bootstrap (and GET /users/me); others never see it.
    await db.refresh(alice)
    boot = (await client.get("/api/v1/sync/bootstrap")).json()
    assert boot["me"]["nav_items"] == chosen
    assert all("nav_items" not in u for u in boot["users"])
    as_user(bob)
    boot = (await client.get("/api/v1/sync/bootstrap")).json()
    assert boot["me"]["nav_items"] is None
    assert "nav_items" not in (await client.get(f"/api/v1/users/{alice.id}")).json()


async def test_other_device_hears_user_updated_live(live: LiveServer) -> None:
    """Device B is told (user.updated about me) and reads GET /users/me."""
    async with live.app.state.db.session_factory() as db:
        await make_user(db, "alice", password=PASSWORD)
    phone = await http_login(live.base_url, "alice", PASSWORD)
    laptop = await http_login(live.base_url, "alice", PASSWORD)
    await _wait_outbox_drained(live)
    ws = await _connect(live, laptop["access_token"])
    chosen = [{"key": "tasks", "visible": True}, {"key": "threads", "visible": False}]
    async with httpx.AsyncClient(base_url=live.base_url) as http:
        auth = {"Authorization": f"Bearer {phone['access_token']}"}
        patched = await http.patch("/api/v1/users/me", json={"nav_items": chosen}, headers=auth)
        assert patched.status_code == 200, patched.text
        event = await _recv_type(ws, "event")
        assert event["event"] == "user.updated"
        user = event["data"]["user"]
        assert user["id"] == laptop["user"]["id"] and "nav_items" not in user
        laptop_auth = {"Authorization": f"Bearer {laptop['access_token']}"}
        me = (await http.get("/api/v1/users/me", headers=laptop_auth)).json()
        assert me["nav_items"] == chosen
    await ws.close()
