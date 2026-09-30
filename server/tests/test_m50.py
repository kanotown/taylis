"""M50: my own quick reactions (UserMe.quick_reactions), set and reset through PATCH /users/me and
carried to my other devices like the other private settings (SYNC_PROTOCOL.md §6)."""

import json
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.users.models import User
from app.modules.users.schemas import is_plain_emoji
from tests.conftest import LiveServer
from tests.helpers import http_login, make_user
from tests.test_realtime import PASSWORD, _connect, _recv_type, _wait_outbox_drained

CASES = Path(__file__).resolve().parents[2] / "apps" / "shared" / "quick-reactions.json"


async def test_set_and_reset_quick_reactions(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    assert (await client.get("/api/v1/users/me")).json()["quick_reactions"] is None

    chosen = ["🔥", "🙏", "👍", "🇯🇵", "👩‍💻", "❤️"]
    updated = await client.patch("/api/v1/users/me", json={"quick_reactions": chosen})
    assert updated.status_code == 200, updated.text
    assert updated.json()["quick_reactions"] == chosen
    await db.refresh(alice)  # the overridden auth hands the route this session's object
    assert alice.quick_reactions == chosen
    assert (await client.get("/api/v1/users/me")).json()["quick_reactions"] == chosen

    # Other fields leave it alone; a shorter list replaces it in its order.
    await client.patch("/api/v1/users/me", json={"notify_reactions": True})
    await db.refresh(alice)
    assert (await client.get("/api/v1/users/me")).json()["quick_reactions"] == chosen
    shorter = await client.patch("/api/v1/users/me", json={"quick_reactions": ["🎉", "👀"]})
    assert shorter.json()["quick_reactions"] == ["🎉", "👀"]

    reset = await client.patch("/api/v1/users/me", json={"quick_reactions": None})
    assert reset.status_code == 200 and reset.json()["quick_reactions"] is None
    await db.refresh(alice)
    assert alice.quick_reactions is None


async def test_quick_reactions_validation(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    await client.patch("/api/v1/users/me", json={"quick_reactions": ["👍"]})
    cases = json.loads(CASES.read_text(encoding="utf-8"))
    bad_lists: list[Any] = [
        [],
        ["👍", "❤️", "😂", "🎉", "👀", "✅", "🔥"],  # seven
        ["👍", "👍"],
        "👍",
        [1],
        *[[item] for item in cases["invalid"]],
    ]
    for bad in bad_lists:
        result = await client.patch("/api/v1/users/me", json={"quick_reactions": bad})
        assert result.status_code == 422, bad
        assert result.json()["error"]["code"] == "validation_error"
    await db.refresh(alice)
    assert (await client.get("/api/v1/users/me")).json()["quick_reactions"] == ["👍"]
    for good in cases["valid"]:
        result = await client.patch("/api/v1/users/me", json={"quick_reactions": [good]})
        assert result.status_code == 200, good
        assert result.json()["quick_reactions"] == [good]


def test_shared_cases_match_the_rule() -> None:
    """apps/shared/quick-reactions.json: what the clients may check before sending."""
    cases = json.loads(CASES.read_text(encoding="utf-8"))
    assert all(is_plain_emoji(item) for item in cases["valid"])
    assert not any(is_plain_emoji(item) for item in cases["invalid"])
    emoji = json.loads((CASES.parent / "emoji.json").read_text(encoding="utf-8"))["emoji"]
    assert all(is_plain_emoji(row[1]) for row in emoji)  # every glyph the pickers offer


async def test_change_reaches_my_other_devices(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    before = {e.id for e in (await db.execute(select(OutboxEvent))).scalars()}
    await client.patch("/api/v1/users/me", json={"quick_reactions": ["🍣", "🍜"]})
    events = [e for e in (await db.execute(select(OutboxEvent))).scalars() if e.id not in before]
    assert [e.event_type for e in events] == ["user.updated"]
    # The event is everyone's (UserPublic): the private list is not in it.
    assert events[0].audience_type == "all"
    assert events[0].payload["user"]["id"] == str(alice.id)
    assert "quick_reactions" not in events[0].payload["user"]
    # My other device reads it from the bootstrap (and GET /users/me); others never see it.
    await db.refresh(alice)
    boot = (await client.get("/api/v1/sync/bootstrap")).json()
    assert boot["me"]["quick_reactions"] == ["🍣", "🍜"]
    assert all("quick_reactions" not in u for u in boot["users"])
    as_user(bob)
    boot = (await client.get("/api/v1/sync/bootstrap")).json()
    assert boot["me"]["quick_reactions"] is None
    public = (await client.get(f"/api/v1/users/{alice.id}")).json()
    assert "quick_reactions" not in public


async def test_other_device_hears_user_updated_live(live: LiveServer) -> None:
    """Device B is told (user.updated about me, newer updated_at) and reads GET /users/me."""
    async with live.app.state.db.session_factory() as db:
        await make_user(db, "alice", password=PASSWORD)
    phone = await http_login(live.base_url, "alice", PASSWORD)
    laptop = await http_login(live.base_url, "alice", PASSWORD)
    await _wait_outbox_drained(live)
    ws = await _connect(live, laptop["access_token"])
    async with httpx.AsyncClient(base_url=live.base_url) as http:
        auth = {"Authorization": f"Bearer {phone['access_token']}"}
        patched = await http.patch(
            "/api/v1/users/me", json={"quick_reactions": ["🙏", "🔥", "👍"]}, headers=auth
        )
        assert patched.status_code == 200, patched.text
        event = await _recv_type(ws, "event")
        assert event["event"] == "user.updated"
        user = event["data"]["user"]
        assert user["id"] == laptop["user"]["id"] and "quick_reactions" not in user
        changed = datetime.fromisoformat(user["updated_at"].replace("Z", "+00:00"))
        known = datetime.fromisoformat(laptop["user"]["updated_at"].replace("Z", "+00:00"))
        assert changed > known
        laptop_auth = {"Authorization": f"Bearer {laptop['access_token']}"}
        me = (await http.get("/api/v1/users/me", headers=laptop_auth)).json()
        assert me["quick_reactions"] == ["🙏", "🔥", "👍"]
    await ws.close()
