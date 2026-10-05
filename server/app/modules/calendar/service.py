"""Calendar (M51, CALENDAR.md; recurring events and iCal feeds M68, §10).

Two kinds of calendar only: my own (channel_id NULL, only I see it) and a channel's shared one
(its members see it; public or private channels, not DMs). Who sees and changes what follows the
channel's membership (§3): members read (guests too), those who may post add, and the creator, the
channel's owners and administrators change and delete. Someone who cannot see an event gets 404.

Every change writes an outbox row in the same transaction (§5): calendar.event.updated /
calendar.event.deleted to the channel's members (a personal event: its owner), without the
channel's seq. The fields that differ per person are not in the event: `editor_ids` says who may
change it, and alarms travel on their own (calendar.alarm.updated to their owner).

Alarms (§6) are per person. Their time (fire_at) is worked out when they are set and again when
the event's time changes; one whose time has passed is not sent (cancelled). The worker
(`fire_due`, beside the reminders') marks due ones fired and writes calendar.alarm.updated, which
the push planner turns into a notification (kind calendar, DND honoured like a reminder). Leaving
a channel drops one's alarms on its events (`CalendarLeaveHandler`, an outbox handler on
channel.member_removed: channels does not call the calendar, ARCHITECTURE.md §5).

M68: an event may repeat (an RRULE subset on the event, the series' "master"); its occurrences
are expanded here for each range read (series.py), changed or cancelled one by one through
overrides (この予定だけ), split (これ以降すべて) or changed whole (すべての予定). A series' alarm
is for its next occurrence and moves on to the following one when it fires (§10.5).
"""

import secrets
import uuid
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app import i18n
from app.core.errors import bad_request, conflict, forbidden, not_found
from app.core.security import hash_token
from app.core.time import utcnow
from app.events.envelope import Audience
from app.events.models import OutboxEvent
from app.events.outbox import write_outbox
from app.modules.calendar import ical, recurrence, series
from app.modules.calendar import repository as repo
from app.modules.calendar.events import (
    CALENDAR_ALARM_UPDATED,
    CALENDAR_EVENT_DELETED,
    CALENDAR_EVENT_UPDATED,
)
from app.modules.calendar.models import (
    ALL_DAY_ALARMS,
    MAX_ALL_DAY_DAYS,
    MAX_TIMED_DAYS,
    TIMED_ALARMS,
    CalendarEvent,
    CalendarEventAlarm,
    CalendarEventOverride,
    CalendarFeed,
)
from app.modules.calendar.schemas import (
    CalendarAlarmIn,
    CalendarAlarmOut,
    CalendarAlarmUpdatedData,
    CalendarEventCreate,
    CalendarEventData,
    CalendarEventDeletedData,
    CalendarEventOut,
    CalendarEventUpdate,
    CalendarEventUpdatedData,
    CalendarFeedCreate,
    CalendarFeedCreated,
    CalendarFeedOut,
    CalendarOccurrenceUpdate,
    OccurrenceScope,
)
from app.modules.calendar.series import Occurrence
from app.modules.channels import service as channels
from app.modules.channels.events import CHANNEL_MEMBER_REMOVED
from app.modules.channels.models import Channel
from app.modules.users.dnd import valid_zone
from app.modules.users.models import User

# The zone of an alarm set without one: the person's quiet-hours zone, else this.
DEFAULT_TZ = "Asia/Tokyo"
# GET /calendar/events: the longest range and the most events one answer holds.
MAX_RANGE = timedelta(days=100)
MAX_RANGE_EVENTS = 1000
# GET /calendar/upcoming.
MAX_UPCOMING = 10
# An all-day event's alarm goes out at 8:00: on the day (-480) or the day before (1440).
ALL_DAY_ALARM_TIME = time(8, 0)
# M68 iCal feeds (CALENDAR.md §10.6): how many a person may have, and the days they hold.
MAX_FEEDS = 5
FEED_PAST = timedelta(days=90)
FEED_FUTURE = timedelta(days=400)
FEED_EVENTS = 5000
# last_used_at is written at most this often.
FEED_TOUCH = timedelta(hours=1)

_TIME_FIELDS = ("starts_at", "ends_at", "start_date", "end_date")


@dataclass(frozen=True)
class _Seen:
    """An event someone may see, with its channel (None: personal) and their role there."""

    event: CalendarEvent
    channel: Channel | None
    role: str | None


@dataclass(frozen=True)
class AlarmNotice:
    """What the push planner sends for a fired alarm."""

    event_id: uuid.UUID
    channel_id: uuid.UUID | None
    body: str
    # M115: the body in each UI language (body is the ja one).
    bodies: dict[str, str] = field(default_factory=dict)

    def text(self, locale: str) -> str:
        return self.bodies.get(locale) or self.body


Timing = CalendarEvent | Occurrence


# --- rules ---------------------------------------------------------------------------------------


def zone_for(tz: str | None, actor: User) -> str:
    if tz:
        return tz
    if actor.quiet_hours_tz and valid_zone(actor.quiet_hours_tz):
        return actor.quiet_hours_tz
    return DEFAULT_TZ


def check_timing(
    all_day: bool,
    starts_at: datetime | None,
    ends_at: datetime | None,
    start_date: date | None,
    end_date: date | None,
) -> None:
    """A timed event has starts_at < ends_at (at most 14 days), an all-day one start_date ≤
    end_date (at most 60 days), and nothing of the other kind."""
    if all_day:
        if start_date is None or end_date is None or starts_at or ends_at:
            raise bad_request(
                "calendar_invalid_time", "An all-day event has start_date and end_date only"
            )
        if end_date < start_date:
            raise bad_request("calendar_invalid_time", "end_date is before start_date")
        if (end_date - start_date).days >= MAX_ALL_DAY_DAYS:
            raise bad_request(
                "calendar_event_too_long", f"An all-day event lasts at most {MAX_ALL_DAY_DAYS} days"
            )
        return
    if starts_at is None or ends_at is None or start_date or end_date:
        raise bad_request("calendar_invalid_time", "A timed event has starts_at and ends_at only")
    if ends_at <= starts_at:
        raise bad_request("calendar_invalid_time", "ends_at must be after starts_at")
    if ends_at - starts_at > timedelta(days=MAX_TIMED_DAYS):
        raise bad_request(
            "calendar_event_too_long", f"A timed event lasts at most {MAX_TIMED_DAYS} days"
        )


