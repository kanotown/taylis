"""The quick status menu (docs/PRESENCE.md §11): PUT /users/me/presence, the hub's manual away,
取り込み中 = dnd_until (pushes), オフライン表示 = presence_hidden, and payloads old clients read."""

import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.channels import service as channels
from app.modules.users.models import User
from app.modules.users.presence import DND_INDEFINITE, DND_INDEFINITE_FROM, dnd_until_for
from app.realtime.hub import RealtimeHub
from tests.helpers import make_user
from tests.test_push_planner import add_device, deliveries, post, relay_with_planner


async def _put(client: AsyncClient, **body: Any) -> Any:
    return await client.put("/api/v1/users/me/presence", json=body)


def _drain(conn: Any) -> list[dict[str, Any]]:
    return [conn.queue.get_nowait() for _ in range(conn.queue.qsize())]


def _presence_of(conn: Any, user_id: uuid.UUID) -> list[str]:
    """The presence statuses this connection was told about `user_id`, in order (drained)."""
    return [
        f["status"]
        for f in _drain(conn)
        if f.get("type") == "presence" and f.get("user_id") == str(user_id)
    ]


def _v(n: int) -> datetime:
    """A flags version (users.updated_at) for the hub's own tests."""
    return datetime(2026, 10, 10, tzinfo=UTC) + timedelta(seconds=n)


def test_durations_in_the_users_zone() -> None:
    tokyo = ZoneInfo("Asia/Tokyo")
    # 2026-10-09 22:30 JST = 13:30 UTC.
    now = datetime(2026, 10, 9, 13, 30, tzinfo=UTC)
    assert dnd_until_for("30m", now, tokyo) == now + timedelta(minutes=30)
    assert dnd_until_for("4h", now, tokyo) == now + timedelta(hours=4)
    assert dnd_until_for("today", now, tokyo) == datetime(2026, 10, 9, 23, 59, 59, tzinfo=tokyo)
    assert dnd_until_for("tomorrow", now, tokyo) == datetime(2026, 10, 10, 23, 59, 59, tzinfo=tokyo)
    # The same instant is still 9 October in New York, already the 10th in Tokyo at 09:30.
    later = datetime(2026, 10, 10, 0, 30, tzinfo=UTC)  # 09:30 JST, 20:30 EDT on the 9th
    assert dnd_until_for("today", later, tokyo) == datetime(2026, 10, 10, 23, 59, 59, tzinfo=tokyo)
    new_york = ZoneInfo("America/New_York")
    assert dnd_until_for("today", later, new_york) == datetime(
        2026, 10, 9, 23, 59, 59, tzinfo=new_york
    )
    assert dnd_until_for("forever", now, tokyo) == DND_INDEFINITE >= DND_INDEFINITE_FROM


