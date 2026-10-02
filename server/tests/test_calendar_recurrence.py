"""Recurring events and iCal feeds (M68, CALENDAR.md §10): the RRULE subset, its expansion (DST,
month ends, nth weekdays), overrides and the three scopes, alarms for the next occurrence, and the
iCal feed (its text, token, revocation and scope)."""

import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any, cast
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import redact_path
from app.core.settings import Settings
from app.events.models import OutboxEvent
from app.modules.calendar import ical, recurrence
from app.modules.calendar import service as calendar
from app.modules.calendar.models import CalendarEventAlarm, CalendarEventOverride
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_calendar import _channel, _create, _drain, _range, _relay, all_day, timed
from tests.test_push_planner import add_device, deliveries

EVENTS = "/api/v1/calendar/events"
FEEDS = "/api/v1/calendar/ical-feeds"
TOKYO = ZoneInfo("Asia/Tokyo")
NEW_YORK = ZoneInfo("America/New_York")


def jst(y: int, m: int, d: int, hh: int = 0, mm: int = 0) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=TOKYO)


def occ_url(series_id: str, key: str) -> str:
    return f"{EVENTS}/{series_id}/occurrences/{key}"


async def _days(client: AsyncClient, start: str, end: str) -> list[dict[str, Any]]:
    return await _range(client, start, end)


# --- the rule -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "normal"),
    [
        ("FREQ=DAILY", "FREQ=DAILY"),
        ("RRULE:freq=weekly;byday=th,tu;interval=1", "FREQ=WEEKLY;BYDAY=TU,TH"),
        ("FREQ=MONTHLY;BYDAY=2TU;COUNT=10", "FREQ=MONTHLY;BYDAY=2TU;COUNT=10"),
        ("FREQ=MONTHLY;BYDAY=-1FR", "FREQ=MONTHLY;BYDAY=-1FR"),
        ("FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20301231", "FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20301231"),
        ("FREQ=YEARLY;INTERVAL=2", "FREQ=YEARLY;INTERVAL=2"),
    ],
)
def test_rules_are_read_and_normalized(text: str, normal: str) -> None:
    assert recurrence.normalize(text) == normal


@pytest.mark.parametrize(
    "text",
    [
        "",
        "FREQ=HOURLY",
        "FREQ=WEEKLY;BYSETPOS=1",
        "FREQ=DAILY;BYHOUR=9",
        "FREQ=DAILY;BYDAY=MO",
        "FREQ=WEEKLY;BYDAY=2TU",
        "FREQ=MONTHLY;BYDAY=TU",
        "FREQ=MONTHLY;BYDAY=2TU,3TU",
        "FREQ=MONTHLY;BYDAY=6TU",
        "FREQ=MONTHLY;BYMONTHDAY=32",
        "FREQ=MONTHLY;BYMONTHDAY=10;BYDAY=1MO",
        "FREQ=YEARLY;BYMONTHDAY=1",
        "FREQ=DAILY;COUNT=3;UNTIL=20300101",
        "FREQ=DAILY;UNTIL=20300101T000000Z",
        "FREQ=DAILY;COUNT=0",
        "FREQ=DAILY;COUNT=1000",
        "FREQ=DAILY;INTERVAL=100",
        "FREQ=DAILY;WKST=SU",
        "FREQ=DAILY;FREQ=WEEKLY",
        "FREQ",
    ],
)
def test_rules_outside_the_subset_are_refused(text: str) -> None:
    with pytest.raises(recurrence.RRuleError):
        recurrence.parse(text)


def _dates(text: str, first: date, stop: date) -> list[date]:
    return list(recurrence.dates(recurrence.parse(text), first, stop=stop))


