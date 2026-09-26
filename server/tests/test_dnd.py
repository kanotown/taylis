"""Do not disturb (M12c): the quiet-hours rule, the profile API and push suppression."""

import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.channels import service as channels
from app.modules.users.dnd import in_quiet_hours
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_push_planner import add_device, deliveries, post, relay_with_planner


def _at(text: str) -> datetime:
    return datetime.fromisoformat(text).astimezone(UTC)


def test_quiet_hours_same_day_window() -> None:
    kw = {"start": 12 * 60, "end": 13 * 60, "days": None, "tz": "Asia/Tokyo"}
    assert in_quiet_hours(_at("2026-09-28T12:30:00+09:00"), **kw)  # Monday lunch
    assert not in_quiet_hours(_at("2026-09-28T13:00:00+09:00"), **kw)  # end is exclusive
    assert not in_quiet_hours(_at("2026-09-28T11:59:00+09:00"), **kw)
    # The zone matters: 12:30 JST is 03:30 UTC.
    assert not in_quiet_hours(_at("2026-09-28T12:30:00+00:00"), **kw)


def test_quiet_hours_overnight_belongs_to_the_day_it_starts() -> None:
    friday_only = {"start": 22 * 60, "end": 7 * 60, "days": [4], "tz": "Asia/Tokyo"}
    assert in_quiet_hours(_at("2026-10-02T23:00:00+09:00"), **friday_only)  # Friday night
    assert in_quiet_hours(_at("2026-10-03T06:30:00+09:00"), **friday_only)  # Saturday morning
    assert not in_quiet_hours(_at("2026-10-03T23:00:00+09:00"), **friday_only)  # Saturday night
    assert not in_quiet_hours(_at("2026-10-02T21:59:00+09:00"), **friday_only)
    every_day = {"start": 22 * 60, "end": 7 * 60, "days": None, "tz": "Asia/Tokyo"}
    assert in_quiet_hours(_at("2026-09-28T02:00:00+09:00"), **every_day)
    assert not in_quiet_hours(_at("2026-09-28T08:00:00+09:00"), **every_day)
    assert not in_quiet_hours(_at("2026-09-28T08:00:00+09:00"), start=0, end=0, days=None, tz="UTC")


def test_manual_pause_beats_the_clock() -> None:
    from app.modules.users.dnd import dnd_active
    from app.modules.users.models import User

    user = User(username="u", display_name="U", password_hash="x")
    now = datetime(2026, 9, 28, 12, 0, tzinfo=UTC)
    assert not dnd_active(user, now)
    user.dnd_until = now + timedelta(minutes=5)
    assert dnd_active(user, now)
    user.dnd_until = now - timedelta(minutes=5)
    assert not dnd_active(user, now)
    user.quiet_hours_start, user.quiet_hours_end, user.quiet_hours_tz = 0, 24 * 60 - 1, "UTC"
    assert dnd_active(user, now)
    user.quiet_hours_tz = "Mars/Olympus"  # a zone we cannot resolve never blocks pushes
    assert not dnd_active(user, now)


async def test_dnd_and_quiet_hours_are_set_on_me_and_visible_to_others(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    later = (utcnow() + timedelta(hours=1)).isoformat()
    updated = await client.patch(
        "/api/v1/users/me",
        json={
            "dnd_until": later,
            "quiet_hours": {
                "start": "22:00",
                "end": "07:00",
                "days": [4, 0, 0],
                "tz": "Asia/Tokyo",
            },
        },
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["dnd_until"] is not None
    assert body["quiet_hours"] == {
        "start": "22:00",
        "end": "07:00",
        "days": [0, 4],
        "tz": "Asia/Tokyo",
    }
    # Other users see it (that is how clients draw 🔕); bad input is refused.
    as_user(bob)
    seen = (await client.get(f"/api/v1/users/{alice.id}")).json()
    assert seen["quiet_hours"]["tz"] == "Asia/Tokyo" and seen["dnd_until"] is not None
    as_user(alice)
    for bad in (
        {"quiet_hours": {"start": "25:00", "end": "07:00", "tz": "Asia/Tokyo"}},
        {"quiet_hours": {"start": "22:00", "end": "07:00", "days": [7], "tz": "Asia/Tokyo"}},
        {"quiet_hours": {"start": "22:00", "end": "07:00", "tz": "Mars/Olympus"}},
    ):
        assert (await client.patch("/api/v1/users/me", json=bad)).status_code == 422
    # A past pause reads as no pause; null clears the quiet hours.
    earlier = (utcnow() - timedelta(minutes=1)).isoformat()
    cleared = (
        await client.patch("/api/v1/users/me", json={"dnd_until": earlier, "quiet_hours": None})
    ).json()
    assert cleared["dnd_until"] is None and cleared["quiet_hours"] is None


async def test_paused_user_gets_no_push(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    bob.dnd_until = utcnow() + timedelta(minutes=30)
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    await db.commit()
    await post(db, alice, dm.id)
    relay = relay_with_planner(app, test_settings)
    while await relay.process_batch():
        pass
    assert await deliveries(db) == []
    # Once the pause is over, the next message is delivered as usual.
    bob.dnd_until = utcnow() - timedelta(minutes=1)
    await db.commit()
    await post(db, alice, dm.id, body="again")
    while await relay.process_batch():
        pass
    assert len(await deliveries(db)) == 1
    assert uuid.UUID(str((await deliveries(db))[0].message_id)) is not None
