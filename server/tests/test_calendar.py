"""Calendar (M51, CALENDAR.md): the API, authorization, events, alarms and their pushes."""

import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any, cast
from zoneinfo import ZoneInfo

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.events.outbox import OutboxRelay
from app.modules.calendar import service as calendar
from app.modules.calendar.models import CalendarEventAlarm
from app.modules.channels import service as channels
from app.modules.notifications.planner import PushPlanner
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_outbox import RecordingBus
from tests.test_push_planner import add_device, deliveries

EVENTS = "/api/v1/calendar/events"
# A fixed future day: 14:00 in Tokyo is 05:00 UTC.
DAY = date(2030, 1, 10)
AT_14_JST = datetime(2030, 1, 10, 5, 0, tzinfo=UTC)


def timed(title: str, start: datetime, minutes: int = 60, **extra: Any) -> dict[str, Any]:
    return {
        "title": title,
        "starts_at": start.isoformat(),
        "ends_at": (start + timedelta(minutes=minutes)).isoformat(),
        **extra,
    }


def all_day(title: str, start: date, end: date | None = None, **extra: Any) -> dict[str, Any]:
    return {
        "title": title,
        "all_day": True,
        "start_date": start.isoformat(),
        "end_date": (end or start).isoformat(),
        **extra,
    }


async def _create(client: AsyncClient, body: dict[str, Any], status: int = 201) -> dict[str, Any]:
    response = await client.post(EVENTS, json=body)
    assert response.status_code == status, response.text
    return cast(dict[str, Any], response.json())


async def _range(
    client: AsyncClient, start: str, end: str, channel_id: str | None = None
) -> list[dict[str, Any]]:
    params = {"from": start, "to": end}
    if channel_id:
        params["channel_id"] = channel_id
    response = await client.get(EVENTS, params=params)
    assert response.status_code == 200, response.text
    return cast(list[dict[str, Any]], response.json())


async def _titles(client: AsyncClient, start: str, end: str) -> set[str]:
    return {e["title"] for e in await _range(client, start, end)}