def check_alarm(all_day: bool, minutes_before: int) -> None:
    allowed = ALL_DAY_ALARMS if all_day else TIMED_ALARMS
    if minutes_before not in allowed:
        raise bad_request(
            "calendar_invalid_alarm",
            "No such alarm for this event",
            details={"allowed": list(allowed)},
        )


def _invalid_rrule(message: str) -> Exception:
    return bad_request("calendar_invalid_rrule", message)


def check_rrule(text: str, first: date) -> str:
    """The normalized rule, or 400 calendar_invalid_rrule (CALENDAR.md §10.1)."""
    try:
        rule = recurrence.parse(text)
    except recurrence.RRuleError as exc:
        raise _invalid_rrule(str(exc)) from exc
    if rule.until is not None and rule.until < first:
        raise _invalid_rrule("UNTIL is before the event's start")
    return recurrence.format_rule(rule)


def fire_at_for(event: Timing, minutes_before: int, tz: str) -> datetime:
    """When an alarm goes out: minutes before a timed event's start; for an all-day event 8:00
    (in the alarm's zone) on its first day (-480) or the day before (1440)."""
    if not event.all_day:
        assert event.starts_at is not None
        return event.starts_at.astimezone(UTC) - timedelta(minutes=minutes_before)
    assert event.start_date is not None
    day = event.start_date - timedelta(days=1) if minutes_before == 1440 else event.start_date
    return datetime.combine(day, ALL_DAY_ALARM_TIME, ZoneInfo(tz)).astimezone(UTC)


def remap_alarm(minutes_before: int, all_day: bool) -> int:
    """An event turned all-day (or back): 前日 stays, the rest becomes 当日 8:00 (or 1 時間前)."""
    if minutes_before == 1440:
        return 1440
    if all_day:
        return minutes_before if minutes_before in ALL_DAY_ALARMS else -480
    return minutes_before if minutes_before in TIMED_ALARMS else 60


def _schedule(
    alarm: CalendarEventAlarm,
    event: CalendarEvent,
    now: datetime,
    overrides: list[CalendarEventOverride] | None = None,
) -> None:
    """Works the time out again; one that has passed is not sent (CALENDAR.md §6). A series'
    alarm is for its next occurrence whose time is still ahead (§10.5)."""
    alarm.updated_at = now
    if not event.recurring:
        alarm.fire_at = fire_at_for(event, alarm.minutes_before, alarm.tz)
        alarm.status = "pending" if alarm.fire_at > now else "cancelled"
        alarm.occurrence_start = None
        return
    found = series.next_for_alarm(
        event,
        overrides or [],
        lambda occ: fire_at_for(occ, alarm.minutes_before, alarm.tz),
        now,
    )
    if isinstance(found, series.Wake):
        alarm.fire_at, alarm.status, alarm.occurrence_start = found.at, "pending", None
    elif found is None:
        alarm.fire_at, alarm.status, alarm.occurrence_start = now, "cancelled", None
    else:
        occ, fire_at = found
        alarm.fire_at, alarm.status, alarm.occurrence_start = fire_at, "pending", occ.key


def ended(event: Timing, now: datetime, tz: str) -> bool:
    if not event.all_day:
        assert event.ends_at is not None
        return event.ends_at <= now
    assert event.end_date is not None
    return event.end_date < now.astimezone(ZoneInfo(tz)).date()


def _can_edit(actor: User, seen: _Seen) -> bool:
    if seen.channel is None:
        return seen.event.owner_id == actor.id
    if seen.channel.is_archived:
        return False
    return seen.event.owner_id == actor.id or seen.role == "owner" or actor.is_admin


def notice_text(
    event: Timing, channel_name: str | None, tz: str, fire_at: datetime, locale: str = "ja"
) -> str:
    """「14:00 ゼミ (#m2-進捗)」, 「終日 学会 (#…)」; 「明日 …」 or 「10/3 …」 when the alarm goes
    out on an earlier day (in `locale`, M115)."""
    zone = ZoneInfo(tz)
    if event.all_day:
        assert event.start_date is not None
        day, when = event.start_date, i18n.t("calendar.all_day", locale)
    else:
        assert event.starts_at is not None
        local = event.starts_at.astimezone(zone)
        day, when = local.date(), f"{local.hour}:{local.minute:02d}"
    fire_day = fire_at.astimezone(zone).date()
    if day == fire_day + timedelta(days=1):
        when = i18n.t("calendar.tomorrow", locale, when=when)
    elif day != fire_day:
        when = i18n.t("calendar.on_day", locale, month=day.month, day=day.day, when=when)
    text = f"{when} {event.title}"
    return f"{text} (#{channel_name})" if channel_name else text


# --- output --------------------------------------------------------------------------------------


def _utc(value: datetime | None) -> datetime | None:
    return value.astimezone(UTC) if value is not None else None


def to_data(event: CalendarEvent | Occurrence, channel: Channel | None) -> CalendarEventData:
    """An occurrence (or an event: its first occurrence) as everyone who sees it sees it."""
    occ = event if isinstance(event, Occurrence) else series.single(event)
    master = occ.master
    return CalendarEventData(
        id=occ.id,
        channel_id=master.channel_id,
        channel_name=channel.name if channel is not None else None,
        owner_id=master.owner_id,
        title=occ.title,
        all_day=occ.all_day,
        starts_at=_utc(occ.starts_at),
        ends_at=_utc(occ.ends_at),
        start_date=occ.start_date,
        end_date=occ.end_date,
        location=occ.location,
        description=occ.description,
        created_at=master.created_at,
        updated_at=master.updated_at,
        series_id=master.id,
        occurrence_start=occ.key,
        recurring=master.recurring,
        rrule=master.rrule,
        tz=master.tz if master.recurring else None,
    )


def alarm_out(alarm: CalendarEventAlarm | None) -> CalendarAlarmOut | None:
    if alarm is None:
        return None
    return CalendarAlarmOut(
        minutes_before=alarm.minutes_before,
        fire_at=alarm.fire_at.astimezone(UTC),
        status=alarm.status,  # type: ignore[arg-type]
        occurrence_start=alarm.occurrence_start,
    )


def to_out(
    seen: _Seen, actor: User, alarm: CalendarEventAlarm | None, occ: Occurrence | None = None
) -> CalendarEventOut:
    return CalendarEventOut(
        **to_data(occ or seen.event, seen.channel).model_dump(),
        can_edit=_can_edit(actor, seen),
        alarm=alarm_out(alarm),
    )


