"""The iCal (RFC 5545) text of a calendar feed (M68, CALENDAR.md §10.6). Pure functions.

One-off timed events are written in UTC; a recurring timed event in its zone (TZID, with a
VTIMEZONE built from zoneinfo's changes around the feed's days) so the repeats follow its wall
clock across daylight saving. All-day events are dates (DTEND the day after the last). A series is
its first VEVENT with RRULE and an EXDATE per cancelled occurrence, then one VEVENT per changed
occurrence (RECURRENCE-ID: its original start).
"""

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.modules.calendar import recurrence, series
from app.modules.calendar.models import CalendarEvent, CalendarEventOverride
from app.modules.calendar.series import Occurrence

PRODID = "-//ChikuwaChat//Calendar//JA"
# The zone changes a VTIMEZONE lists: from a year before now to this many years after.
_TZ_YEARS_AHEAD = 6


@dataclass(frozen=True)
class Entry:
    event: CalendarEvent
    channel_name: str | None
    overrides: list[CalendarEventOverride] = field(default_factory=list)


def escape_text(value: str) -> str:
    """RFC 5545 §3.3.11 TEXT."""
    return (
        value.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\n", "\\n")
    )


def fold(line: str) -> str:
    """RFC 5545 §3.1: lines longer than 75 octets go on in lines starting with a space, never
    splitting a UTF-8 character."""
    out: list[str] = []
    current = ""
    size = 0
    limit = 75
    for char in line:
        width = len(char.encode("utf-8"))
        if size + width > limit:
            out.append(current)
            current, size, limit = " ", 1, 75
        current += char
        size += width
    out.append(current)
    return "\r\n".join(out)


def _utc_stamp(value: datetime) -> str:
    return value.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def _local_stamp(value: datetime, zone: ZoneInfo) -> str:
    return value.astimezone(zone).strftime("%Y%m%dT%H%M%S")


def _date_stamp(value: date) -> str:
    return value.strftime("%Y%m%d")


def _offset(seconds: int) -> str:
    sign = "+" if seconds >= 0 else "-"
    seconds = abs(seconds)
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{sign}{hours:02d}{minutes:02d}" + (f"{secs:02d}" if secs else "")


def _utcoffset(zone: ZoneInfo, moment: datetime) -> int:
    offset = moment.astimezone(zone).utcoffset()
    return int(offset.total_seconds()) if offset is not None else 0


def _transitions(zone: ZoneInfo, start: datetime, end: datetime) -> list[datetime]:
    """The instants (UTC) the zone's offset changes in [start, end), to the second."""
    found = []
    step = timedelta(days=1)
    moment = start
    before = _utcoffset(zone, moment)
    while moment < end:
        later = moment + step
        after = _utcoffset(zone, later)
        if after != before:
            low, high = moment, later
            while high - low > timedelta(seconds=1):
                middle = low + (high - low) / 2
                if _utcoffset(zone, middle) == before:
                    low = middle
                else:
                    high = middle
            found.append(high.replace(microsecond=0))
        moment, before = later, after
    return found


def vtimezone(name: str, now: datetime) -> list[str]:
    zone = ZoneInfo(name)
    start = now - timedelta(days=366)
    end = now + timedelta(days=366 * _TZ_YEARS_AHEAD)
    lines = ["BEGIN:VTIMEZONE", f"TZID:{name}"]

    def observance(at_local: str, before: int, after: int, moment: datetime) -> None:
        local = moment.astimezone(zone)
        kind = "DAYLIGHT" if local.dst() else "STANDARD"
        lines.extend(
            [
                f"BEGIN:{kind}",
                f"DTSTART:{at_local}",
                f"TZOFFSETFROM:{_offset(before)}",
                f"TZOFFSETTO:{_offset(after)}",
                f"TZNAME:{escape_text(local.tzname() or name)}",
                f"END:{kind}",
            ]
        )

    first = _utcoffset(zone, start)
    observance("19700101T000000", first, first, start)
    for moment in _transitions(zone, start, end):
        before = _utcoffset(zone, moment - timedelta(seconds=1))
        after = _utcoffset(zone, moment)
        wall = (moment + timedelta(seconds=before)).replace(tzinfo=None)
        observance(wall.strftime("%Y%m%dT%H%M%S"), before, after, moment)
    lines.append("END:VTIMEZONE")
    return lines


