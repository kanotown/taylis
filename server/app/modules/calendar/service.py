"""Calendar (M51, CALENDAR.md).

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
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import bad_request, forbidden, not_found
from app.core.time import utcnow
from app.events.envelope import Audience
from app.events.models import OutboxEvent
from app.events.outbox import write_outbox
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
)
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


def fire_at_for(event: CalendarEvent, minutes_before: int, tz: str) -> datetime:
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


def _schedule(alarm: CalendarEventAlarm, event: CalendarEvent, now: datetime) -> None:
    """Works the time out again; one that has passed is not sent (CALENDAR.md §6)."""
    alarm.fire_at = fire_at_for(event, alarm.minutes_before, alarm.tz)
    alarm.status = "pending" if alarm.fire_at > now else "cancelled"
    alarm.updated_at = now


def ended(event: CalendarEvent, now: datetime, tz: str) -> bool:
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


def notice_text(event: CalendarEvent, channel_name: str | None, tz: str, fire_at: datetime) -> str:
    """「14:00 ゼミ (#m2-進捗)」, 「終日 学会 (#…)」; 「明日 …」 or 「10/3 …」 when the alarm goes
    out on an earlier day."""
    zone = ZoneInfo(tz)
    if event.all_day:
        assert event.start_date is not None
        day, when = event.start_date, "終日"
    else:
        assert event.starts_at is not None
        local = event.starts_at.astimezone(zone)
        day, when = local.date(), f"{local.hour}:{local.minute:02d}"
    fire_day = fire_at.astimezone(zone).date()
    if day == fire_day + timedelta(days=1):
        when = f"明日 {when}"
    elif day != fire_day:
        when = f"{day.month}/{day.day} {when}"
    text = f"{when} {event.title}"
    return f"{text} (#{channel_name})" if channel_name else text


# --- output --------------------------------------------------------------------------------------


def _utc(value: datetime | None) -> datetime | None:
    return value.astimezone(UTC) if value is not None else None


def to_data(event: CalendarEvent, channel: Channel | None) -> CalendarEventData:
    return CalendarEventData(
        id=event.id,
        channel_id=event.channel_id,
        channel_name=channel.name if channel is not None else None,
        owner_id=event.owner_id,
        title=event.title,
        all_day=event.all_day,
        starts_at=_utc(event.starts_at),
        ends_at=_utc(event.ends_at),
        start_date=event.start_date,
        end_date=event.end_date,
        location=event.location,
        description=event.description,
        created_at=event.created_at,
        updated_at=event.updated_at,
    )


def alarm_out(alarm: CalendarEventAlarm | None) -> CalendarAlarmOut | None:
    if alarm is None:
        return None
    return CalendarAlarmOut(
        minutes_before=alarm.minutes_before,
        fire_at=alarm.fire_at.astimezone(UTC),
        status=alarm.status,  # type: ignore[arg-type]
    )


def to_out(seen: _Seen, actor: User, alarm: CalendarEventAlarm | None) -> CalendarEventOut:
    return CalendarEventOut(
        **to_data(seen.event, seen.channel).model_dump(),
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


async def _emit_alarm(
    db: AsyncSession, event: CalendarEvent, user_id: uuid.UUID, alarm: CalendarEventAlarm | None
) -> None:
    data = CalendarAlarmUpdatedData(
        event_id=event.id, channel_id=event.channel_id, alarm=alarm_out(alarm)
    )
    await write_outbox(
        db,
        event_type=CALENDAR_ALARM_UPDATED,
        audience_type="user",
        audience_id=user_id,
        channel_id=event.channel_id,
        payload=data.model_dump(mode="json"),
    )


# --- access --------------------------------------------------------------------------------------


def _not_found() -> Exception:
    return not_found("calendar_event_not_found", "Event not found")


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


async def _outs(
    db: AsyncSession,
    actor: User,
    rows: list[CalendarEvent],
    joined: dict[uuid.UUID, tuple[Channel, str]],
) -> list[CalendarEventOut]:
    alarms = await repo.alarms_of_user(db, actor.id, [row.id for row in rows])
    out: list[CalendarEventOut] = []
    for row in rows:
        if row.channel_id is None:
            seen = _Seen(row, None, None)
        else:
            channel, role = joined[row.channel_id]
            seen = _Seen(row, channel, role)
        out.append(to_out(seen, actor, alarms.get(row.id)))
    return out


# --- reading -------------------------------------------------------------------------------------


async def list_range(
    db: AsyncSession,
    actor: User,
    start: datetime,
    end: datetime,
    channel_id: uuid.UUID | None,
) -> list[CalendarEventOut]:
    """Events overlapping [start, end): mine and my channels' (or one channel's). All-day events
    overlap by date, the dates read in the offsets `start` and `end` were given in."""
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
    rows = await repo.overlapping(
        db,
        owner_id=owner_id,
        channel_ids=channel_ids,
        start=start,
        end=end,
        first_day=start.date(),
        last_day=(end - timedelta(microseconds=1)).date(),
        limit=MAX_RANGE_EVENTS,
    )
    return await _outs(db, actor, rows, joined)


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
    rows = await repo.overlapping(
        db,
        owner_id=owner_id,
        channel_ids=channel_ids,
        start=now,
        end=end,
        first_day=today,
        last_day=today + timedelta(days=days - 1),
        limit=MAX_RANGE_EVENTS,
    )

    def begins(row: CalendarEvent) -> datetime:
        if row.all_day:
            assert row.start_date is not None
            return datetime.combine(max(row.start_date, today), time(), zone)
        assert row.starts_at is not None
        return row.starts_at

    rows.sort(key=lambda row: (begins(row), not row.all_day, row.id))
    return await _outs(db, actor, rows[:MAX_UPCOMING], joined)


async def get_event(db: AsyncSession, actor: User, event_id: uuid.UUID) -> CalendarEventOut:
    seen = await _load(db, actor, event_id)
    return to_out(seen, actor, await repo.alarm(db, event_id, actor.id))


# --- changes -------------------------------------------------------------------------------------


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
    now = utcnow()
    event = CalendarEvent(
        channel_id=data.channel_id,
        owner_id=actor_id,
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
            tz=zone_for(data.tz, actor),
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


async def update(
    db: AsyncSession, actor: User, event_id: uuid.UUID, data: CalendarEventUpdate
) -> CalendarEventOut:
    seen = await _load(db, actor, event_id, lock=True)
    _require_editor(actor, seen)
    event = seen.event
    sent = data.model_fields_set
    if "title" in sent:
        if data.title is None:
            raise bad_request("validation_error", "A title cannot be null")
        event.title = data.title
    if "location" in sent:
        event.location = data.location
    if "description" in sent:
        event.description = data.description

    all_day = data.all_day if data.all_day is not None else event.all_day
    other_pair = (data.starts_at, data.ends_at) if all_day else (data.start_date, data.end_date)
    if any(value is not None for value in other_pair):
        raise bad_request(
            "calendar_invalid_time",
            "An all-day event has dates only" if all_day else "A timed event has times only",
        )
    before = (event.all_day, event.starts_at, event.ends_at, event.start_date, event.end_date)
    timing: tuple[bool, datetime | None, datetime | None, date | None, date | None]
    if all_day:
        start_date = data.start_date if "start_date" in sent else event.start_date
        end_date = data.end_date if "end_date" in sent else event.end_date
        timing = (True, None, None, start_date, end_date)
    else:
        starts_at = _utc(data.starts_at) if "starts_at" in sent else event.starts_at
        ends_at = _utc(data.ends_at) if "ends_at" in sent else event.ends_at
        timing = (False, starts_at, ends_at, None, None)
    check_timing(*timing)
    now = utcnow()
    kind_changed = all_day != event.all_day
    (event.all_day, event.starts_at, event.ends_at, event.start_date, event.end_date) = timing
    event.updated_at = now
    await db.flush()

    if timing != before:
        for alarm in await repo.alarms_of_event(db, event.id):
            if kind_changed:
                alarm.minutes_before = remap_alarm(alarm.minutes_before, all_day)
            _schedule(alarm, event, now)
            await _emit_alarm(db, event, alarm.user_id, alarm)
    mine = await repo.alarm(db, event.id, actor.id)
    await _emit_updated(db, event, seen.channel)
    await db.commit()
    return to_out(seen, actor, mine)


async def delete(db: AsyncSession, actor: User, event_id: uuid.UUID) -> None:
    """Soft delete (the event tells the devices it is gone); its alarms are cancelled."""
    seen = await _load(db, actor, event_id, lock=True)
    _require_editor(actor, seen)
    now = utcnow()
    event = seen.event
    event.deleted_at = now
    event.updated_at = now
    for alarm in await repo.alarms_of_event(db, event.id):
        if alarm.status == "pending":
            alarm.status = "cancelled"
            alarm.updated_at = now
    await _emit_deleted(db, event)
    await db.commit()


async def set_alarm(
    db: AsyncSession, actor: User, event_id: uuid.UUID, data: CalendarAlarmIn
) -> CalendarEventOut:
    """My alarm on an event I can see (only I am notified)."""
    seen = await _load(db, actor, event_id)
    check_alarm(seen.event.all_day, data.minutes_before)
    now = utcnow()
    alarm = await repo.alarm(db, event_id, actor.id)
    if alarm is None:
        alarm = CalendarEventAlarm(event_id=event_id, user_id=actor.id, created_at=now)
        db.add(alarm)
    alarm.minutes_before = data.minutes_before
    alarm.tz = zone_for(data.tz, actor)
    _schedule(alarm, seen.event, now)
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
    event is gone, over, or no longer visible to its owner is cancelled without a word."""
    moment = now or utcnow()
    fired = 0
    for alarm in await repo.due_alarms(db, moment, limit):
        alarm.updated_at = moment
        event = await repo.get(db, alarm.event_id)
        if (
            event is None
            or event.is_deleted
            or ended(event, moment, alarm.tz)
            or not await _still_sees(db, alarm.user_id, event)
        ):
            alarm.status = "cancelled"
            continue
        alarm.status = "fired"
        await _emit_alarm(db, event, alarm.user_id, alarm)
        fired += 1
    await db.commit()
    return fired


async def alarm_notice(
    db: AsyncSession, event_id: uuid.UUID, user_id: uuid.UUID
) -> AlarmNotice | None:
    """The text of a fired alarm, read live; None when it is no longer to be sent."""
    alarm = await repo.alarm(db, event_id, user_id)
    event = await repo.get(db, event_id)
    if alarm is None or alarm.status != "fired" or event is None or event.is_deleted:
        return None
    if not await _still_sees(db, user_id, event):
        return None
    channel = await channels.require_channel(db, event.channel_id) if event.channel_id else None
    name = channel.name if channel is not None else None
    return AlarmNotice(
        event_id=event.id,
        channel_id=event.channel_id,
        body=notice_text(event, name, alarm.tz, alarm.fire_at),
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