# --- events --------------------------------------------------------------------------------------


async def _editor_ids(
    db: AsyncSession, event: CalendarEvent, channel: Channel | None
) -> list[uuid.UUID]:
    if channel is None:
        return [event.owner_id]
    if channel.is_archived:
        return []
    ids = await channels.manager_ids_of(db, channel.id)
    if event.owner_id in await channels.member_ids_of(db, channel.id):
        ids.add(event.owner_id)
    return sorted(ids)


async def _emit_updated(db: AsyncSession, event: CalendarEvent, channel: Channel | None) -> None:
    """A series' change of any kind carries its master (recurring: true): devices read their
    ranges again (CALENDAR.md §10.4)."""
    data = CalendarEventUpdatedData(
        event=to_data(event, channel), editor_ids=await _editor_ids(db, event, channel)
    )
    await write_outbox(
        db,
        event_type=CALENDAR_EVENT_UPDATED,
        audience_type="channel" if event.channel_id is not None else "user",
        audience_id=None if event.channel_id is not None else event.owner_id,
        channel_id=event.channel_id,
        payload=data.model_dump(mode="json"),
    )


async def _emit_deleted(db: AsyncSession, event: CalendarEvent) -> None:
    await write_outbox(
        db,
        event_type=CALENDAR_EVENT_DELETED,
        audience_type="channel" if event.channel_id is not None else "user",
        audience_id=None if event.channel_id is not None else event.owner_id,
        channel_id=event.channel_id,
        payload=CalendarEventDeletedData(id=event.id, channel_id=event.channel_id).model_dump(
            mode="json"
        ),
    )


async def _alarm_occurrence(
    db: AsyncSession,
    event: CalendarEvent,
    user_id: uuid.UUID,
    alarm: CalendarEventAlarm | None,
    overrides: list[CalendarEventOverride] | None,
) -> CalendarEventData | None:
    """The occurrence an alarm is for, resolved now (Review v0.1.22 #9): a series' occurrence
    with its edits, a one-off event as it is; None when there is none or its owner no longer
    sees the event (the alarm is dropped on leaving, but a reschedule may come first)."""
    if alarm is None or event.is_deleted:
        return None
    occ: CalendarEvent | Occurrence = event
    if event.recurring:
        if alarm.occurrence_start is None:
            return None
        if overrides is None:
            overrides = await repo.overrides_list(db, event.id)
        found = series.resolve(
            event, {o.occurrence_start: o for o in overrides}, alarm.occurrence_start
        )
        if found is None:
            return None
        occ = found
    if not await _still_sees(db, user_id, event):
        return None
    channel = await channels.require_channel(db, event.channel_id) if event.channel_id else None
    return to_data(occ, channel)


async def _emit_alarm(
    db: AsyncSession,
    event: CalendarEvent,
    user_id: uuid.UUID,
    alarm: CalendarEventAlarm | None,
    overrides: list[CalendarEventOverride] | None = None,
) -> None:
    data = CalendarAlarmUpdatedData(
        event_id=event.id,
        channel_id=event.channel_id,
        alarm=alarm_out(alarm),
        occurrence=await _alarm_occurrence(db, event, user_id, alarm, overrides),
    )
    await write_outbox(
        db,
        event_type=CALENDAR_ALARM_UPDATED,
        audience_type="user",
        audience_id=user_id,
        channel_id=event.channel_id,
        payload=data.model_dump(mode="json"),
    )


async def _reschedule_all(
    db: AsyncSession, event: CalendarEvent, now: datetime, *, kind_changed: bool = False
) -> None:
    """Everyone's alarm on the event worked out again (its time, rule or overrides changed)."""
    overrides = await repo.overrides_list(db, event.id) if event.recurring else []
    for alarm in await repo.alarms_of_event(db, event.id):
        if kind_changed:
            alarm.minutes_before = remap_alarm(alarm.minutes_before, event.all_day)
        _schedule(alarm, event, now, overrides)
        await _emit_alarm(db, event, alarm.user_id, alarm, overrides)


# --- access --------------------------------------------------------------------------------------


def _not_found() -> Exception:
    return not_found("calendar_event_not_found", "Event not found")


def _occurrence_not_found() -> Exception:
    return not_found("calendar_occurrence_not_found", "No such occurrence of this event")


async def _load(db: AsyncSession, actor: User, event_id: uuid.UUID, *, lock: bool = False) -> _Seen:
    """The event if the actor may see it; else 404 (whether it exists is not told)."""
    event = await repo.get(db, event_id, lock=lock)
    if event is None or event.is_deleted:
        raise _not_found()
    if event.channel_id is None:
        if event.owner_id != actor.id:
            raise _not_found()
        return _Seen(event, None, None)
    membership = await channels.membership_of(db, actor.id, event.channel_id)
    if membership is None:
        raise _not_found()
    channel = await channels.require_channel(db, event.channel_id)
    return _Seen(event, channel, membership.role)


def _require_editor(actor: User, seen: _Seen) -> None:
    if seen.channel is not None:
        channels.require_writable(seen.channel)
    if not _can_edit(actor, seen):
        raise forbidden(
            "calendar_edit_restricted",
            "Only its creator, the channel's owners and administrators change this event",
        )


