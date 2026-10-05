"""The pure parts of recurring posts (RECURRING.md §2, §4): when a schedule runs next, when a
collection is due, and the template placeholders (the clients' rule, apps/shared/templates.json).

Local times are read in the post's zone. A time that a daylight-saving change skips (02:30 on the
spring-forward day) runs at the same distance after the change (03:30); a time that happens twice
(01:30 on the fall-back day) runs at its first occurrence. Asia/Tokyo has neither.
"""

import calendar
import re
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app import i18n

WEEKDAYS_JA = ("月", "火", "水", "木", "金", "土", "日")  # date.weekday(): 0 = Monday
TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
_PLACEHOLDER = re.compile(r"\{(date|weekday|week)\}")
# A weekly schedule runs within 7 days and a monthly one within 62; this bounds the search.
_SEARCH_DAYS = 400


def parse_time(value: str) -> time:
    match = TIME_PATTERN.match(value)
    if match is None:
        raise ValueError("Use HH:MM (00:00 to 23:59)")
    return time(int(match.group(1)), int(match.group(2)))


def at_local(day: date, clock: time, tz: str) -> datetime:
    """`clock` on `day` in `tz`, as UTC (fold 0: see the module's note on DST)."""
    local = datetime.combine(day, clock, ZoneInfo(tz))
    # Round-trip through UTC so a skipped wall time lands after the change, not before it.
    return local.astimezone(UTC)


def runs_on(schedule: dict[str, Any], day: date) -> bool:
    if schedule["kind"] == "weekly":
        return day.weekday() in schedule["weekdays"]
    last = calendar.monthrange(day.year, day.month)[1]
    return day.day == min(int(schedule["day"]), last)


def next_run_after(schedule: dict[str, Any], tz: str, after: datetime) -> datetime:
    """The first time the schedule runs strictly after `after` (an aware instant)."""
    clock = parse_time(schedule["time"])
    start = after.astimezone(ZoneInfo(tz)).date() - timedelta(days=1)
    for offset in range(_SEARCH_DAYS):
        day = start + timedelta(days=offset)
        if runs_on(schedule, day):
            moment = at_local(day, clock, tz)
            if moment > after:
                return moment
    raise ValueError("The schedule never runs")  # unreachable for a valid schedule


def due_at(posted_at: datetime, after_days: int, due_time: str, tz: str) -> datetime:
    """The posting day (in `tz`) plus `after_days`, at `due_time`. A due time that would not be
    after the post (the same day, earlier than a late post: 今すぐ投稿, or a catch-up) moves on a
    day at a time, so a collection never starts overdue."""
    day = posted_at.astimezone(ZoneInfo(tz)).date() + timedelta(days=after_days)
    clock = parse_time(due_time)
    moment = at_local(day, clock, tz)
    while moment <= posted_at:
        day += timedelta(days=1)
        moment = at_local(day, clock, tz)
    return moment


def due_label(moment: datetime, tz: str, locale: str = "ja") -> str:
    """「10/9 (金) 18:00」 in the post's zone (the nudge's note), in `locale` (M115)."""
    local = moment.astimezone(ZoneInfo(tz))
    return i18n.t(
        "reservation.on_day",
        locale,
        month=local.month,
        day=local.day,
        weekday=i18n.weekday(local.weekday(), locale),
        time=f"{local:%H:%M}",
    )


def iso_week(day: date) -> str:
    year, week, _ = day.isocalendar()
    return f"{year}-W{week:02d}"


def expand_template(body: str, today: date) -> str:
    """`{date}` `{weekday}` `{week}` replaced once (the result is not read again); any other
    `{…}` stays. The clients' expandTemplate (apps/shared/templates.json `expand`)."""
    weekday = WEEKDAYS_JA[today.weekday()]

    def replace(match: re.Match[str]) -> str:
        key = match.group(1)
        if key == "date":
            return f"{today.year}/{today.month:02d}/{today.day:02d} ({weekday})"
        if key == "weekday":
            return weekday
        return iso_week(today)

    return _PLACEHOLDER.sub(replace, body)


def local_date(moment: datetime, tz: str) -> date:
    return moment.astimezone(ZoneInfo(tz)).date()