def test_expansion_of_month_ends_nth_weekdays_and_leap_days() -> None:
    # The 31st skips the months without one; -1 is every month's last day.
    assert _dates("FREQ=MONTHLY", date(2030, 1, 31), date(2030, 6, 1)) == [
        date(2030, 1, 31),
        date(2030, 3, 31),
        date(2030, 5, 31),
    ]
    assert _dates("FREQ=MONTHLY;BYMONTHDAY=-1", date(2030, 1, 31), date(2030, 4, 1)) == [
        date(2030, 1, 31),
        date(2030, 2, 28),
        date(2030, 3, 31),
    ]
    # 第 2 火曜日 and the last Friday.
    assert _dates("FREQ=MONTHLY;BYDAY=2TU;COUNT=3", date(2030, 1, 8), date.max) == [
        date(2030, 1, 8),
        date(2030, 2, 12),
        date(2030, 3, 12),
    ]
    assert _dates("FREQ=MONTHLY;BYDAY=-1FR", date(2030, 1, 25), date(2030, 5, 1)) == [
        date(2030, 1, 25),
        date(2030, 2, 22),
        date(2030, 3, 29),
        date(2030, 4, 26),
    ]
    # A 5th Monday exists only in some months.
    assert _dates("FREQ=MONTHLY;BYDAY=5MO", date(2030, 4, 29), date(2030, 10, 1)) == [
        date(2030, 4, 29),
        date(2030, 7, 29),
        date(2030, 9, 30),
    ]
    assert _dates("FREQ=YEARLY", date(2028, 2, 29), date(2037, 1, 1)) == [
        date(2028, 2, 29),
        date(2032, 2, 29),
        date(2036, 2, 29),
    ]
    # Every other week on Tuesday and Thursday until a date (included); DTSTART counts.
    assert _dates(
        "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20300124", date(2030, 1, 8), date.max
    ) == [date(2030, 1, 8), date(2030, 1, 10), date(2030, 1, 22), date(2030, 1, 24)]
    # A start off the rule is still the first occurrence and counts toward COUNT.
    assert _dates("FREQ=WEEKLY;BYDAY=MO;COUNT=3", date(2030, 1, 9), date.max) == [
        date(2030, 1, 9),
        date(2030, 1, 14),
        date(2030, 1, 21),
    ]
    # Skipping ahead lands on the same dates as walking.
    rule = recurrence.parse("FREQ=DAILY;INTERVAL=3")
    walked = [d for d in recurrence.dates(rule, date(2030, 1, 1), stop=date(2031, 1, 1))]
    ahead = list(
        recurrence.dates(rule, date(2030, 1, 1), stop=date(2031, 1, 1), after=date(2030, 7, 1))
    )
    assert ahead == [d for d in walked if d >= date(2030, 7, 1)]