async def _target_channel(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> Channel:
    """A channel whose calendar the actor may add to: a member who may post there."""
    channel, membership = await channels.require_member(db, actor.id, channel_id)
    if channel.is_dm:
        raise bad_request("calendar_channel_unsupported", "Direct messages have no shared calendar")
    channels.require_writable(channel)
    if channel.posting_policy == "owners" and not actor.is_admin and membership.role != "owner":
        raise forbidden("posting_restricted", "Only owners and administrators can add events here")
    return channel


async def _joined(db: AsyncSession, actor: User) -> dict[uuid.UUID, tuple[Channel, str]]:
    """The channels whose calendars the actor sees, with their role in each."""
    return {c.id: (c, role) for c, role in await channels.conversations_of(db, actor.id)}


async def _occurrences(
    db: AsyncSession,
    *,
    owner_id: uuid.UUID | None,
    channel_ids: list[uuid.UUID],
    start: datetime,
    end: datetime,
    first_day: date,
    last_day: date,
    limit: int,
) -> list[Occurrence]:
    """One-off events and recurring events' occurrences overlapping the range, earliest first."""
    rows = await repo.overlapping(
        db,
        owner_id=owner_id,
        channel_ids=channel_ids,
        start=start,
        end=end,
        first_day=first_day,
        last_day=last_day,
        limit=limit,
    )
    found = [series.single(row) for row in rows]
    masters = await repo.recurring_overlapping(
        db,
        owner_id=owner_id,
        channel_ids=channel_ids,
        start=start,
        end=end,
        first_day=first_day,
        last_day=last_day,
    )
    overrides = await repo.overrides_of(db, [m.id for m in masters])
    for master in masters:
        found += series.expand(
            master, overrides[master.id], start=start, end=end, first=first_day, last=last_day
        )
    found.sort(key=lambda o: (o.begins(), not o.all_day, o.id))
    return found[:limit]


async def _outs(
    db: AsyncSession,
    actor: User,
    occurrences: list[Occurrence],
    joined: dict[uuid.UUID, tuple[Channel, str]],
) -> list[CalendarEventOut]:
    alarms = await repo.alarms_of_user(db, actor.id, list({o.master.id for o in occurrences}))
    out: list[CalendarEventOut] = []
    for occ in occurrences:
        row = occ.master
        if row.channel_id is None:
            seen = _Seen(row, None, None)
        else:
            channel, role = joined[row.channel_id]
            seen = _Seen(row, channel, role)
        out.append(to_out(seen, actor, alarms.get(row.id), occ))
    return out


# --- reading -------------------------------------------------------------------------------------


async def list_range(
    db: AsyncSession,
    actor: User,
    start: datetime,
    end: datetime,
    channel_id: uuid.UUID | None,
) -> list[CalendarEventOut]:
    """Events overlapping [start, end): mine and my channels' (or one channel's), recurring ones
    once per occurrence. All-day events overlap by date, the dates read in the offsets `start`
    and `end` were given in."""
    if end <= start or end - start > MAX_RANGE:
        raise bad_request(
            "calendar_invalid_range",
            f"`to` must be after `from`, at most {MAX_RANGE.days} days later",
        )
    joined = await _joined(db, actor)
    owner_id: uuid.UUID | None = actor.id
    channel_ids = list(joined)
    if channel_id is not None:
        await channels.require_member(db, actor.id, channel_id)
        owner_id = None
        channel_ids = [channel_id] if channel_id in joined else []  # a DM has no calendar
    occurrences = await _occurrences(
        db,
        owner_id=owner_id,
        channel_ids=channel_ids,
        start=start,
        end=end,
        first_day=start.date(),
        last_day=(end - timedelta(microseconds=1)).date(),
        limit=MAX_RANGE_EVENTS,
    )
    return await _outs(db, actor, occurrences, joined)


async def upcoming(
    db: AsyncSession,
    actor: User,
    *,
    days: int,
    channel_id: uuid.UUID | None,
    tz: str | None,
) -> list[CalendarEventOut]:
    """Today's and the next days' events not yet over (a channel's header, the home): at most 10,
    the earliest first. Days are read in `tz`."""
    zone = ZoneInfo(zone_for(tz, actor))
    now = utcnow()
    today = now.astimezone(zone).date()
    end = datetime.combine(today + timedelta(days=days), time(), zone)
    joined = await _joined(db, actor)
    owner_id: uuid.UUID | None = actor.id
    channel_ids = list(joined)
    if channel_id is not None:
        await channels.require_member(db, actor.id, channel_id)
        owner_id = None
        channel_ids = [channel_id] if channel_id in joined else []
    occurrences = await _occurrences(
        db,
        owner_id=owner_id,
        channel_ids=channel_ids,
        start=now,
        end=end,
        first_day=today,
        last_day=today + timedelta(days=days - 1),
        limit=MAX_RANGE_EVENTS,
    )

    def begins(occ: Occurrence) -> datetime:
        if occ.all_day:
            assert occ.start_date is not None
            return datetime.combine(max(occ.start_date, today), time(), zone)
        assert occ.starts_at is not None
        return occ.starts_at

    occurrences.sort(key=lambda occ: (begins(occ), not occ.all_day, occ.id))
    return await _outs(db, actor, occurrences[:MAX_UPCOMING], joined)


async def get_event(db: AsyncSession, actor: User, event_id: uuid.UUID) -> CalendarEventOut:
    seen = await _load(db, actor, event_id)
    return to_out(seen, actor, await repo.alarm(db, event_id, actor.id))


# --- changes -------------------------------------------------------------------------------------


def _first_day_of(
    all_day: bool, starts_at: datetime | None, start_date: date | None, tz: str
) -> date:
    if all_day:
        assert start_date is not None
        return start_date
    assert starts_at is not None
    return starts_at.astimezone(ZoneInfo(tz)).date()


async def create(
    db: AsyncSession, actor: User, data: CalendarEventCreate
) -> tuple[CalendarEventOut, bool]:
    """A new event (and my alarm on it). A retry with the same client_event_id returns the event
    the first request made (False)."""
    actor_id = actor.id  # instances expire on rollback
    if data.client_event_id is not None:
        existing = await repo.by_client_id(db, actor_id, data.client_event_id)
        if existing is not None:
            return await get_event(db, actor, existing.id), False
    channel = await _target_channel(db, actor, data.channel_id) if data.channel_id else None
    check_timing(data.all_day, data.starts_at, data.ends_at, data.start_date, data.end_date)
    if data.alarm_minutes is not None:
        check_alarm(data.all_day, data.alarm_minutes)
    tz = zone_for(data.tz, actor)
    rrule = None
    if data.rrule is not None:
        first = _first_day_of(data.all_day, data.starts_at, data.start_date, tz)
        rrule = check_rrule(data.rrule, first)
    now = utcnow()
    event = _new_event(data, actor_id, now)
    event.tz, event.rrule = tz, rrule
    event.series_end = series.series_end(event)
    db.add(event)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()  # a concurrent retry won: answer with its event
        if data.client_event_id is None:
            raise
        await db.refresh(actor)
        existing = await repo.by_client_id(db, actor_id, data.client_event_id)
        if existing is None:
            raise
        return await get_event(db, actor, existing.id), False
    alarm: CalendarEventAlarm | None = None
    if data.alarm_minutes is not None:
        alarm = CalendarEventAlarm(
            event_id=event.id,
            user_id=actor_id,
            minutes_before=data.alarm_minutes,
            tz=tz,
            created_at=now,
        )
        _schedule(alarm, event, now)
        db.add(alarm)
        await db.flush()
    await _emit_updated(db, event, channel)
    if alarm is not None:
        await _emit_alarm(db, event, actor_id, alarm)
    await db.commit()
    return to_out(_Seen(event, channel, None), actor, alarm), True  # the creator may edit


def _new_event(data: CalendarEventCreate, owner_id: uuid.UUID, now: datetime) -> CalendarEvent:
    return CalendarEvent(
        channel_id=data.channel_id,
        owner_id=owner_id,
        title=data.title,
        all_day=data.all_day,
        starts_at=_utc(data.starts_at),
        ends_at=_utc(data.ends_at),
        start_date=data.start_date,
        end_date=data.end_date,
        location=data.location,
        description=data.description,
        client_event_id=data.client_event_id,
        created_at=now,
        updated_at=now,
    )


async def create_channel_event_in_tx(
    db: AsyncSession, actor: User, data: CalendarEventCreate
) -> uuid.UUID:
    """A new event in a channel's calendar inside the caller's transaction, which commits it (M53:
    a decided scheduling poll, SCHEDULING.md §4). The rules of `create` (a member who may post,
    not a DM, not archived, the time's shape); no alarm, no idempotency key, no rule."""
    if (
        data.channel_id is None
        or data.alarm_minutes is not None
        or data.client_event_id
        or data.rrule
    ):
        raise ValueError("a one-off channel event without alarm or client_event_id")
    channel = await _target_channel(db, actor, data.channel_id)
    check_timing(data.all_day, data.starts_at, data.ends_at, data.start_date, data.end_date)
    event = _new_event(data, actor.id, utcnow())
    db.add(event)
    await db.flush()
    await _emit_updated(db, event, channel)
    return event.id


def _sent(data: CalendarEventUpdate) -> dict[str, Any]:
    return {name: getattr(data, name) for name in data.model_fields_set if name != "scope"}


def _timing_from(
    changes: dict[str, Any], current: Timing
) -> tuple[bool, datetime | None, datetime | None, date | None, date | None]:
    """The timing after a change: the pair of the (new) kind, sent values over the current ones.
    Times of the other kind are refused."""
    all_day = changes.get("all_day")
    if all_day is None:
        all_day = current.all_day
    other = ("starts_at", "ends_at") if all_day else ("start_date", "end_date")
    if any(changes.get(name) is not None for name in other):
        raise bad_request(
            "calendar_invalid_time",
            "An all-day event has dates only" if all_day else "A timed event has times only",
        )
    same_kind = all_day == current.all_day
    if all_day:
        start_date = changes["start_date"] if "start_date" in changes else None
        end_date = changes["end_date"] if "end_date" in changes else None
        if same_kind:
            start_date = start_date if "start_date" in changes else current.start_date
            end_date = end_date if "end_date" in changes else current.end_date
        return (True, None, None, start_date, end_date)
    starts_at = _utc(changes.get("starts_at"))
    ends_at = _utc(changes.get("ends_at"))
    if same_kind:
        starts_at = starts_at if "starts_at" in changes else current.starts_at
        ends_at = ends_at if "ends_at" in changes else current.ends_at
    return (False, starts_at, ends_at, None, None)


async def _change_master(
    db: AsyncSession, actor: User, seen: _Seen, changes: dict[str, Any], now: datetime
) -> None:
    """Changes a whole event (PATCH, or すべての予定 of a series): its fields, time, rule and
    zone; a series drops the overrides that are no longer occurrences (CALENDAR.md §10.1) and
    everyone's alarm is worked out again. Flushes; the caller emits and commits."""
    event = seen.event
    if "title" in changes:
        if changes["title"] is None:
            raise bad_request("validation_error", "A title cannot be null")
        event.title = changes["title"]
    if "location" in changes:
        event.location = changes["location"]
    if "description" in changes:
        event.description = changes["description"]
    before = (
        event.all_day,
        event.starts_at,
        event.ends_at,
        event.start_date,
        event.end_date,
        event.rrule,
        event.tz,
    )
    timing = _timing_from(changes, event)
    check_timing(*timing)
    kind_changed = timing[0] != event.all_day
    (event.all_day, event.starts_at, event.ends_at, event.start_date, event.end_date) = timing
    if changes.get("tz"):
        event.tz = changes["tz"]
    if "rrule" in changes:
        if changes["rrule"] is None:
            event.rrule = None
            await repo.delete_overrides(db, event.id)
        else:
            if event.tz is None:
                event.tz = zone_for(None, actor)
            event.rrule = changes["rrule"]
    if event.rrule is not None:
        assert event.tz is not None
        first = _first_day_of(event.all_day, event.starts_at, event.start_date, event.tz)
        event.rrule = check_rrule(event.rrule, first)
    event.series_end = series.series_end(event)
    event.updated_at = now
    after = (
        event.all_day,
        event.starts_at,
        event.ends_at,
        event.start_date,
        event.end_date,
        event.rrule,
        event.tz,
    )
    await db.flush()
    if event.recurring and after != before:
        for stale in series.stale_overrides(event, await repo.overrides_list(db, event.id)):
            await db.delete(stale)
        await db.flush()
    if after != before:
        await _reschedule_all(db, event, now, kind_changed=kind_changed)


async def update(
    db: AsyncSession, actor: User, event_id: uuid.UUID, data: CalendarEventUpdate
) -> CalendarEventOut:
    seen = await _load(db, actor, event_id, lock=True)
    _require_editor(actor, seen)
    now = utcnow()
    await _change_master(db, actor, seen, _sent(data), now)
    mine = await repo.alarm(db, seen.event.id, actor.id)
    await _emit_updated(db, seen.event, seen.channel)
    await db.commit()
    return to_out(seen, actor, mine)


async def delete(db: AsyncSession, actor: User, event_id: uuid.UUID) -> None:
    """Soft delete (the event tells the devices it is gone); its alarms are cancelled. A series
    goes whole."""
    seen = await _load(db, actor, event_id, lock=True)
    _require_editor(actor, seen)
    await _delete_event(db, seen.event, utcnow())
    await db.commit()


async def _delete_event(db: AsyncSession, event: CalendarEvent, now: datetime) -> None:
    event.deleted_at = now
    event.updated_at = now
    for alarm in await repo.alarms_of_event(db, event.id):
        if alarm.status == "pending":
            alarm.status = "cancelled"
            alarm.updated_at = now
    await _emit_deleted(db, event)


# --- occurrences of a recurring event (M68, CALENDAR.md §10) -------------------------------------


async def _load_occurrence(
    db: AsyncSession, actor: User, series_id: uuid.UUID, raw_key: str
) -> tuple[_Seen, str]:
    seen = await _load(db, actor, series_id, lock=True)
    _require_editor(actor, seen)
    master = seen.event
    if not master.recurring:
        raise bad_request("calendar_not_recurring", "This event does not repeat")
    try:
        key = recurrence.parse_key(raw_key, master.all_day)
    except ValueError as exc:
        raise _occurrence_not_found() from exc
    if not series.is_valid_key(master, key):
        raise _occurrence_not_found()
    return seen, key


async def update_occurrence(
    db: AsyncSession,
    actor: User,
    series_id: uuid.UUID,
    raw_key: str,
    data: CalendarOccurrenceUpdate,
) -> CalendarEventOut:
    seen, key = await _load_occurrence(db, actor, series_id, raw_key)
    changes = _sent(data)
    now = utcnow()
    scope: OccurrenceScope = data.scope
    if scope == "following" and key == series.first_key(seen.event):
        scope = "all"
    if scope == "this":
        occ = await _edit_this(db, seen, key, changes, now)
        result_seen, result_occ = seen, occ
    elif scope == "following":
        new_seen = await _split(db, actor, seen, key, changes, now)
        result_seen, result_occ = new_seen, None
    else:
        await _change_master(db, actor, seen, _shifted(seen.event, key, changes), now)
        await _emit_updated(db, seen.event, seen.channel)
        result_seen, result_occ = seen, None
    mine = await repo.alarm(db, result_seen.event.id, actor.id)
    await db.commit()
    return to_out(result_seen, actor, mine, result_occ)


async def _edit_this(
    db: AsyncSession, seen: _Seen, key: str, changes: dict[str, Any], now: datetime
) -> Occurrence:
    """この予定だけ: the override of one occurrence (its text and time; not its kind or rule)."""
    master = seen.event
    if "rrule" in changes or "tz" in changes:
        raise _invalid_rrule("One occurrence has no rule of its own")
    if "all_day" in changes and changes["all_day"] is not None:
        if changes["all_day"] != master.all_day:
            raise bad_request(
                "calendar_invalid_time", "One occurrence cannot turn all-day (or back)"
            )
    base = series.base_occurrence(master, series.key_day(master, key))
    override = await repo.override(db, master.id, key)
    if override is not None and override.cancelled:
        raise _occurrence_not_found()
    if override is None:
        override = CalendarEventOverride(
            series_id=master.id, occurrence_start=key, cancelled=False, changed=[], created_at=now
        )
        db.add(override)
    current = series.apply(base, override)
    assert current is not None
    changed = set(override.changed)
    if "title" in changes:
        if changes["title"] is None:
            raise bad_request("validation_error", "A title cannot be null")
        override.title = changes["title"]
        changed.add("title")
    for name in ("location", "description"):
        if name in changes:
            setattr(override, name, changes[name])
            changed.add(name)
    if any(name in changes for name in _TIME_FIELDS):
        timing = _timing_from(changes, current)
        check_timing(*timing)
        original = (base.all_day, base.starts_at, base.ends_at, base.start_date, base.end_date)
        if timing == original:
            changed.discard("time")
            timing = (None, None, None, None, None)  # type: ignore[assignment]
        else:
            changed.add("time")
        (
            override.all_day,
            override.starts_at,
            override.ends_at,
            override.start_date,
            override.end_date,
        ) = timing
    override.changed = sorted(changed)
    override.updated_at = now
    if not changed:  # back to the series' own
        if inspect(override).pending:
            db.expunge(override)
        else:
            await db.delete(override)
    await db.flush()
    master.updated_at = now
    await _reschedule_all(db, master, now)
    await _emit_updated(db, master, seen.channel)
    resolved = series.apply(base, override if changed else None)
    assert resolved is not None
    return resolved


def _shifted(master: CalendarEvent, key: str, changes: dict[str, Any]) -> dict[str, Any]:
    """すべての予定 from one occurrence: the occurrence's new time becomes the series' by moving
    the series' start by as many days as the occurrence moved, at the occurrence's new time of
    day (the series still begins where it did, CALENDAR.md §10.1)."""
    if not any(name in changes for name in _TIME_FIELDS) and "all_day" not in changes:
        return changes
    base = series.base_occurrence(master, series.key_day(master, key))
    timing = _timing_from(changes, base)
    check_timing(*timing)
    all_day, starts_at, ends_at, start_date, end_date = timing
    zone = ZoneInfo(changes.get("tz") or master.tz or "UTC")
    old_day = series.key_day(master, key)
    if all_day:
        assert start_date is not None and end_date is not None
        new_day = start_date
    else:
        assert starts_at is not None
        new_day = starts_at.astimezone(zone).date()
    first = series.first_day(master) + (new_day - old_day)
    shifted = {k: v for k, v in changes.items() if k not in _TIME_FIELDS}
    shifted["all_day"] = all_day
    if all_day:
        assert start_date is not None and end_date is not None
        shifted["start_date"] = first
        shifted["end_date"] = first + (end_date - start_date)
    else:
        assert starts_at is not None and ends_at is not None
        begin = recurrence.timed_start(first, starts_at.astimezone(zone).time(), zone)
        shifted["starts_at"] = begin
        shifted["ends_at"] = begin + (ends_at - starts_at)
    return shifted


async def _split(
    db: AsyncSession,
    actor: User,
    seen: _Seen,
    key: str,
    changes: dict[str, Any],
    now: datetime,
) -> _Seen:
    """これ以降すべて: the series ends the day before this occurrence and a new series (with the
    changes) takes over from it. Later overrides move over when still occurrences of the new
    series; everyone's alarm is copied (CALENDAR.md §10.1)."""
    old = seen.event
    rule = series.rule_of(old)
    day = series.key_day(old, key)
    first = series.first_day(old)
    base = series.base_occurrence(old, day)
    timing = _timing_from(changes, base)
    check_timing(*timing)
    tz = changes.get("tz") or old.tz
    assert tz is not None
    new_first = _first_day_of(timing[0], timing[1], timing[3], tz)
    if "rrule" in changes:
        rrule = check_rrule(changes["rrule"], new_first) if changes["rrule"] else None
    else:
        remaining = rule
        if rule.count is not None:
            done = recurrence.count_before(rule, first, day)
            remaining = recurrence.with_end(rule, count=max(rule.count - done, 1))
        rrule = check_rrule(recurrence.format_rule(remaining), new_first)
    title = changes.get("title", old.title)
    if title is None:
        raise bad_request("validation_error", "A title cannot be null")
    new = CalendarEvent(
        channel_id=old.channel_id,
        owner_id=old.owner_id,
        title=title,
        all_day=timing[0],
        starts_at=timing[1],
        ends_at=timing[2],
        start_date=timing[3],
        end_date=timing[4],
        location=changes.get("location", old.location),
        description=changes.get("description", old.description),
        rrule=rrule,
        tz=tz,
        created_at=now,
        updated_at=now,
    )
    new.series_end = series.series_end(new)
    db.add(new)
    # The old series stops the day before (COUNT becomes that UNTIL).
    old.rrule = recurrence.format_rule(recurrence.with_end(rule, until=day - timedelta(days=1)))
    old.series_end = series.series_end(old)
    old.updated_at = now
    await db.flush()
    for override in await repo.overrides_list(db, old.id):
        if override.occurrence_start < key:
            continue
        keep = new.recurring and series.is_valid_key(new, override.occurrence_start)
        if keep:
            db.add(
                CalendarEventOverride(
                    series_id=new.id,
                    occurrence_start=override.occurrence_start,
                    cancelled=override.cancelled,
                    changed=list(override.changed),
                    title=override.title,
                    location=override.location,
                    description=override.description,
                    all_day=override.all_day,
                    starts_at=override.starts_at,
                    ends_at=override.ends_at,
                    start_date=override.start_date,
                    end_date=override.end_date,
                    created_at=override.created_at,
                    updated_at=now,
                )
            )
        await db.delete(override)
    for alarm in await repo.alarms_of_event(db, old.id):
        minutes = alarm.minutes_before
        if new.all_day != old.all_day:
            minutes = remap_alarm(minutes, new.all_day)
        db.add(
            CalendarEventAlarm(
                event_id=new.id,
                user_id=alarm.user_id,
                minutes_before=minutes,
                tz=alarm.tz,
                fire_at=now,
                created_at=now,
            )
        )
    await db.flush()
    await _reschedule_all(db, old, now)
    await _reschedule_all(db, new, now)
    await _emit_updated(db, old, seen.channel)
    await _emit_updated(db, new, seen.channel)
    return replace(seen, event=new)


async def delete_occurrence(
    db: AsyncSession, actor: User, series_id: uuid.UUID, raw_key: str, scope: OccurrenceScope
) -> None:
    """この予定だけ: the occurrence is cancelled (an override); これ以降すべて: the series ends
    the day before it (later overrides go); すべての予定: the series goes."""
    seen, key = await _load_occurrence(db, actor, series_id, raw_key)
    master = seen.event
    now = utcnow()
    if scope == "following" and key == series.first_key(master):
        scope = "all"
    if scope == "all":
        await _delete_event(db, master, now)
        await db.commit()
        return
    if scope == "this":
        override = await repo.override(db, master.id, key)
        if override is None:
            override = CalendarEventOverride(
                series_id=master.id, occurrence_start=key, changed=[], created_at=now
            )
            db.add(override)
        override.cancelled = True
        override.updated_at = now
    else:
        rule = series.rule_of(master)
        day = series.key_day(master, key)
        master.rrule = recurrence.format_rule(
            recurrence.with_end(rule, until=day - timedelta(days=1))
        )
        master.series_end = series.series_end(master)
        for override in await repo.overrides_list(db, master.id):
            if override.occurrence_start >= key:
                await db.delete(override)
    master.updated_at = now
    await db.flush()
    await _reschedule_all(db, master, now)
    await _emit_updated(db, master, seen.channel)
    await db.commit()


# --- alarms --------------------------------------------------------------------------------------


async def set_alarm(
    db: AsyncSession, actor: User, event_id: uuid.UUID, data: CalendarAlarmIn
) -> CalendarEventOut:
    """My alarm on an event I can see (only I am notified). On a series: every occurrence."""
    seen = await _load(db, actor, event_id)
    check_alarm(seen.event.all_day, data.minutes_before)
    now = utcnow()
    overrides = await repo.overrides_list(db, event_id) if seen.event.recurring else []
    alarm = await repo.alarm(db, event_id, actor.id)
    if alarm is None:
        alarm = CalendarEventAlarm(event_id=event_id, user_id=actor.id, created_at=now)
        db.add(alarm)
    alarm.minutes_before = data.minutes_before
    alarm.tz = zone_for(data.tz, actor)
    _schedule(alarm, seen.event, now, overrides)
    await db.flush()
    await _emit_alarm(db, seen.event, actor.id, alarm)
    await db.commit()
    return to_out(seen, actor, alarm)


async def clear_alarm(db: AsyncSession, actor: User, event_id: uuid.UUID) -> None:
    seen = await _load(db, actor, event_id)
    alarm = await repo.alarm(db, event_id, actor.id)
    if alarm is None:
        return
    await db.delete(alarm)
    await _emit_alarm(db, seen.event, actor.id, None)
    await db.commit()


# --- the worker and the push planner -------------------------------------------------------------


async def _still_sees(db: AsyncSession, user_id: uuid.UUID, event: CalendarEvent) -> bool:
    if event.channel_id is None:
        return event.owner_id == user_id
    return await channels.membership_of(db, user_id, event.channel_id) is not None


async def fire_due(db: AsyncSession, *, now: datetime | None = None, limit: int = 50) -> int:
    """Marks due alarms fired; calendar.alarm.updated carries each to the push planner. One whose
    event is gone, over, or no longer visible to its owner is cancelled without a word. A
    series' alarm then moves on to the next occurrence (CALENDAR.md §10.5)."""
    moment = now or utcnow()
    fired = 0
    for alarm in await repo.due_alarms(db, moment, limit):
        alarm.updated_at = moment
        event = await repo.get(db, alarm.event_id)
        if event is None or event.is_deleted or not await _still_sees(db, alarm.user_id, event):
            alarm.status = "cancelled"
            continue
        if event.recurring:
            fired += await _fire_series(db, alarm, event, moment)
            continue
        if ended(event, moment, alarm.tz):
            alarm.status = "cancelled"
            continue
        alarm.status = "fired"
        await _emit_alarm(db, event, alarm.user_id, alarm)
        fired += 1
    await db.commit()
    return fired


async def _fire_series(
    db: AsyncSession, alarm: CalendarEventAlarm, event: CalendarEvent, moment: datetime
) -> int:
    overrides = await repo.overrides_list(db, event.id)
    occ = None
    if alarm.occurrence_start is not None:
        occ = series.resolve(
            event, {o.occurrence_start: o for o in overrides}, alarm.occurrence_start
        )
    sent = 0
    if occ is not None and not ended(occ, moment, alarm.tz):
        alarm.status = "fired"
        await _emit_alarm(db, event, alarm.user_id, alarm, overrides)
        sent = 1
    # On to the next occurrence (a wake-up, a cancelled or past one: without a word).
    _schedule(alarm, event, moment, overrides)
    await _emit_alarm(db, event, alarm.user_id, alarm, overrides)
    return sent


async def alarm_notice(
    db: AsyncSession,
    event_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    occurrence_start: str | None = None,
    fire_at: datetime | None = None,
) -> AlarmNotice | None:
    """The text of a fired alarm, read live; None when it is no longer to be sent. A series'
    alarm has moved on by now: the occurrence and time come from the fired event's payload."""
    alarm = await repo.alarm(db, event_id, user_id)
    event = await repo.get(db, event_id)
    if alarm is None or event is None or event.is_deleted:
        return None
    if not await _still_sees(db, user_id, event):
        return None
    timing: Timing = event
    when = alarm.fire_at
    if event.recurring:
        if occurrence_start is None or fire_at is None:
            return None
        overrides = {o.occurrence_start: o for o in await repo.overrides_list(db, event.id)}
        occ = series.resolve(event, overrides, occurrence_start)
        if occ is None:
            return None
        timing, when = occ, fire_at
    elif alarm.status != "fired":
        return None
    channel = await channels.require_channel(db, event.channel_id) if event.channel_id else None
    name = channel.name if channel is not None else None
    return AlarmNotice(
        event_id=event.id,
        channel_id=event.channel_id,
        body=notice_text(timing, name, alarm.tz, when),
        bodies={lc: notice_text(timing, name, alarm.tz, when, lc) for lc in i18n.LOCALES},
    )


class CalendarLeaveHandler:
    """OutboxHandler: channel.member_removed (the copy addressed to the person who left) drops
    their alarms on that channel's events (CALENDAR.md §3). Idempotent."""

    async def handle(self, db: AsyncSession, event: OutboxEvent, audience: Audience) -> None:
        if (
            event.event_type != CHANNEL_MEMBER_REMOVED
            or event.audience_type != "user"
            or event.channel_id is None
        ):
            return
        user_id = uuid.UUID(str(event.payload["user_id"]))
        if await channels.membership_of(db, user_id, event.channel_id) is not None:
            return  # back in the channel since
        await repo.delete_alarms_in_channel(db, user_id, event.channel_id)


# --- iCal feeds (M68, CALENDAR.md §10.6) ---------------------------------------------------------


def _feed_out(feed: CalendarFeed) -> CalendarFeedOut:
    return CalendarFeedOut(
        id=feed.id,
        scope=feed.scope,  # type: ignore[arg-type]
        created_at=feed.created_at,
        last_used_at=feed.last_used_at,
    )


def feed_path(token: str) -> str:
    return f"/api/v1/calendar/ical/{token}.ics"


async def create_feed(
    db: AsyncSession, actor: User, data: CalendarFeedCreate, base_url: str
) -> CalendarFeedCreated:
    """A new private feed URL; its token is in this answer only (only its hash is kept)."""
    if len(await repo.feeds_of(db, actor.id)) >= MAX_FEEDS:
        raise conflict("calendar_feed_limit", f"At most {MAX_FEEDS} feed URLs")
    token = secrets.token_urlsafe(32)
    feed = CalendarFeed(
        user_id=actor.id, token_hash=hash_token(token), scope=data.scope, created_at=utcnow()
    )
    db.add(feed)
    await db.flush()
    out = _feed_out(feed)
    await db.commit()
    return CalendarFeedCreated(feed=out, url=f"{base_url}{feed_path(token)}")


async def list_feeds(db: AsyncSession, actor: User) -> list[CalendarFeedOut]:
    return [_feed_out(feed) for feed in await repo.feeds_of(db, actor.id)]


async def delete_feed(db: AsyncSession, actor: User, feed_id: uuid.UUID) -> None:
    feed = await db.get(CalendarFeed, feed_id)
    if feed is None or feed.user_id != actor.id:
        raise not_found("calendar_feed_not_found", "Feed not found")
    await db.delete(feed)
    await db.commit()


async def feed_ics(db: AsyncSession, token: str) -> str | None:
    """The feed's calendar (text/calendar), or None for an unknown token or an inactive owner."""
    feed = await repo.feed_by_hash(db, hash_token(token))
    if feed is None:
        return None
    owner = await db.get(User, feed.user_id)
    if owner is None or not owner.is_active:
        return None
    now = utcnow()
    start, end = now - FEED_PAST, now + FEED_FUTURE
    joined = await _joined(db, owner) if feed.scope == "all" else {}
    channel_ids = [cid for cid, (channel, _) in joined.items() if not channel.is_dm]
    first_day, last_day = start.date(), end.date()
    rows = await repo.overlapping(
        db,
        owner_id=owner.id,
        channel_ids=channel_ids,
        start=start,
        end=end,
        first_day=first_day,
        last_day=last_day,
        limit=FEED_EVENTS,
    )
    masters = await repo.recurring_overlapping(
        db,
        owner_id=owner.id,
        channel_ids=channel_ids,
        start=start,
        end=end,
        first_day=first_day,
        last_day=last_day,
    )
    overrides = await repo.overrides_of(db, [m.id for m in masters])
    names = {cid: channel.name for cid, (channel, _) in joined.items()}
    entries = [
        ical.Entry(event=row, channel_name=names.get(row.channel_id) if row.channel_id else None)
        for row in rows
    ]
    for master in masters:
        entries.append(
            ical.Entry(
                event=master,
                channel_name=names.get(master.channel_id) if master.channel_id else None,
                overrides=overrides[master.id],
            )
        )
    if feed.last_used_at is None or now - feed.last_used_at >= FEED_TOUCH:
        feed.last_used_at = now
        await db.commit()
    return ical.render(entries, now=now, name="Taylis")
