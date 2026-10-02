"""Recurring events' occurrences (M68, CALENDAR.md §10): expansion of a series with its overrides,
the keys of occurrences, and the next occurrence an alarm is for. No database access.

A one-off event is one occurrence of itself (`single`), so the rest of the module (the output, the
notification text, the iCal feed) treats both alike.
"""

import uuid
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.modules.calendar import recurrence
from app.modules.calendar.models import CalendarEvent, CalendarEventOverride

# The alarm worker looks this far ahead for a series' next occurrence; further away, it wakes up
# then to look again (CALENDAR.md §10.5).
ALARM_HORIZON = timedelta(days=400)


@dataclass(frozen=True)
class Occurrence:
    """One occurrence as everyone sees it: the series' fields with its override applied."""

    master: CalendarEvent
    key: str
    title: str
    all_day: bool
    starts_at: datetime | None
    ends_at: datetime | None
    start_date: date | None
    end_date: date | None
    location: str | None
    description: str | None

    @property
    def id(self) -> uuid.UUID:
        return occurrence_id(self.master, self.key)

    def begins(self) -> datetime:
        """For ordering: the start instant (an all-day one: midnight UTC of its first day)."""
        if self.all_day:
            assert self.start_date is not None
            return datetime.combine(self.start_date, time(), UTC)
        assert self.starts_at is not None
        return self.starts_at


@dataclass(frozen=True)
class Wake:
    """No occurrence near: look again at this time (CALENDAR.md §10.5)."""

    at: datetime


# --- keys ----------------------------------------------------------------------------------------


def zone_of(event: CalendarEvent) -> ZoneInfo:
    return ZoneInfo(event.tz or "UTC")


def first_key(event: CalendarEvent) -> str:
    """The key of an event's own start (its first occurrence)."""
    if event.all_day:
        assert event.start_date is not None
        return recurrence.key_of_date(event.start_date)
    assert event.starts_at is not None
    return recurrence.key_of_instant(event.starts_at)


def occurrence_id(master: CalendarEvent, key: str) -> uuid.UUID:
    """The series' own id for its first occurrence; a stable, distinct id for the others."""
    if not master.recurring or key == first_key(master):
        return master.id
    return uuid.uuid5(master.id, key)


def first_day(master: CalendarEvent) -> date:
    """The date of the first occurrence (a timed one's in the series' zone)."""
    if master.all_day:
        assert master.start_date is not None
        return master.start_date
    assert master.starts_at is not None
    return master.starts_at.astimezone(zone_of(master)).date()


def key_day(master: CalendarEvent, key: str) -> date:
    """The local date an occurrence key falls on."""
    if master.all_day:
        return date.fromisoformat(key)
    moment = datetime.fromisoformat(key.replace("Z", "+00:00"))
    return moment.astimezone(zone_of(master)).date()


def rule_of(master: CalendarEvent) -> recurrence.Rule:
    assert master.rrule is not None
    return recurrence.parse(master.rrule)


def single(event: CalendarEvent) -> Occurrence:
    return Occurrence(
        master=event,
        key=first_key(event),
        title=event.title,
        all_day=event.all_day,
        starts_at=event.starts_at,
        ends_at=event.ends_at,
        start_date=event.start_date,
        end_date=event.end_date,
        location=event.location,
        description=event.description,
    )


def base_occurrence(master: CalendarEvent, day: date) -> Occurrence:
    """The occurrence on a local date as the series has it (no override)."""
    first = single(master)
    if day == first_day(master):
        return first
    if master.all_day:
        assert master.start_date is not None and master.end_date is not None
        return replace(
            first,
            key=recurrence.key_of_date(day),
            start_date=day,
            end_date=day + (master.end_date - master.start_date),
        )
    assert master.starts_at is not None and master.ends_at is not None
    zone = zone_of(master)
    start = recurrence.timed_start(day, master.starts_at.astimezone(zone).time(), zone)
    return replace(
        first,
        key=recurrence.key_of_instant(start),
        starts_at=start,
        ends_at=start + (master.ends_at - master.starts_at),
    )


def apply(occ: Occurrence, override: CalendarEventOverride | None) -> Occurrence | None:
    """The occurrence with its override; None when it is cancelled."""
    if override is None:
        return occ
    if override.cancelled:
        return None
    changed = set(override.changed)
    result = occ
    if "title" in changed and override.title:
        result = replace(result, title=override.title)
    if "location" in changed:
        result = replace(result, location=override.location)
    if "description" in changed:
        result = replace(result, description=override.description)
    if override.moved:
        result = replace(
            result,
            all_day=bool(override.all_day),
            starts_at=override.starts_at,
            ends_at=override.ends_at,
            start_date=override.start_date,
            end_date=override.end_date,
        )
    return result


def is_valid_key(master: CalendarEvent, key: str) -> bool:
    """Whether the key is one of the series' occurrences (cancelled ones included)."""
    if not master.recurring:
        return key == first_key(master)
    try:
        day = key_day(master, key)
    except ValueError:
        return False
    if not recurrence.is_occurrence(rule_of(master), first_day(master), day):
        return False
    return base_occurrence(master, day).key == key