async def test_choices_are_exclusive_and_others_see_them(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], app: FastAPI
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    hub: RealtimeHub = app.state.hub
    hub.new_connection(alice.id, uuid.uuid4())
    watcher = hub.new_connection(bob.id, uuid.uuid4())
    _drain(watcher)
    as_user(alice)

    # 離席中: away to everyone although I am active.
    away = await _put(client, status="away")
    assert away.status_code == 200, away.text
    assert away.json()["presence_manual"] == "away" and away.json()["dnd_until"] is None
    assert hub.presence_status(alice.id) == "away"
    assert (alice.id, "away") in hub.presence_snapshot()
    frames = _drain(watcher)
    assert {"type": "presence", "user_id": str(alice.id), "status": "away"} in frames

    # 取り込み中 for 30 minutes: dnd_until is public (others draw the red dot from it) and the
    # manual away is gone (one choice at a time); the hub is online again.
    dnd = (await _put(client, status="dnd", duration="30m")).json()
    assert dnd["presence_manual"] is None and dnd["presence_hidden"] is False
    until = datetime.fromisoformat(dnd["dnd_until"])
    assert timedelta(minutes=29) < until - utcnow() <= timedelta(minutes=30)
    assert hub.presence_status(alice.id) == "online"
    as_user(bob)
    seen = (await client.get(f"/api/v1/users/{alice.id}")).json()
    assert seen["dnd_until"] == dnd["dnd_until"]
    assert "presence_manual" not in seen and "presence_hidden" not in seen
    as_user(alice)

    # 解除するまで: the fixed far-future instant.
    forever = (await _put(client, status="dnd", duration="forever")).json()
    assert datetime.fromisoformat(forever["dnd_until"]) == DND_INDEFINITE

    # オフライン表示 = 在席を隠す: offline to everyone, no pause.
    invisible = (await _put(client, status="invisible")).json()
    assert invisible["presence_hidden"] is True and invisible["dnd_until"] is None
    assert hub.presence_status(alice.id) == "offline"
    assert alice.id not in [user_id for user_id, _ in hub.presence_snapshot()]

    # invisible → 離席中: the others get one frame, away (never a passing online).
    _drain(watcher)
    assert (await _put(client, status="away")).status_code == 200
    assert _presence_of(watcher, alice.id) == ["away"]

    # オンライン（自動）clears everything.
    auto = (await _put(client, status="auto")).json()
    assert auto["presence_hidden"] is False and auto["presence_manual"] is None
    assert auto["dnd_until"] is None
    assert hub.presence_status(alice.id) == "online"
    stored = await db.scalar(select(User.presence_manual).where(User.id == alice.id))
    assert stored is None