async def _channel(client: AsyncClient, name: str, **extra: Any) -> dict[str, Any]:
    response = await client.post("/api/v1/channels", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return cast(dict[str, Any], response.json())


async def _outbox(db: AsyncSession, event_type: str) -> list[OutboxEvent]:
    stmt = select(OutboxEvent).where(OutboxEvent.event_type == event_type).order_by(OutboxEvent.id)
    return list((await db.execute(stmt)).scalars().all())


async def _alarm_row(app: FastAPI, event_id: str, user_id: uuid.UUID) -> CalendarEventAlarm | None:
    async with app.state.db.session_factory() as session:
        row: CalendarEventAlarm | None = await session.get(
            CalendarEventAlarm, (uuid.UUID(event_id), user_id)
        )
        return row


def _relay(app: FastAPI, settings: Settings) -> OutboxRelay:
    planner = PushPlanner(settings, is_active=lambda _uid: False)
    return OutboxRelay(
        app.state.db,
        RecordingBus(),
        channels.resolve_event_audience,
        handlers=[planner, calendar.CalendarLeaveHandler()],
    )


async def _drain(relay: OutboxRelay) -> None:
    while await relay.process_batch():
        pass


async def test_personal_events_crud_and_validation(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    start = datetime(2030, 1, 10, 5, 0, tzinfo=UTC)
    key = str(uuid.uuid4())
    body = timed(
        " ゼミ  準備 ",
        start.astimezone(),
        90,
        location=" 5 号館 ",
        description="資料を **印刷**",
        client_event_id=key,
    )
    made = await _create(client, body)
    assert made["title"] == "ゼミ 準備" and made["location"] == "5 号館"
    assert made["channel_id"] is None and made["channel_name"] is None
    assert made["owner_id"] == str(alice.id) and made["can_edit"] is True
    assert made["starts_at"].startswith("2030-01-10T05:00:00") and made["alarm"] is None
    # A retry with the same key returns the same event (200), not a second one.
    again = await _create(client, body, status=200)
    assert again["id"] == made["id"]
    listed = await _range(client, "2030-01-10T00:00:00+09:00", "2030-01-11T00:00:00+09:00")
    assert [e["id"] for e in listed] == [made["id"]]
    assert (await client.get(f"{EVENTS}/{made['id']}")).json()["title"] == "ゼミ 準備"

    changed = await client.patch(
        f"{EVENTS}/{made['id']}", json={"title": "ゼミ", "location": " ", "description": None}
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["title"] == "ゼミ" and changed.json()["location"] is None
    assert changed.json()["description"] is None
    # Turning it all-day needs the dates; times of the other kind are refused.
    half = await client.patch(f"{EVENTS}/{made['id']}", json={"all_day": True})
    assert half.status_code == 400 and half.json()["error"]["code"] == "calendar_invalid_time"
    mixed = await client.patch(
        f"{EVENTS}/{made['id']}",
        json={
            "all_day": True,
            "start_date": "2030-01-10",
            "end_date": "2030-01-10",
            "starts_at": start.isoformat(),
        },
    )
    assert mixed.status_code == 400
    turned = await client.patch(
        f"{EVENTS}/{made['id']}",
        json={"all_day": True, "start_date": "2030-01-10", "end_date": "2030-01-11"},
    )
    assert turned.status_code == 200, turned.text
    out = turned.json()
    assert out["all_day"] is True and out["starts_at"] is None and out["end_date"] == "2030-01-11"
    null_title = await client.patch(f"{EVENTS}/{made['id']}", json={"title": None})
    assert null_title.status_code == 400

    async def refused(payload: dict[str, Any], status: int, code: str | None = None) -> None:
        response = await client.post(EVENTS, json=payload)
        assert response.status_code == status, (payload, response.text)
        if code:
            assert response.json()["error"]["code"] == code

    await refused(timed("   ", start), 422)
    await refused(timed("x" * 201, start), 422)
    await refused(timed("ok", start, location="x" * 201), 422)
    await refused(timed("ok", start, description="x" * 4001), 422)
    await refused(timed("ok", start, 0), 400, "calendar_invalid_time")
    await refused(timed("ok", start, -30), 400, "calendar_invalid_time")
    await refused(timed("ok", start, 14 * 24 * 60 + 1), 400, "calendar_event_too_long")
    await _create(client, timed("two weeks", start, 14 * 24 * 60))
    await refused(
        {"title": "naive", "starts_at": "2030-01-10T10:00:00", "ends_at": "2030-01-10T11:00:00"},
        422,
    )
    await refused({"title": "no time"}, 400, "calendar_invalid_time")
    await refused(all_day("back", DAY, DAY - timedelta(days=1)), 400, "calendar_invalid_time")
    await refused(all_day("long", DAY, DAY + timedelta(days=60)), 400, "calendar_event_too_long")
    await _create(client, all_day("sixty", DAY, DAY + timedelta(days=59)))
    await refused(
        all_day("both", DAY) | {"starts_at": start.isoformat()}, 400, "calendar_invalid_time"
    )
    await refused(timed("alarm", start, alarm_minutes=-480), 400, "calendar_invalid_alarm")
    await refused(timed("alarm", start, alarm_minutes=7), 400, "calendar_invalid_alarm")
    await refused(all_day("alarm", DAY, alarm_minutes=30), 400, "calendar_invalid_alarm")
    await refused(timed("zone", start, alarm_minutes=5, tz="Mars/Base"), 422)
    await refused(timed("extra", start) | {"owner_id": str(uuid.uuid4())}, 422)

    too_long = await client.get(
        EVENTS, params={"from": "2030-01-01T00:00:00+09:00", "to": "2030-04-12T00:00:00+09:00"}
    )
    assert too_long.status_code == 400
    assert too_long.json()["error"]["code"] == "calendar_invalid_range"
    backwards = await client.get(
        EVENTS, params={"from": "2030-01-02T00:00:00+09:00", "to": "2030-01-01T00:00:00+09:00"}
    )
    assert backwards.status_code == 400
    ok = await client.get(
        EVENTS, params={"from": "2030-01-01T00:00:00+09:00", "to": "2030-04-11T00:00:00+09:00"}
    )
    assert ok.status_code == 200

    assert (await client.delete(f"{EVENTS}/{made['id']}")).status_code == 204
    assert (await client.get(f"{EVENTS}/{made['id']}")).status_code == 404
    assert (await client.delete(f"{EVENTS}/{made['id']}")).status_code == 404
    assert made["id"] not in {
        e["id"] for e in await _range(client, "2030-01-01T00:00:00Z", "2030-02-01T00:00:00Z")
    }


async def test_range_overlap_timed_and_all_day(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    ten = datetime(2030, 1, 10, 10, 0, tzinfo=UTC)
    await _create(client, timed("ten", ten, 60))  # [10:00, 11:00)
    await _create(client, timed("long", ten - timedelta(days=3), 5 * 24 * 60))  # spans the 10th
    await _create(client, all_day("one day", DAY))
    await _create(client, all_day("span", DAY - timedelta(days=5), DAY + timedelta(days=5)))
    await _create(client, all_day("next", DAY + timedelta(days=1)))

    z = "+00:00"
    # Ends exactly at `from` or starts exactly at `to`: not overlapping.
    assert "ten" not in await _titles(client, f"2030-01-10T11:00:00{z}", f"2030-01-10T12:00:00{z}")
    assert "ten" not in await _titles(client, f"2030-01-10T09:00:00{z}", f"2030-01-10T10:00:00{z}")
    assert "ten" in await _titles(client, f"2030-01-10T10:59:00{z}", f"2030-01-10T12:00:00{z}")
    assert "ten" in await _titles(client, f"2030-01-10T09:00:00{z}", f"2030-01-10T10:01:00{z}")
    # An event longer than the range, around it.
    assert "long" in await _titles(client, f"2030-01-09T00:00:00{z}", f"2030-01-09T01:00:00{z}")
    assert "long" not in await _titles(client, f"2030-01-12T10:00:00{z}", f"2030-01-13T00:00:00{z}")

    # All-day events by date, in the offset the range was given in (the device's midnights).
    tokyo_10th = await _titles(client, "2030-01-10T00:00:00+09:00", "2030-01-11T00:00:00+09:00")
    assert {"one day", "span"} <= tokyo_10th and "next" not in tokyo_10th
    tokyo_9th = await _titles(client, "2030-01-09T00:00:00+09:00", "2030-01-10T00:00:00+09:00")
    assert "one day" not in tokyo_9th and "span" in tokyo_9th
    later = await _titles(client, "2030-01-15T00:00:00+09:00", "2030-01-16T00:00:00+09:00")
    assert later == {"span"}
    after = await _titles(client, "2030-01-16T00:00:00+09:00", "2030-01-17T00:00:00+09:00")
    assert after == set()
    # A range ending mid-day still takes that day.
    assert "next" in await _titles(client, "2030-01-10T12:00:00+09:00", "2030-01-11T00:00:01+09:00")


async def test_authorization_matrix(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")  # creates #general: its owner
    bob = await make_user(db, "bob")  # member, creates the event
    george = await make_user(db, "george")  # another member
    carol = await make_user(db, "carol")  # not a member
    dave = await make_user(db, "dave", role="guest")  # a guest member
    eve = await make_user(db, "eve", role="admin")  # administrator, not a member
    frank = await make_user(db, "frank", role="admin")  # administrator and member
    as_user(alice)
    general = await _channel(client, "general")
    secret = await _channel(client, "secret", type="private")
    for user in (bob, george, frank):
        as_user(user)
        assert (await client.post(f"/api/v1/channels/{general['id']}/join")).status_code == 200
    as_user(alice)
    added = await client.post(
        f"/api/v1/channels/{general['id']}/members", json={"user_id": str(dave.id)}
    )
    assert added.status_code == 200, added.text

    start = datetime(2030, 1, 10, 5, 0, tzinfo=UTC)
    rng = ("2030-01-10T00:00:00+09:00", "2030-01-11T00:00:00+09:00")
    as_user(bob)
    personal = await _create(client, timed("bob only", start))
    shared = await _create(client, timed("ゼミ", start, channel_id=general["id"]))
    assert shared["channel_name"] == "general" and shared["can_edit"] is True

    # A personal event: nobody else, administrators included.
    for other in (alice, eve):
        as_user(other)
        url = f"{EVENTS}/{personal['id']}"
        assert (await client.get(url)).status_code == 404
        assert (await client.patch(url, json={"title": "x"})).status_code == 404
        assert (await client.delete(url)).status_code == 404
        assert (await client.put(f"{url}/alarm", json={"minutes_before": 5})).status_code == 404
        assert personal["id"] not in {e["id"] for e in await _range(client, *rng)}

    # A shared event: members see it; non-members get 404 and nothing in their lists.
    url = f"{EVENTS}/{shared['id']}"
    for viewer, can_edit in ((alice, True), (george, False), (dave, False), (frank, True)):
        as_user(viewer)
        seen = await client.get(url)
        assert seen.status_code == 200 and seen.json()["can_edit"] is can_edit, viewer.username
        listed = await _range(client, *rng)
        assert [(e["id"], e["can_edit"]) for e in listed] == [(shared["id"], can_edit)]
    for outsider in (carol, eve):
        as_user(outsider)
        assert (await client.get(url)).status_code == 404
        assert (await client.patch(url, json={"title": "x"})).status_code == 404
        assert (await client.delete(url)).status_code == 404
        assert (await client.put(f"{url}/alarm", json={"minutes_before": 5})).status_code == 404
        assert await _range(client, *rng) == []
        filtered = await client.get(
            EVENTS, params={"from": rng[0], "to": rng[1], "channel_id": general["id"]}
        )
        assert filtered.status_code == 403
        made = await client.post(EVENTS, json=timed("x", start, channel_id=general["id"]))
        assert made.status_code == 403 and made.json()["error"]["code"] == "not_a_member"

    # Members who did not make it cannot change it; everyone who sees it may set an alarm.
    for viewer in (george, dave):
        as_user(viewer)
        denied = await client.patch(url, json={"title": "x"})
        assert denied.status_code == 403
        assert denied.json()["error"]["code"] == "calendar_edit_restricted"
        assert (await client.delete(url)).status_code == 403
        alarm = await client.put(f"{url}/alarm", json={"minutes_before": 10, "tz": "Asia/Tokyo"})
        assert alarm.status_code == 200 and alarm.json()["alarm"]["minutes_before"] == 10
    for editor, title in ((bob, "ゼミ (1)"), (alice, "ゼミ (2)"), (frank, "ゼミ (3)")):
        as_user(editor)
        edited = await client.patch(url, json={"title": title})
        assert edited.status_code == 200 and edited.json()["title"] == title
    # A guest member may add to the channel's calendar (they may post there).
    as_user(dave)
    by_guest = await _create(client, timed("guest", start, channel_id=general["id"]))
    assert by_guest["can_edit"] is True

    # Filtered by channel: that channel's events only.
    as_user(bob)
    only = await client.get(
        EVENTS, params={"from": rng[0], "to": rng[1], "channel_id": general["id"]}
    )
    assert {e["id"] for e in only.json()} == {shared["id"], by_guest["id"]}

    # A private channel: 404 for non-members.
    as_user(alice)
    hidden = await _create(client, timed("secret", start, channel_id=secret["id"]))
    as_user(bob)
    assert (await client.get(f"{EVENTS}/{hidden['id']}")).status_code == 404

    # DMs have no calendar; an announcement channel takes events from its owners only.
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(alice.id)]})).json()
    in_dm = await client.post(EVENTS, json=timed("x", start, channel_id=dm["id"]))
    assert in_dm.status_code == 400
    assert in_dm.json()["error"]["code"] == "calendar_channel_unsupported"
    as_user(alice)
    policy = await client.patch(
        f"/api/v1/channels/{general['id']}", json={"posting_policy": "owners"}
    )
    assert policy.status_code == 200
    as_user(bob)
    restricted = await client.post(EVENTS, json=timed("x", start, channel_id=general["id"]))
    assert restricted.status_code == 403
    assert restricted.json()["error"]["code"] == "posting_restricted"
    as_user(frank)
    await _create(client, timed("by admin", start, channel_id=general["id"]))

    # An archived channel: still visible, read-only.
    as_user(alice)
    assert (await client.post(f"/api/v1/channels/{general['id']}/archive")).status_code == 200
    archived = await client.post(EVENTS, json=timed("x", start, channel_id=general["id"]))
    assert archived.status_code == 409 and archived.json()["error"]["code"] == "channel_archived"
    as_user(bob)
    frozen = await client.patch(url, json={"title": "x"})
    assert frozen.status_code == 409
    assert (await client.delete(url)).status_code == 409
    seen = await client.get(url)
    assert seen.status_code == 200 and seen.json()["can_edit"] is False


async def test_events_and_their_audiences(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol", role="admin")
    as_user(alice)
    general = await _channel(client, "general")
    for user in (bob, carol):
        as_user(user)
        await client.post(f"/api/v1/channels/{general['id']}/join")
    start = datetime(2030, 1, 10, 5, 0, tzinfo=UTC)

    as_user(bob)
    shared = await _create(
        client, timed("ゼミ", start, channel_id=general["id"], alarm_minutes=30, tz="Asia/Tokyo")
    )
    personal = await _create(client, timed("mine", start))
    await client.patch(f"{EVENTS}/{shared['id']}", json={"title": "ゼミ!"})
    await client.delete(f"{EVENTS}/{personal['id']}")

    updated = await _outbox(db, "calendar.event.updated")
    assert [e.payload["event"]["title"] for e in updated] == ["ゼミ", "mine", "ゼミ!"]
    first = updated[0]
    assert first.audience_type == "channel" and first.channel_id == uuid.UUID(general["id"])
    assert first.seq is None
    assert "can_edit" not in first.payload["event"] and "alarm" not in first.payload["event"]
    # The creator, the owner (alice) and the administrator among the members (carol).
    assert set(first.payload["editor_ids"]) == {str(alice.id), str(bob.id), str(carol.id)}
    audience = await channels.resolve_event_audience(db, first)
    assert set(audience.ids) == {alice.id, bob.id, carol.id}
    mine = updated[1]
    assert mine.audience_type == "user" and mine.audience_id == bob.id
    assert mine.channel_id is None and mine.payload["editor_ids"] == [str(bob.id)]

    deleted = await _outbox(db, "calendar.event.deleted")
    assert len(deleted) == 1 and deleted[0].payload == {"id": personal["id"], "channel_id": None}
    assert deleted[0].audience_type == "user" and deleted[0].audience_id == bob.id

    alarms = await _outbox(db, "calendar.alarm.updated")
    assert len(alarms) == 1
    assert alarms[0].audience_type == "user" and alarms[0].audience_id == bob.id
    assert alarms[0].payload["event_id"] == shared["id"]
    assert alarms[0].payload["alarm"]["minutes_before"] == 30
    assert alarms[0].payload["alarm"]["status"] == "pending"

    # Removing an alarm tells my devices; an archived channel has no editors.
    await client.delete(f"{EVENTS}/{shared['id']}/alarm")
    last = (await _outbox(db, "calendar.alarm.updated"))[-1]
    assert last.payload["alarm"] is None
    as_user(alice)
    await client.post(f"/api/v1/channels/{general['id']}/archive")
    as_user(carol)
    # Nothing to change in an archived channel, but its events stay readable.
    assert (await client.get(f"{EVENTS}/{shared['id']}")).status_code == 200


async def test_alarms_are_computed_and_rescheduled(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    made = await _create(client, timed("ゼミ", AT_14_JST, alarm_minutes=30, tz="Asia/Tokyo"))
    assert made["alarm"]["status"] == "pending"
    assert made["alarm"]["fire_at"].startswith("2030-01-10T04:30:00")

    # The time moves: the alarm follows.
    moved = await client.patch(
        f"{EVENTS}/{made['id']}",
        json={
            "starts_at": (AT_14_JST + timedelta(hours=1)).isoformat(),
            "ends_at": (AT_14_JST + timedelta(hours=2)).isoformat(),
        },
    )
    assert moved.json()["alarm"]["fire_at"].startswith("2030-01-10T05:30:00")
    # A title change leaves it alone (no alarm event).
    before = len(await _outbox(db, "calendar.alarm.updated"))
    await client.patch(f"{EVENTS}/{made['id']}", json={"title": "ゼミ 2"})
    assert len(await _outbox(db, "calendar.alarm.updated")) == before

    # All-day: 30 分前 becomes 当日 8:00 (in the alarm's zone); 前日 is 8:00 the day before.
    day = await client.patch(
        f"{EVENTS}/{made['id']}",
        json={"all_day": True, "start_date": "2030-01-10", "end_date": "2030-01-10"},
    )
    assert day.json()["alarm"]["minutes_before"] == -480
    assert day.json()["alarm"]["fire_at"].startswith("2030-01-09T23:00:00")  # 8:00 JST
    eve = await client.put(
        f"{EVENTS}/{made['id']}/alarm", json={"minutes_before": 1440, "tz": "Asia/Tokyo"}
    )
    assert eve.json()["alarm"]["fire_at"].startswith("2030-01-08T23:00:00")
    ny = await client.put(
        f"{EVENTS}/{made['id']}/alarm", json={"minutes_before": -480, "tz": "America/New_York"}
    )
    assert ny.json()["alarm"]["fire_at"].startswith("2030-01-10T13:00:00")
    # Back to a timed event: 当日 8:00 becomes 1 時間前.
    back = await client.patch(
        f"{EVENTS}/{made['id']}",
        json={
            "all_day": False,
            "starts_at": AT_14_JST.isoformat(),
            "ends_at": (AT_14_JST + timedelta(hours=1)).isoformat(),
        },
    )
    assert back.json()["alarm"]["minutes_before"] == 60
    assert back.json()["alarm"]["fire_at"].startswith("2030-01-10T04:00:00")

    # Moved into the past: not sent (cancelled); moved ahead again: pending again.
    past = utcnow() - timedelta(hours=3)
    gone = await client.patch(
        f"{EVENTS}/{made['id']}",
        json={"starts_at": past.isoformat(), "ends_at": (past + timedelta(hours=1)).isoformat()},
    )
    assert gone.json()["alarm"]["status"] == "cancelled"
    await client.patch(
        f"{EVENTS}/{made['id']}",
        json={
            "starts_at": AT_14_JST.isoformat(),
            "ends_at": (AT_14_JST + timedelta(hours=1)).isoformat(),
        },
    )
    assert (await client.get(f"{EVENTS}/{made['id']}")).json()["alarm"]["status"] == "pending"

    # Without a zone: the quiet-hours zone, else Asia/Tokyo.
    plain = await client.put(f"{EVENTS}/{made['id']}/alarm", json={"minutes_before": 0})
    assert plain.json()["alarm"]["fire_at"].startswith("2030-01-10T05:00:00")
    row = await _alarm_row(app, made["id"], alice.id)
    assert row is not None and row.tz == "Asia/Tokyo"

    # Deleting the event cancels its alarms; removing mine deletes it.
    assert (await client.delete(f"{EVENTS}/{made['id']}/alarm")).status_code == 204
    assert (await client.get(f"{EVENTS}/{made['id']}")).json()["alarm"] is None
    await client.put(f"{EVENTS}/{made['id']}/alarm", json={"minutes_before": 5})
    await client.delete(f"{EVENTS}/{made['id']}")
    row = await _alarm_row(app, made["id"], alice.id)
    assert row is not None and row.status == "cancelled"


async def test_due_alarms_fire_once_and_push(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    as_user(alice)
    general = await _channel(client, "m2-進捗")
    as_user(bob)
    await client.post(f"/api/v1/channels/{general['id']}/join")
    zemi = await _create(
        client,
        timed("ゼミ", AT_14_JST, channel_id=general["id"], alarm_minutes=10, tz="Asia/Tokyo"),
    )
    await _create(client, all_day("学会", DAY, alarm_minutes=1440, tz="Asia/Tokyo"))
    # Alice's alarm on the same event is hers alone (she has no device).
    as_user(alice)
    await client.put(f"{EVENTS}/{zemi['id']}/alarm", json={"minutes_before": 10})

    async with app.state.db.session_factory() as worker:
        assert await calendar.fire_due(worker, now=datetime(2030, 1, 8, 0, 0, tzinfo=UTC)) == 0
        # 前日 8:00 JST (the 8th, 23:00 UTC): the conference.
        assert await calendar.fire_due(worker, now=datetime(2030, 1, 8, 23, 1, tzinfo=UTC)) == 1
        assert await calendar.fire_due(worker, now=datetime(2030, 1, 10, 4, 51, tzinfo=UTC)) == 2
        assert await calendar.fire_due(worker, now=datetime(2030, 1, 10, 4, 52, tzinfo=UTC)) == 0

    relay = _relay(app, test_settings)
    await _drain(relay)
    rows = await deliveries(db)
    assert len(rows) == 2 and all(r.user_id == bob.id for r in rows)
    bodies = {r.payload["body"]: r.payload for r in rows}
    assert set(bodies) == {"明日 終日 学会", "14:00 ゼミ (#m2-進捗)"}
    push = bodies["14:00 ゼミ (#m2-進捗)"]
    assert push["kind"] == "calendar" and push["title"] == "予定"
    assert push["channel_id"] == general["id"] and push["event_id"] == zemi["id"]
    assert push["collapse_key"] == f"calendar:{zemi['id']}"
    assert bodies["明日 終日 学会"]["channel_id"] is None
    # Re-processing plans nothing more.
    await _drain(relay)
    assert len(await deliveries(db)) == 2
    as_user(bob)
    assert (await client.get(f"{EVENTS}/{zemi['id']}")).json()["alarm"]["status"] == "fired"


async def test_alarms_respect_dnd_and_skip_what_is_over(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    as_user(bob)
    soon = utcnow() + timedelta(minutes=20)
    await _create(client, timed("dnd", soon, alarm_minutes=10))
    bob.dnd_until = utcnow() + timedelta(hours=2)
    await db.commit()
    async with app.state.db.session_factory() as worker:
        assert await calendar.fire_due(worker, now=soon - timedelta(minutes=9)) == 1
    await _drain(_relay(app, test_settings))
    assert await deliveries(db) == []

    # The server was down past the event's end: the alarm is dropped, not sent late.
    later = await _create(client, timed("over", soon + timedelta(hours=1), alarm_minutes=5))
    async with app.state.db.session_factory() as worker:
        assert await calendar.fire_due(worker, now=soon + timedelta(hours=3)) == 0
    as_user(bob)
    assert (await client.get(f"{EVENTS}/{later['id']}")).json()["alarm"]["status"] == "cancelled"


async def test_leaving_a_channel_drops_the_alarms(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    await add_device(db, bob)
    await add_device(db, carol, token="carol-tok")
    as_user(alice)
    general = await _channel(client, "general")
    for user in (bob, carol):
        as_user(user)
        await client.post(f"/api/v1/channels/{general['id']}/join")
    as_user(alice)
    event = await _create(client, timed("ゼミ", AT_14_JST, channel_id=general["id"]))
    for user in (bob, carol):
        as_user(user)
        await client.put(f"{EVENTS}/{event['id']}/alarm", json={"minutes_before": 10})
    await _drain(_relay(app, test_settings))

    # Bob leaves: the outbox handler drops his alarm.
    as_user(bob)
    assert (await client.post(f"/api/v1/channels/{general['id']}/leave")).status_code == 204
    await _drain(_relay(app, test_settings))
    assert await _alarm_row(app, event["id"], bob.id) is None
    assert (await client.get(f"{EVENTS}/{event['id']}")).status_code == 404
    # Carol is removed but the handler has not run yet: the worker still does not send hers.
    as_user(alice)
    removed = await client.delete(f"/api/v1/channels/{general['id']}/members/{carol.id}")
    assert removed.status_code == 204
    async with app.state.db.session_factory() as worker:
        assert await calendar.fire_due(worker, now=datetime(2030, 1, 10, 4, 51, tzinfo=UTC)) == 0
    await _drain(_relay(app, test_settings))
    assert [r for r in await deliveries(db) if r.kind == "alert"] == []


async def test_upcoming_today_and_tomorrow(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    general = await _channel(client, "general")
    tokyo = ZoneInfo("Asia/Tokyo")
    now = utcnow()
    today = now.astimezone(tokyo).date()
    await _create(client, timed("going on", now - timedelta(minutes=10), 20))
    await _create(client, timed("over", now - timedelta(hours=2), 30))
    await _create(client, all_day("today", today, channel_id=general["id"]))
    await _create(client, all_day("tomorrow", today + timedelta(days=1)))
    await _create(client, all_day("later", today + timedelta(days=2)))
    await _create(client, all_day("since yesterday", today - timedelta(days=1), today))

    got = await client.get("/api/v1/calendar/upcoming", params={"tz": "Asia/Tokyo"})
    assert got.status_code == 200, got.text
    titles = [e["title"] for e in got.json()]
    assert set(titles) == {"going on", "today", "tomorrow", "since yesterday"}
    assert titles[-1] == "tomorrow"
    one = await client.get(
        "/api/v1/calendar/upcoming",
        params={"tz": "Asia/Tokyo", "days": 1, "channel_id": general["id"]},
    )
    assert [e["title"] for e in one.json()] == ["today"]
    bad = await client.get("/api/v1/calendar/upcoming", params={"tz": "Nowhere/Zone"})
    assert bad.status_code == 400
    for n in range(12):
        await _create(client, all_day(f"many {n}", today + timedelta(days=1)))
    assert len((await client.get("/api/v1/calendar/upcoming")).json()) == 10