def resolve(
    master: CalendarEvent, overrides: dict[str, CalendarEventOverride], key: str
) -> Occurrence | None:
    """The occurrence with that key as it is now; None when there is none (or it is cancelled)."""
    if not is_valid_key(master, key):
        return None
    if not master.recurring:
        return single(master)
    return apply(base_occurrence(master, key_day(master, key)), overrides.get(key))


def _originals(master: CalendarEvent, *, after: date, stop: date) -> Iterator[Occurrence]:
    for day in recurrence.dates(rule_of(master), first_day(master), stop=stop, after=after):
        yield base_occurrence(master, day)


def _span_days(master: CalendarEvent) -> int:
    if master.all_day:
        assert master.start_date is not None and master.end_date is not None
        return (master.end_date - master.start_date).days
    assert master.starts_at is not None and master.ends_at is not None
    return (master.ends_at - master.starts_at).days + 1


def overlaps(occ: Occurrence, start: datetime, end: datetime, first: date, last: date) -> bool:
    """CALENDAR.md §4's rule: timed by instant in [start, end), all-day by date in first..last."""
    if occ.all_day:
        assert occ.start_date is not None and occ.end_date is not None
        return occ.start_date <= last and occ.end_date >= first
    assert occ.starts_at is not None and occ.ends_at is not None
    return occ.starts_at < end and occ.ends_at > start


def expand(
    master: CalendarEvent,
    overrides: Iterable[CalendarEventOverride],
    *,
    start: datetime,
    end: datetime,
    first: date,
    last: date,
) -> list[Occurrence]:
    """The series' occurrences overlapping the range, overrides applied (cancelled ones left out,
    moved ones where they were moved to)."""
    by_key = {o.occurrence_start: o for o in overrides}
    span = _span_days(master)
    if master.all_day:
        after, stop = first - timedelta(days=span + 1), last + timedelta(days=1)
    else:
        zone = zone_of(master)
        after = start.astimezone(zone).date() - timedelta(days=span + 1)
        stop = end.astimezone(zone).date() + timedelta(days=2)
    found: list[Occurrence] = []
    for occ in _originals(master, after=after, stop=stop):
        override = by_key.get(occ.key)
        if override is not None and (override.cancelled or override.moved):
            continue
        applied = apply(occ, override)
        if applied is not None and overlaps(applied, start, end, first, last):
            found.append(applied)
    for override in by_key.values():
        if override.cancelled or not override.moved:
            continue
        try:
            day = key_day(master, override.occurrence_start)
        except ValueError:
            continue
        applied = apply(base_occurrence(master, day), override)
        if applied is not None and overlaps(applied, start, end, first, last):
            found.append(applied)
    found.sort(key=lambda o: (o.begins(), o.key))
    return found


def series_end(master: CalendarEvent) -> datetime | None:
    """A bound on the last occurrence's end (None: no end, or not recurring)."""
    if not master.recurring:
        return None
    bound = recurrence.end_bound(rule_of(master), first_day(master))
    if bound is None:
        return None
    return datetime.combine(bound + timedelta(days=_span_days(master) + 2), time(), UTC)


def stale_overrides(
    master: CalendarEvent, overrides: Iterable[CalendarEventOverride]
) -> list[CalendarEventOverride]:
    """The overrides whose key is no longer an occurrence of the series (CALENDAR.md §10.1 「すべて
    の予定」): they go."""
    if not master.recurring:
        return list(overrides)
    stale = []
    for override in overrides:
        kind_ok = master.all_day == ("T" not in override.occurrence_start)
        if not kind_ok or not is_valid_key(master, override.occurrence_start):
            stale.append(override)
    return stale


def next_for_alarm(
    master: CalendarEvent,
    overrides: Iterable[CalendarEventOverride],
    fire_at_of: Callable[[Occurrence], datetime],
    now: datetime,
) -> tuple[Occurrence, datetime] | Wake | None:
    """The occurrence whose alarm goes out next (its time after `now`), with that time; a Wake
    when none is within ALARM_HORIZON but the series goes on; None when the series is over."""
    by_key = {o.occurrence_start: o for o in overrides}
    zone = zone_of(master)
    after = now.astimezone(zone).date() - timedelta(days=_span_days(master) + 2)
    # Up to 400 days past now, or past the series' start when that is later.
    horizon = max(now, single(master).begins()) + ALARM_HORIZON
    stop = horizon.astimezone(zone).date()
    best: tuple[Occurrence, datetime] | None = None
    for occ in _originals(master, after=after, stop=stop):
        override = by_key.get(occ.key)
        if override is not None and (override.cancelled or override.moved):
            continue
        applied = apply(occ, override)
        if applied is None:
            continue
        fire_at = fire_at_of(applied)
        if fire_at > now:
            best = (applied, fire_at)
            break
    for override in by_key.values():
        if override.cancelled or not override.moved:
            continue
        try:
            day = key_day(master, override.occurrence_start)
        except ValueError:
            continue
        applied = apply(base_occurrence(master, day), override)
        if applied is None:
            continue
        fire_at = fire_at_of(applied)
        if fire_at > now and (best is None or fire_at < best[1]):
            best = (applied, fire_at)
    if best is not None:
        return best
    bound = recurrence.end_bound(rule_of(master), first_day(master))
    if bound is None or bound >= stop:
        return Wake(horizon)
    return None