def _rrule_line(master: CalendarEvent) -> str:
    """The stored rule; a timed series' UNTIL (a date) becomes the end of that day in its zone,
    in UTC (RFC 5545 asks for UTC with a zoned DTSTART)."""
    rule = series.rule_of(master)
    text = recurrence.format_rule(rule)
    if rule.until is not None and not master.all_day:
        zone = series.zone_of(master)
        end = datetime.combine(rule.until, time(23, 59, 59), zone)
        text = text.replace(f"UNTIL={_date_stamp(rule.until)}", f"UNTIL={_utc_stamp(end)}")
    return f"RRULE:{text}"


def _summary(title: str, channel_name: str | None) -> str:
    return f"{title} (#{channel_name})" if channel_name else title


def _timing_lines(occ: Occurrence, zone_name: str | None) -> list[str]:
    if occ.all_day:
        assert occ.start_date is not None and occ.end_date is not None
        return [
            f"DTSTART;VALUE=DATE:{_date_stamp(occ.start_date)}",
            f"DTEND;VALUE=DATE:{_date_stamp(occ.end_date + timedelta(days=1))}",
        ]
    assert occ.starts_at is not None and occ.ends_at is not None
    if zone_name is None:
        return [f"DTSTART:{_utc_stamp(occ.starts_at)}", f"DTEND:{_utc_stamp(occ.ends_at)}"]
    zone = ZoneInfo(zone_name)
    return [
        f"DTSTART;TZID={zone_name}:{_local_stamp(occ.starts_at, zone)}",
        f"DTEND;TZID={zone_name}:{_local_stamp(occ.ends_at, zone)}",
    ]


def _key_value(master: CalendarEvent, key: str) -> str:
    """An occurrence's original start as a RECURRENCE-ID / EXDATE property's parameters+value."""
    if master.all_day:
        return f";VALUE=DATE:{_date_stamp(date.fromisoformat(key))}"
    zone = series.zone_of(master)
    moment = datetime.fromisoformat(key.replace("Z", "+00:00"))
    return f";TZID={master.tz}:{_local_stamp(moment, zone)}"


def _vevent(
    occ: Occurrence,
    channel_name: str | None,
    now: datetime,
    *,
    zone_name: str | None,
    extra: Iterable[str] = (),
) -> list[str]:
    master = occ.master
    lines = [
        "BEGIN:VEVENT",
        f"UID:{master.id}@chikuwachat",
        f"DTSTAMP:{_utc_stamp(now)}",
        f"CREATED:{_utc_stamp(master.created_at)}",
        f"LAST-MODIFIED:{_utc_stamp(master.updated_at)}",
        *_timing_lines(occ, zone_name),
        *extra,
        f"SUMMARY:{escape_text(_summary(occ.title, channel_name))}",
    ]
    if occ.location:
        lines.append(f"LOCATION:{escape_text(occ.location)}")
    if occ.description:
        lines.append(f"DESCRIPTION:{escape_text(occ.description)}")
    lines.append("END:VEVENT")
    return lines


def render(entries: Iterable[Entry], *, now: datetime, name: str) -> str:
    """The VCALENDAR (CRLF lines, folded)."""
    events: list[str] = []
    zones: set[str] = set()
    for entry in entries:
        master = entry.event
        if not master.recurring:
            events += _vevent(series.single(master), entry.channel_name, now, zone_name=None)
            continue
        zone_name = None if master.all_day else master.tz
        if zone_name:
            zones.add(zone_name)
        extra = [_rrule_line(master)]
        changed = []
        for override in sorted(entry.overrides, key=lambda o: o.occurrence_start):
            if override.cancelled:
                extra.append(f"EXDATE{_key_value(master, override.occurrence_start)}")
            else:
                changed.append(override)
        events += _vevent(
            series.single(master), entry.channel_name, now, zone_name=zone_name, extra=extra
        )
        for override in changed:
            day = series.key_day(master, override.occurrence_start)
            occ = series.apply(series.base_occurrence(master, day), override)
            if occ is None:
                continue
            events += _vevent(
                occ,
                entry.channel_name,
                now,
                zone_name=zone_name,
                extra=[f"RECURRENCE-ID{_key_value(master, override.occurrence_start)}"],
            )
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:{PRODID}",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{escape_text(name)}",
        "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
        "X-PUBLISHED-TTL:PT1H",
    ]
    for zone_name in sorted(zones):
        lines += vtimezone(zone_name, now)
    lines += events
    lines.append("END:VCALENDAR")
    return "".join(fold(line) + "\r\n" for line in lines)
