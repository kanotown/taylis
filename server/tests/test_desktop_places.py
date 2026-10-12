"""2026-10-12 (docs/MOBILE_UI.md §18.2): Desktop / Web's placement of its places
(UserMe.desktop_places), set and reset through PATCH /users/me, kept apart from nav_items (the
phones' tiles), private to me, and read back on my other devices."""

from collections.abc import Callable

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.users.models import User
from app.modules.users.schemas import MAX_NAV_ITEMS
from tests.helpers import make_user


async def test_set_and_reset_desktop_places(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    assert (await client.get("/api/v1/users/me")).json()["desktop_places"] is None
    nav = [{"key": "files", "visible": False}]
    await client.patch("/api/v1/users/me", json={"nav_items": nav})
    chosen = {
        "rail": False,
        "items": [
            {"key": "threads", "place": "sidebar"},
            {"key": "files", "place": "rail"},
            {"key": "my-times", "place": "hidden"},
            {"key": "some-future-page", "place": "rail"},
        ],
        "times_before": "channels",
    }
    updated = await client.patch("/api/v1/users/me", json={"desktop_places": chosen})
    assert updated.status_code == 200, updated.text
    assert updated.json()["desktop_places"] == chosen
    # The phones' list is left alone (files stays hidden there though the desktop shows it).
    assert updated.json()["nav_items"] == nav
    await db.refresh(alice)
    assert alice.desktop_places == chosen
    # Other fields leave it alone; nav_items changes leave it alone.
    await client.patch("/api/v1/users/me", json={"title": "M2"})
    cleared = await client.patch("/api/v1/users/me", json={"nav_items": None})
    assert cleared.status_code == 200, cleared.text
    await db.refresh(alice)
    me = (await client.get("/api/v1/users/me")).json()
    assert me["desktop_places"] == chosen and me["nav_items"] is None
    # `rail` and `items` take their defaults when left out.
    short = await client.patch("/api/v1/users/me", json={"desktop_places": {}})
    assert short.json()["desktop_places"] == {"rail": True, "items": [], "times_before": None}
    reset = await client.patch("/api/v1/users/me", json={"desktop_places": None})
    assert reset.status_code == 200 and reset.json()["desktop_places"] is None
    assert await db.scalar(select(User.desktop_places).where(User.id == alice.id)) is None


async def test_desktop_places_validation(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    good = {"rail": True, "items": [{"key": "drafts", "place": "sidebar"}], "times_before": None}
    first = await client.patch("/api/v1/users/me", json={"desktop_places": good})
    assert first.status_code == 200
    too_many = [{"key": f"k{i}", "place": "rail"} for i in range(MAX_NAV_ITEMS + 1)]
    for bad in (
        {"items": [{"key": "files", "place": "rail"}, {"key": "files", "place": "hidden"}]},
        {"items": [{"key": "Files", "place": "rail"}]},
        {"items": [{"key": "files", "place": "top"}]},
        {"items": [{"key": "files"}]},
        {"items": [{"key": "files", "place": "rail", "visible": True}]},
        {"rail": "maybe"},
        {"rail": True, "extra": 1},
        {"items": too_many},
        {"times_before": "Channels"},
        {"times_before": ""},
        {"times_before": "x" * 65},
        {"times_before": 3},
        ["files"],
    ):
        result = await client.patch("/api/v1/users/me", json={"desktop_places": bad})
        assert result.status_code == 422, bad
        assert result.json()["error"]["code"] == "validation_error"
    await db.refresh(alice)
    assert alice.desktop_places == good


async def test_desktop_places_are_mine_only(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    chosen = {"rail": True, "items": [{"key": "calendar", "place": "hidden"}], "times_before": None}
    before = {e.id for e in (await db.execute(select(OutboxEvent))).scalars()}
    await client.patch("/api/v1/users/me", json={"desktop_places": chosen})
    events = [e for e in (await db.execute(select(OutboxEvent))).scalars() if e.id not in before]
    # My other devices are told (user.updated) and read GET /users/me; the event does not carry it.
    assert [e.event_type for e in events] == ["user.updated"]
    assert "desktop_places" not in events[0].payload["user"]
    await db.refresh(alice)
    boot = (await client.get("/api/v1/sync/bootstrap")).json()
    assert boot["me"]["desktop_places"] == chosen
    assert all("desktop_places" not in u for u in boot["users"])
    as_user(bob)
    assert (await client.get("/api/v1/sync/bootstrap")).json()["me"]["desktop_places"] is None
    assert "desktop_places" not in (await client.get(f"/api/v1/users/{alice.id}")).json()


async def test_a_bad_stored_value_reads_as_unset(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    alice.desktop_places = {"rail": True, "items": [{"key": "files", "place": "nowhere"}]}
    await db.commit()
    as_user(alice)
    assert (await client.get("/api/v1/users/me")).json()["desktop_places"] is None


async def test_times_section_anchor(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """Where the Times section stands (TIMES_FEED.md §7): a default section's key, one of my own
    sections' id or "end", kept as sent and left alone by the other fields."""
    alice = await make_user(db, "alice")
    as_user(alice)
    for anchor in ("favorites", "dms", "end", "0b6f5a52-2f7e-4c55-9f43-0a3b6c1d2e3f"):
        chosen = {
            "rail": False,
            "items": [{"key": "files", "place": "hidden"}],
            "times_before": anchor,
        }
        result = await client.patch("/api/v1/users/me", json={"desktop_places": chosen})
        assert result.status_code == 200, result.text
        assert result.json()["desktop_places"] == chosen
    await db.refresh(alice)
    assert alice.desktop_places is not None
    assert alice.desktop_places["times_before"] == "0b6f5a52-2f7e-4c55-9f43-0a3b6c1d2e3f"