async def test_timed_series_keep_their_wall_clock_across_dst(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    start = datetime(2030, 3, 4, 9, 0, tzinfo=NEW_YORK)  # Monday 9:00 EST
    made = await _create(
        client, timed("standup", start, 30, rrule="FREQ=WEEKLY;COUNT=3", tz="America/New_York")
    )
    assert made["recurring"] is True and made["rrule"] == "FREQ=WEEKLY;COUNT=3"
    assert made["tz"] == "America/New_York" and made["series_id"] == made["id"]
    rows = await _range(client, "2030-03-01T00:00:00Z", "2030-04-01T00:00:00Z")
    # 9:00 EST is 14:00 UTC; after 10 March 9:00 EDT is 13:00 UTC.
    assert [r["starts_at"][:16] for r in rows] == [
        "2030-03-04T14:00",
        "2030-03-11T13:00",
        "2030-03-18T13:00",
    ]
    assert [r["occurrence_start"] for r in rows] == [
        "2030-03-04T14:00:00Z",
        "2030-03-11T13:00:00Z",
        "2030-03-18T13:00:00Z",
    ]
    ids = [r["id"] for r in rows]
    assert ids[0] == made["id"] and len(set(ids)) == 3
    assert all(r["series_id"] == made["id"] and r["recurring"] for r in rows)
    assert all(r["ends_at"][11:16] in ("14:30", "13:30") for r in rows)

    # An invalid rule or an UNTIL before the start: 400.
    for bad in ("FREQ=HOURLY", "FREQ=DAILY;UNTIL=20300101"):
        response = await client.post(EVENTS, json=timed("x", start, rrule=bad))
        assert response.status_code == 400 and response.json()["error"]["code"] == (
            "calendar_invalid_rrule"
        )
    # The one-off API is unchanged (additions only).
    single = await _create(client, timed("once", start))
    assert single["recurring"] is False and single["rrule"] is None
    assert single["series_id"] == single["id"]
    assert single["occurrence_start"] == "2030-03-04T14:00:00Z"
    not_rec = await client.delete(
        occ_url(single["id"], single["occurrence_start"]), params={"scope": "this"}
    )
    assert not_rec.status_code == 400
    assert not_rec.json()["error"]["code"] == "calendar_not_recurring"


async def test_all_day_series_and_this_occurrence_only(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    made = await _create(
        client, all_day("当番", date(2030, 1, 7), rrule="FREQ=WEEKLY;BYDAY=MO,WE", tz="Asia/Tokyo")
    )
    days = "2030-01-01T00:00:00+09:00", "2030-01-21T00:00:00+09:00"
    rows = await _days(client, *days)
    assert [r["start_date"] for r in rows] == [
        "2030-01-07",
        "2030-01-09",
        "2030-01-14",
        "2030-01-16",
    ]
    sid = made["id"]
    # この予定だけ: a new title for one, another moved to Thursday, a third cancelled.
    changed = await client.patch(
        occ_url(sid, "2030-01-09"), json={"scope": "this", "title": "代理"}
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["title"] == "代理" and changed.json()["occurrence_start"] == "2030-01-09"
    moved = await client.patch(
        occ_url(sid, "2030-01-14"),
        json={"scope": "this", "start_date": "2030-01-17", "end_date": "2030-01-17"},
    )
    assert moved.status_code == 200 and moved.json()["start_date"] == "2030-01-17"
    gone = await client.delete(occ_url(sid, "2030-01-16"), params={"scope": "this"})
    assert gone.status_code == 204
    rows = await _days(client, *days)
    assert [(r["start_date"], r["title"], r["occurrence_start"]) for r in rows] == [
        ("2030-01-07", "当番", "2030-01-07"),
        ("2030-01-09", "代理", "2030-01-09"),
        ("2030-01-17", "当番", "2030-01-14"),
    ]
    # Moving the occurrence back to its own day leaves only the overrides that still change it.
    back = await client.patch(
        occ_url(sid, "2030-01-14"),
        json={"scope": "this", "start_date": "2030-01-14", "end_date": "2030-01-14"},
    )
    assert back.status_code == 200
    overrides = (
        (
            await db.execute(
                select(CalendarEventOverride).order_by(CalendarEventOverride.occurrence_start)
            )
        )
        .scalars()
        .all()
    )
    assert [(o.occurrence_start, o.cancelled, o.changed) for o in overrides] == [
        ("2030-01-09", False, ["title"]),
        ("2030-01-16", True, []),
    ]
    # Not an occurrence, a cancelled one, the kind or the rule of one occurrence: refused.
    assert (
        await client.patch(occ_url(sid, "2030-01-08"), json={"scope": "this", "title": "x"})
    ).status_code == 404
    assert (
        await client.patch(occ_url(sid, "2030-01-16"), json={"scope": "this", "title": "x"})
    ).status_code == 404
    assert (
        await client.patch(occ_url(sid, "nonsense"), json={"scope": "this", "title": "x"})
    ).status_code == 404
    kind = await client.patch(
        occ_url(sid, "2030-01-09"),
        json={
            "scope": "this",
            "all_day": False,
            "starts_at": "2030-01-09T01:00:00Z",
            "ends_at": "2030-01-09T02:00:00Z",
        },
    )
    assert kind.status_code == 400 and kind.json()["error"]["code"] == "calendar_invalid_time"
    rule = await client.patch(
        occ_url(sid, "2030-01-09"), json={"scope": "this", "rrule": "FREQ=DAILY"}
    )
    assert rule.json()["error"]["code"] == "calendar_invalid_rrule"


async def test_following_splits_the_series(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    made = await _create(
        client,
        timed(
            "ゼミ",
            jst(2030, 1, 7, 14),
            60,
            rrule="FREQ=WEEKLY;COUNT=6",
            tz="Asia/Tokyo",
            alarm_minutes=10,
        ),
    )
    sid = made["id"]
    keys = [f"2030-01-{d:02d}T05:00:00Z" for d in (7, 14, 21, 28)] + [
        "2030-02-04T05:00:00Z",
        "2030-02-11T05:00:00Z",
    ]
    # An override after the split point moves to the new series; one before stays.
    await client.patch(occ_url(sid, keys[1]), json={"scope": "this", "location": "501"})
    await client.patch(occ_url(sid, keys[4]), json={"scope": "this", "title": "特別ゼミ"})
    # From the 4th occurrence on: 15:00 and a new place.
    split = await client.patch(
        occ_url(sid, keys[3]),
        json={
            "scope": "following",
            "starts_at": jst(2030, 1, 28, 15).isoformat(),
            "ends_at": jst(2030, 1, 28, 16).isoformat(),
            "location": "502",
        },
    )
    assert split.status_code == 200, split.text
    new = split.json()
    assert new["series_id"] != sid and new["id"] == new["series_id"]
    # COUNT=6 with 3 before the split: 3 left.
    assert new["rrule"] == "FREQ=WEEKLY;COUNT=3" and new["location"] == "502"
    old = (await client.get(f"{EVENTS}/{sid}")).json()
    assert old["rrule"] == "FREQ=WEEKLY;UNTIL=20300127"
    rows = await _range(client, "2030-01-01T00:00:00+09:00", "2030-03-01T00:00:00+09:00")
    assert [(r["starts_at"][:16], r["title"], r["location"]) for r in rows] == [
        ("2030-01-07T05:00", "ゼミ", None),
        ("2030-01-14T05:00", "ゼミ", "501"),
        ("2030-01-21T05:00", "ゼミ", None),
        ("2030-01-28T06:00", "ゼミ", "502"),
        ("2030-02-04T06:00", "ゼミ", "502"),
        ("2030-02-11T06:00", "ゼミ", "502"),
    ]
    # The 4 February override was at 14:00: no longer an occurrence of the 15:00 series, gone.
    assert (await db.get(CalendarEventOverride, (uuid.UUID(sid), keys[4]))) is None
    # My alarm went over to the new series too.
    async with app.state.db.session_factory() as session:
        alarms = (
            (
                await session.execute(
                    select(CalendarEventAlarm).where(CalendarEventAlarm.user_id == alice.id)
                )
            )
            .scalars()
            .all()
        )
        assert {str(a.event_id) for a in alarms} == {sid, new["id"]}

    # Splitting at an unchanged time keeps the later overrides (moved to the new series).
    other = await _create(
        client, timed("輪講", jst(2030, 1, 8, 10), 60, rrule="FREQ=WEEKLY", tz="Asia/Tokyo")
    )
    oid = other["id"]
    later = "2030-01-29T01:00:00Z"
    await client.patch(occ_url(oid, later), json={"scope": "this", "title": "輪講 (休講?)"})
    split2 = await client.patch(
        occ_url(oid, "2030-01-22T01:00:00Z"), json={"scope": "following", "title": "輪講 B"}
    )
    assert split2.status_code == 200
    moved_over = await db.get(CalendarEventOverride, (uuid.UUID(split2.json()["id"]), later))
    assert moved_over is not None and moved_over.title == "輪講 (休講?)"

    # これ以降すべて on the first occurrence is the whole series.
    first = await client.patch(
        occ_url(oid, "2030-01-08T01:00:00Z"), json={"scope": "following", "title": "全部"}
    )
    assert first.json()["id"] == oid and first.json()["title"] == "全部"


async def test_all_shifts_the_series_and_keeps_overrides_that_still_fit(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    made = await _create(
        client, timed("会議", jst(2030, 1, 7, 14), 60, rrule="FREQ=DAILY;COUNT=5", tz="Asia/Tokyo")
    )
    sid = made["id"]
    await client.patch(
        occ_url(sid, "2030-01-09T05:00:00Z"), json={"scope": "this", "title": "会議 (短縮)"}
    )
    # すべての予定, only text: the override keeps its title, the rest follow the series.
    renamed = await client.patch(
        occ_url(sid, "2030-01-10T05:00:00Z"),
        json={"scope": "all", "title": "定例", "location": "A"},
    )
    assert renamed.status_code == 200 and renamed.json()["id"] == sid
    rows = await _range(client, "2030-01-07T00:00:00+09:00", "2030-01-12T00:00:00+09:00")
    assert [(r["title"], r["location"]) for r in rows] == [
        ("定例", "A"),
        ("定例", "A"),
        ("会議 (短縮)", "A"),
        ("定例", "A"),
        ("定例", "A"),
    ]
    # すべての予定 from the 4th occurrence, moved to 16:30 the day after: the series starts on
    # the 8th at 16:30 (shifted by a day), the 14:00 override no longer fits and goes.
    shifted = await client.patch(
        occ_url(sid, "2030-01-10T05:00:00Z"),
        json={
            "scope": "all",
            "starts_at": jst(2030, 1, 11, 16, 30).isoformat(),
            "ends_at": jst(2030, 1, 11, 17, 0).isoformat(),
        },
    )
    assert shifted.status_code == 200, shifted.text
    assert shifted.json()["starts_at"].startswith("2030-01-08T07:30")
    rows = await _range(client, "2030-01-07T00:00:00+09:00", "2030-01-14T00:00:00+09:00")
    assert [r["starts_at"][:16] for r in rows] == [
        f"2030-01-{d:02d}T07:30" for d in (8, 9, 10, 11, 12)
    ]
    assert all(r["title"] == "定例" for r in rows)
    assert (await db.execute(select(CalendarEventOverride))).scalars().all() == []

    # Deleting following ends the series the day before; deleting all removes it.
    gone = await client.delete(occ_url(sid, "2030-01-11T07:30:00Z"), params={"scope": "following"})
    assert gone.status_code == 204
    rows = await _range(client, "2030-01-07T00:00:00+09:00", "2030-01-14T00:00:00+09:00")
    assert len(rows) == 3
    assert (await client.get(f"{EVENTS}/{sid}")).json()["rrule"] == "FREQ=DAILY;UNTIL=20300110"
    assert (
        await client.delete(occ_url(sid, "2030-01-09T07:30:00Z"), params={"scope": "all"})
    ).status_code == 204
    assert await _range(client, "2030-01-07T00:00:00+09:00", "2030-01-14T00:00:00+09:00") == []
    # PATCH on the series itself can end the repeating (its overrides go).
    again = await _create(
        client, timed("x", jst(2030, 1, 7, 9), rrule="FREQ=DAILY", tz="Asia/Tokyo")
    )
    await client.delete(occ_url(again["id"], "2030-01-08T00:00:00Z"), params={"scope": "this"})
    plain = await client.patch(f"{EVENTS}/{again['id']}", json={"rrule": None})
    assert plain.status_code == 200 and plain.json()["recurring"] is False
    assert (await db.execute(select(CalendarEventOverride))).scalars().all() == []
    assert len(await _range(client, "2030-01-07T00:00:00+09:00", "2030-01-14T00:00:00+09:00")) == 1


async def test_series_changes_reach_devices_as_the_same_events(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    general = await _channel(client, "lab")
    made = await _create(
        client,
        timed(
            "ゼミ",
            jst(2030, 1, 7, 14),
            rrule="FREQ=WEEKLY",
            tz="Asia/Tokyo",
            channel_id=general["id"],
        ),
    )
    await client.patch(
        occ_url(made["id"], "2030-01-14T05:00:00Z"), json={"scope": "this", "title": "x"}
    )
    await client.delete(occ_url(made["id"], "2030-01-21T05:00:00Z"), params={"scope": "all"})
    stmt = (
        select(OutboxEvent)
        .where(OutboxEvent.event_type.like("calendar.event.%"))
        .order_by(OutboxEvent.id)
    )
    events = (await db.execute(stmt)).scalars().all()
    assert [e.event_type for e in events] == [
        "calendar.event.updated",
        "calendar.event.updated",
        "calendar.event.deleted",
    ]
    payload = events[1].payload["event"]
    assert payload["id"] == made["id"] and payload["recurring"] is True
    assert (
        payload["rrule"] == "FREQ=WEEKLY" and payload["occurrence_start"] == "2030-01-07T05:00:00Z"
    )
    assert events[2].payload == {"id": made["id"], "channel_id": general["id"]}


async def test_series_alarms_fire_for_each_next_occurrence(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    as_user(bob)
    made = await _create(
        client,
        timed(
            "朝会",
            jst(2030, 1, 7, 9),
            15,
            rrule="FREQ=DAILY;COUNT=4",
            tz="Asia/Tokyo",
            alarm_minutes=10,
        ),
    )
    sid = made["id"]
    alarm = made["alarm"]
    assert alarm["occurrence_start"] == "2030-01-07T00:00:00Z"
    assert alarm["fire_at"].startswith("2030-01-06T23:50")
    # The 8th is cancelled, the 9th moved to 10:00.
    await client.delete(occ_url(sid, "2030-01-08T00:00:00Z"), params={"scope": "this"})
    await client.patch(
        occ_url(sid, "2030-01-09T00:00:00Z"),
        json={
            "scope": "this",
            "starts_at": jst(2030, 1, 9, 10).isoformat(),
            "ends_at": jst(2030, 1, 9, 10, 15).isoformat(),
        },
    )

    async def row() -> CalendarEventAlarm:
        async with app.state.db.session_factory() as session:
            found: CalendarEventAlarm | None = await session.get(
                CalendarEventAlarm, (uuid.UUID(sid), bob.id)
            )
            assert found is not None
            return found

    fired_at = []
    async with app.state.db.session_factory() as worker:
        for moment in (
            datetime(2030, 1, 6, 23, 51, tzinfo=UTC),
            datetime(2030, 1, 6, 23, 52, tzinfo=UTC),  # nothing more for the 7th
            datetime(2030, 1, 9, 0, 51, tzinfo=UTC),  # the moved 9th (10:00 JST - 10)
            datetime(2030, 1, 9, 23, 51, tzinfo=UTC),  # the 10th
        ):
            fired_at.append(await calendar.fire_due(worker, now=moment))
    assert fired_at == [1, 0, 1, 1]
    last = await row()
    assert last.status == "cancelled" and last.occurrence_start is None  # the series is over

    await _drain(_relay(app, test_settings))
    bodies = sorted(r.payload["body"] for r in await deliveries(db))
    assert bodies == ["10:00 朝会", "9:00 朝会", "9:00 朝会"]
    # Each fired occurrence was announced with its key; the next one was booked after it.
    stmt = (
        select(OutboxEvent)
        .where(OutboxEvent.event_type == "calendar.alarm.updated")
        .order_by(OutboxEvent.id)
    )
    payloads = [e.payload["alarm"] for e in (await db.execute(stmt)).scalars().all()]
    fired = [p["occurrence_start"] for p in payloads if p and p["status"] == "fired"]
    assert fired == ["2030-01-07T00:00:00Z", "2030-01-09T00:00:00Z", "2030-01-10T00:00:00Z"]


async def test_series_alarm_moves_with_the_series(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(days=1)
    made = await _create(client, timed("weekly", start, rrule="FREQ=WEEKLY", tz="Asia/Tokyo"))
    sid = made["id"]
    set_ = await client.put(
        f"{EVENTS}/{sid}/alarm", json={"minutes_before": 30, "tz": "Asia/Tokyo"}
    )
    assert set_.status_code == 200, set_.text
    first_key = set_.json()["alarm"]["occurrence_start"]
    assert first_key == made["occurrence_start"]
    # Cancelling the next occurrence moves the alarm to the one after it.
    await client.delete(occ_url(sid, first_key), params={"scope": "this"})
    after = (await client.get(f"{EVENTS}/{sid}")).json()["alarm"]
    week = (start + timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert after["occurrence_start"] == week and after["status"] == "pending"


# --- iCal -----------------------------------------------------------------------------------------


def test_text_is_escaped_and_lines_folded() -> None:
    assert ical.escape_text("a,b;c\\d\ne") == "a\\,b\\;c\\\\d\\ne"
    line = "SUMMARY:" + "日本語の長い題名" * 10
    folded = ical.fold(line)
    parts = folded.split("\r\n")
    assert all(len(p.encode()) <= 75 for p in parts)
    assert all(p.startswith(" ") for p in parts[1:])
    assert "".join(p[1:] if i else p for i, p in enumerate(parts)) == line


async def _feed(client: AsyncClient, scope: str = "all") -> tuple[str, dict[str, Any]]:
    response = await client.post(FEEDS, json={"scope": scope})
    assert response.status_code == 201, response.text
    body = cast(dict[str, Any], response.json())
    url: str = body["url"]
    return url[url.index("/api/v1/") :], body["feed"]


def _unfold(text: str) -> list[str]:
    return text.replace("\r\n ", "").split("\r\n")


async def test_ical_feed(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    guest = await make_user(db, "gina", role="guest")
    as_user(alice)
    lab = await _channel(client, "lab")
    secret = await _channel(client, "secret", type="private")
    await client.post(f"/api/v1/channels/{lab['id']}/members", json={"user_id": str(guest.id)})
    now = datetime.now(UTC).replace(microsecond=0)
    soon = now.astimezone(TOKYO).replace(hour=14, minute=0, second=0) + timedelta(days=3)
    series = await _create(
        client,
        timed(
            "ゼミ, 第2; 研究室",
            soon,
            90,
            rrule="FREQ=WEEKLY;COUNT=5",
            tz="Asia/Tokyo",
            channel_id=lab["id"],
            description="行1\n行2",
        ),
    )
    keys = [
        (soon + timedelta(weeks=n)).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ") for n in range(5)
    ]
    await client.delete(occ_url(series["id"], keys[1]), params={"scope": "this"})
    await client.patch(occ_url(series["id"], keys[2]), json={"scope": "this", "title": "休講?"})
    await _create(
        client,
        all_day("合宿", (now + timedelta(days=10)).date(), (now + timedelta(days=11)).date()),
    )
    await _create(client, timed("秘密", soon, channel_id=secret["id"]))
    await _create(client, timed("昔", now - timedelta(days=200)))

    path, feed = await _feed(client)
    assert feed["scope"] == "all" and "token" not in feed
    response = await client.get(path, headers={"Authorization": ""})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/calendar")
    text = response.text
    assert text.startswith("BEGIN:VCALENDAR\r\n") and text.endswith("END:VCALENDAR\r\n")
    assert all(len(line.encode()) <= 75 for line in text.split("\r\n"))
    lines = _unfold(text)
    assert lines.count("BEGIN:VEVENT") == 4  # the series, its changed occurrence, 合宿, 秘密
    assert "BEGIN:VTIMEZONE" in lines and "TZID:Asia/Tokyo" in lines
    assert "RRULE:FREQ=WEEKLY;COUNT=5" in lines

    def local(key: str) -> str:
        moment = datetime.fromisoformat(key.replace("Z", "+00:00"))
        return moment.astimezone(TOKYO).strftime("%Y%m%dT%H%M%S")

    assert f"DTSTART;TZID=Asia/Tokyo:{local(keys[0])}" in lines
    assert f"EXDATE;TZID=Asia/Tokyo:{local(keys[1])}" in lines
    assert f"RECURRENCE-ID;TZID=Asia/Tokyo:{local(keys[2])}" in lines
    assert "SUMMARY:ゼミ\\, 第2\\; 研究室 (#lab)" in lines
    assert "SUMMARY:休講? (#lab)" in lines
    assert "DESCRIPTION:行1\\n行2" in lines
    assert f"UID:{series['id']}@chikuwachat" in lines
    camp = (now + timedelta(days=10)).date()
    assert f"DTSTART;VALUE=DATE:{camp:%Y%m%d}" in lines
    assert f"DTEND;VALUE=DATE:{camp + timedelta(days=2):%Y%m%d}" in lines
    assert "SUMMARY:秘密 (#secret)" in lines and "SUMMARY:昔" not in lines
    # A one-off timed event is in UTC.
    assert any(line.startswith("DTSTART:") and line.endswith("Z") for line in lines)

    # A personal-only feed; a guest sees the channel they are in, not the private one.
    as_user(alice)
    personal, _ = await _feed(client, "personal")
    mine = _unfold((await client.get(personal)).text)
    assert "SUMMARY:合宿" in mine and not any("(#lab)" in line for line in mine)
    as_user(guest)
    guest_path, _ = await _feed(client)
    seen = _unfold((await client.get(guest_path)).text)
    assert "SUMMARY:休講? (#lab)" in seen and "SUMMARY:秘密 (#secret)" not in seen
    assert "SUMMARY:合宿" not in seen

    # The list has no token; deleting a feed stops its URL at once; others' feeds are 404.
    as_user(alice)
    listed = (await client.get(FEEDS)).json()
    assert len(listed) == 2 and all(
        set(f) == {"id", "scope", "created_at", "last_used_at"} for f in listed
    )
    assert any(f["last_used_at"] for f in listed)
    as_user(guest)
    assert (await client.delete(f"{FEEDS}/{feed['id']}")).status_code == 404
    as_user(alice)
    assert (await client.delete(f"{FEEDS}/{feed['id']}")).status_code == 204
    assert (await client.get(path)).status_code == 404
    assert (await client.get("/api/v1/calendar/ical/not-a-token.ics")).status_code == 404
    # At most 5 per person.
    as_user(alice)
    for _ in range(4):
        await _feed(client)
    over = await client.post(FEEDS, json={"scope": "all"})
    assert over.status_code == 409 and over.json()["error"]["code"] == "calendar_feed_limit"
    # The access log hides the token.
    assert redact_path(path) == "/api/v1/calendar/ical/***"


async def test_ical_feed_is_rate_limited_and_stops_for_deactivated_people(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    path, _ = await _feed(client)
    assert (await client.get(path)).status_code == 200
    alice.deactivated_at = datetime.now(UTC)
    await db.commit()
    assert (await client.get(path)).status_code == 404
    limiter = app.state.limiters["ical"]
    while limiter.try_acquire("127.0.0.1"):
        pass
    limited = await client.get(path)
    assert limited.status_code == 429


async def test_upcoming_and_single_reads_of_a_series(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await _channel(client, "lab")
    start = datetime.now(UTC).replace(microsecond=0) - timedelta(days=30) + timedelta(hours=2)
    made = await _create(
        client, timed("daily", start, 30, rrule="FREQ=DAILY", tz="UTC", channel_id=lab["id"])
    )
    upcoming = await client.get(
        "/api/v1/calendar/upcoming", params={"channel_id": lab["id"], "days": 2, "tz": "UTC"}
    )
    assert upcoming.status_code == 200
    rows = upcoming.json()
    assert 1 <= len(rows) <= 2 and all(r["series_id"] == made["id"] for r in rows)
    # The series reads as its first occurrence; a later occurrence's id is not an event.
    first = (await client.get(f"{EVENTS}/{made['id']}")).json()
    assert first["occurrence_start"] == made["occurrence_start"]
    assert (await client.get(f"{EVENTS}/{rows[0]['id']}")).status_code == 404