async def test_custom_until_today_in_my_zone_and_validation(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    at = (utcnow() + timedelta(hours=3)).replace(microsecond=0)
    custom = (await _put(client, status="dnd", until=at.isoformat())).json()
    assert datetime.fromisoformat(custom["dnd_until"]) == at

    today = (await _put(client, status="dnd", duration="today", tz="America/New_York")).json()
    local = datetime.fromisoformat(today["dnd_until"]).astimezone(ZoneInfo("America/New_York"))
    assert (local.hour, local.minute, local.second) == (23, 59, 59)
    assert local.date() == utcnow().astimezone(ZoneInfo("America/New_York")).date()

    # Without tz: my quiet hours' zone, else Asia/Tokyo.
    plain = (await _put(client, status="dnd", duration="tomorrow")).json()
    tokyo = datetime.fromisoformat(plain["dnd_until"]).astimezone(ZoneInfo("Asia/Tokyo"))
    assert tokyo.date() == utcnow().astimezone(ZoneInfo("Asia/Tokyo")).date() + timedelta(days=1)
    assert (tokyo.hour, tokyo.minute) == (23, 59)

    past = (utcnow() - timedelta(minutes=1)).isoformat()
    for bad in (
        {"status": "dnd"},  # needs a duration or until
        {"status": "dnd", "duration": "30m", "until": at.isoformat()},
        {"status": "dnd", "duration": "3h"},
        {"status": "dnd", "until": past},
        {"status": "dnd", "duration": "today", "tz": "Mars/Olympus"},
        {"status": "away", "duration": "30m"},
        {"status": "invisible", "until": at.isoformat()},
        {"status": "busy"},
        {"status": "auto", "extra": 1},
    ):
        response = await client.put("/api/v1/users/me/presence", json=bad)
        assert response.status_code == 422, bad


async def test_settings_pause_is_the_same_dnd(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """「通知を一時停止」 (PATCH dnd_until) and 取り込み中 are one state; 自動 resumes them."""
    alice = await make_user(db, "alice")
    as_user(alice)
    later = (utcnow() + timedelta(hours=1)).isoformat()
    paused = (await client.patch("/api/v1/users/me", json={"dnd_until": later})).json()
    assert paused["dnd_until"] is not None
    resumed = (await _put(client, status="auto")).json()
    assert resumed["dnd_until"] is None
    me = (await client.get("/api/v1/users/me")).json()
    assert me["dnd_until"] is None


async def test_change_reaches_my_devices_and_old_clients_read_it(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    before = {e.id for e in (await db.execute(select(OutboxEvent))).scalars()}
    await _put(client, status="dnd", duration="forever")
    await _put(client, status="away")
    events = [e for e in (await db.execute(select(OutboxEvent))).scalars() if e.id not in before]
    assert [e.event_type for e in events] == ["user.updated", "user.updated"]
    first, second = (e.payload["user"] for e in events)
    # The payload is the old UserPublic: dnd_until an ISO instant (year 9999 for 解除するまで), no
    # new enum values; the private choice stays out of it.
    assert first["dnd_until"].startswith("9999-12-31T00:00:00")
    assert second["dnd_until"] is None
    assert "presence_manual" not in second and "presence_hidden" not in second
    assert datetime.fromisoformat(second["updated_at"]) >= datetime.fromisoformat(
        first["updated_at"]
    )


def test_hub_manual_away_and_hidden() -> None:
    hub = RealtimeHub()
    user, watcher = uuid.uuid4(), uuid.uuid4()
    seen = hub.new_connection(watcher, uuid.uuid4())
    hub.new_connection(user, uuid.uuid4(), presence_away=True)
    assert hub.presence_status(user) == "away"
    # Activity still counts for pushes (PUSH_NOTIFICATIONS.md §4.1), only the announcement changes.
    assert hub.is_active(user, 60)
    assert {"type": "presence", "user_id": str(user), "status": "away"} in _drain(seen)
    hub.set_presence_flags(user, hidden=True, away=True, version=_v(1))  # hidden wins over away
    assert hub.presence_status(user) == "offline"
    hub.set_presence_flags(user, hidden=False, away=True, version=_v(2))
    hub.set_presence_flags(user, hidden=False, away=False, version=_v(3))
    frames = _drain(seen)
    assert frames[-1] == {"type": "presence", "user_id": str(user), "status": "online"}
    assert {f["status"] for f in frames if f.get("type") == "presence"} <= {
        "online",
        "away",
        "offline",
    }


def test_hub_menu_choice_is_one_announcement() -> None:
    """invisible → 離席中 (and back) is one frame: both flags change together, so nobody sees a
    passing online (two separate setters announced ['online', 'away'])."""
    hub = RealtimeHub()
    user, watcher = uuid.uuid4(), uuid.uuid4()
    seen = hub.new_connection(watcher, uuid.uuid4())
    hub.new_connection(user, uuid.uuid4(), presence_hidden=True)
    assert _presence_of(seen, user) == []
    hub.set_presence_flags(user, hidden=False, away=True, version=_v(1))
    assert _presence_of(seen, user) == ["away"]
    hub.set_presence_flags(user, hidden=True, away=False, version=_v(2))
    assert _presence_of(seen, user) == ["offline"]
    # The settings' 在席を隠す (PATCH /users/me) passes the row's manual away along: it stays.
    hub.set_presence_flags(user, hidden=False, away=True, version=_v(3))
    assert _presence_of(seen, user) == ["away"]
    hub.set_presence_flags(user, hidden=True, away=True, version=_v(4))
    assert _presence_of(seen, user) == ["offline"]
    hub.set_presence_flags(user, hidden=False, away=True, version=_v(5))
    assert _presence_of(seen, user) == ["away"]
    # Nothing changes: nothing is announced.
    hub.set_presence_flags(user, hidden=False, away=True, version=_v(6))
    assert _presence_of(seen, user) == []


async def test_dnd_from_the_menu_stops_pushes(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    await db.commit()
    as_user(bob)
    assert (await _put(client, status="dnd", duration="forever")).status_code == 200
    await post(db, alice, dm.id)
    relay = relay_with_planner(app, test_settings)
    while await relay.process_batch():
        pass
    assert await deliveries(db) == []
    # 離席中 does not silence anything.
    assert (await _put(client, status="away")).status_code == 200
    await post(db, alice, dm.id, body="again")
    while await relay.process_batch():
        pass
    assert len(await deliveries(db)) == 1
