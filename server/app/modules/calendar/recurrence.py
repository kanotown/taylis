"""Recurring events (M68, CALENDAR.md §10): the RRULE subset and its expansion. Pure functions.

The subset of RFC 5545 an event may carry: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL (1-99),
BYDAY (weekly: plain weekdays; monthly: one nth weekday such as 2TU or -1FR), BYMONTHDAY (monthly:
1-31 or -1), UNTIL (a date, included) or COUNT (1-999). Anything else is refused.

Occurrences are local dates: a timed event repeats on the wall clock of its zone, an all-day one
by date. The event's own start (DTSTART) is always the first occurrence and counts toward COUNT
(as Google Calendar does). A day a month or year lacks (the 31st, a 5th Tuesday, 29 February) is
skipped, as RFC 5545 says.
"""

import calendar as _cal
import re
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

FREQS = ("DAILY", "WEEKLY", "MONTHLY", "YEARLY")
WEEKDAYS = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")
MAX_INTERVAL = 99
MAX_COUNT = 999
# A rule that yields nothing for this many periods in a row is given up on (e.g. the 30th of a
# February every 12 months); callers always bound the walk by a stop date as well.
_MAX_EMPTY_PERIODS = 2000

_NTH_DAY = re.compile(r"^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$")


class RRuleError(ValueError):
    """The rule is not one this server understands (400 calendar_invalid_rrule)."""


@dataclass(frozen=True)
class Rule:
    freq: str
    interval: int = 1
    # Weekly: (None, weekday) entries; monthly: one (n, weekday) entry. Monday is 0.
    byday: tuple[tuple[int | None, int], ...] = ()
    bymonthday: int | None = None
    until: date | None = None
    count: int | None = None


def parse(text: str) -> Rule:
    """Reads and checks a rule ("RRULE:" may lead). Raises RRuleError."""
    raw = text.strip()
    if raw.upper().startswith("RRULE:"):
        raw = raw[6:]
    if not raw or len(raw) > 200:
        raise RRuleError("Empty or too long rule")
    parts: dict[str, str] = {}
    for part in raw.split(";"):
        if "=" not in part:
            raise RRuleError(f"Not NAME=VALUE: {part!r}")
        name, value = part.split("=", 1)
        name = name.strip().upper()
        if name in parts:
            raise RRuleError(f"{name} twice")
        parts[name] = value.strip().upper()
    unknown = set(parts) - {"FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "UNTIL", "COUNT"}
    if unknown:
        raise RRuleError(f"Not supported: {', '.join(sorted(unknown))}")
    freq = parts.get("FREQ")
    if freq not in FREQS:
        raise RRuleError("FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY")
    interval = _int(parts.get("INTERVAL", "1"), "INTERVAL", 1, MAX_INTERVAL)
    byday: tuple[tuple[int | None, int], ...] = ()
    if "BYDAY" in parts:
        if freq not in ("WEEKLY", "MONTHLY"):
            raise RRuleError("BYDAY only with WEEKLY or MONTHLY")
        entries = []
        for item in parts["BYDAY"].split(","):
            match = _NTH_DAY.match(item.strip())
            if not match:
                raise RRuleError(f"Bad BYDAY entry: {item!r}")
            n = int(match.group(1)) if match.group(1) else None
            entries.append((n, WEEKDAYS.index(match.group(2))))
        if freq == "WEEKLY":
            if any(n is not None for n, _ in entries):
                raise RRuleError("A weekly BYDAY has plain weekdays")
            days = sorted({wd for _, wd in entries})
            byday = tuple((None, wd) for wd in days)
        else:
            if len(entries) != 1 or entries[0][0] is None:
                raise RRuleError("A monthly BYDAY is one nth weekday, such as 2TU or -1FR")
            n = entries[0][0]
            assert n is not None
            if not (1 <= n <= 5 or n == -1):
                raise RRuleError("The nth weekday is 1-5 or -1")
            byday = (entries[0],)
    bymonthday: int | None = None
    if "BYMONTHDAY" in parts:
        if freq != "MONTHLY":
            raise RRuleError("BYMONTHDAY only with MONTHLY")
        if byday:
            raise RRuleError("BYDAY and BYMONTHDAY together are not supported")
        try:
            bymonthday = int(parts["BYMONTHDAY"])
        except ValueError as exc:
            raise RRuleError("BYMONTHDAY is one day of the month") from exc
        if not (1 <= bymonthday <= 31 or bymonthday == -1):
            raise RRuleError("BYMONTHDAY is 1-31 or -1")
    if "UNTIL" in parts and "COUNT" in parts:
        raise RRuleError("UNTIL and COUNT together")
    until: date | None = None
    if "UNTIL" in parts:
        value = parts["UNTIL"]
        if not re.fullmatch(r"\d{8}", value):
            raise RRuleError("UNTIL is a date (YYYYMMDD)")
        try:
            until = date(int(value[:4]), int(value[4:6]), int(value[6:]))
        except ValueError as exc:
            raise RRuleError("UNTIL is not a date") from exc
    count = _int(parts["COUNT"], "COUNT", 1, MAX_COUNT) if "COUNT" in parts else None
    return Rule(freq, interval, byday, bymonthday, until, count)


def _int(value: str, name: str, low: int, high: int) -> int:
    if not re.fullmatch(r"\d{1,4}", value):
        raise RRuleError(f"{name} is a number")
    number = int(value)
    if not low <= number <= high:
        raise RRuleError(f"{name} is {low}-{high}")
    return number


def format_rule(rule: Rule) -> str:
    """The normalized text: FREQ;INTERVAL;BYDAY;BYMONTHDAY;UNTIL|COUNT, INTERVAL=1 left out."""
    parts = [f"FREQ={rule.freq}"]
    if rule.interval != 1:
        parts.append(f"INTERVAL={rule.interval}")
    if rule.byday:
        parts.append(
            "BYDAY=" + ",".join(f"{'' if n is None else n}{WEEKDAYS[wd]}" for n, wd in rule.byday)
        )
    if rule.bymonthday is not None:
        parts.append(f"BYMONTHDAY={rule.bymonthday}")
    if rule.until is not None:
        parts.append(f"UNTIL={rule.until.strftime('%Y%m%d')}")
    if rule.count is not None:
        parts.append(f"COUNT={rule.count}")
    return ";".join(parts)


def normalize(text: str) -> str:
    return format_rule(parse(text))


def with_end(rule: Rule, *, until: date | None = None, count: int | None = None) -> Rule:
    return Rule(rule.freq, rule.interval, rule.byday, rule.bymonthday, until, count)


# --- expansion -----------------------------------------------------------------------------------


def _add_months(year: int, month: int, months: int) -> tuple[int, int]:
    index = year * 12 + (month - 1) + months
    return index // 12, index % 12 + 1


def _nth_weekday(year: int, month: int, n: int, weekday: int) -> date | None:
    days = _cal.monthrange(year, month)[1]
    if n > 0:
        first = date(year, month, 1)
        day = 1 + (weekday - first.weekday()) % 7 + (n - 1) * 7
    else:
        last = date(year, month, days)
        day = days - (last.weekday() - weekday) % 7 + (n + 1) * 7
    if 1 <= day <= days:
        return date(year, month, day)
    return None


def _period_dates(rule: Rule, first: date, k: int) -> list[date]:
    """The candidate dates of period k (k * INTERVAL periods after the first's), in order."""
    step = k * rule.interval
    if rule.freq == "DAILY":
        return [first + timedelta(days=step)]
    if rule.freq == "WEEKLY":
        monday = first - timedelta(days=first.weekday()) + timedelta(weeks=step)
        weekdays = [wd for _, wd in rule.byday] or [first.weekday()]
        return [monday + timedelta(days=wd) for wd in weekdays]
    if rule.freq == "MONTHLY":
        year, month = _add_months(first.year, first.month, step)
        days = _cal.monthrange(year, month)[1]
        if rule.byday:
            n, wd = rule.byday[0]
            assert n is not None
            found = _nth_weekday(year, month, n, wd)
            return [found] if found else []
        day = rule.bymonthday if rule.bymonthday is not None else first.day
        if day == -1:
            day = days
        return [date(year, month, day)] if day <= days else []
    year = first.year + step
    if first.month == 2 and first.day == 29 and not _cal.isleap(year):
        return []
    return [date(year, first.month, first.day)]


def _period_of(rule: Rule, first: date, day: date) -> int:
    """The period (k) holding `day` (rounded down; never below 0)."""
    if day <= first:
        return 0
    if rule.freq == "DAILY":
        return (day - first).days // rule.interval
    if rule.freq == "WEEKLY":
        weeks = (day - timedelta(days=day.weekday())) - (first - timedelta(days=first.weekday()))
        return (weeks.days // 7) // rule.interval
    if rule.freq == "MONTHLY":
        months = (day.year - first.year) * 12 + (day.month - first.month)
        return months // rule.interval
    return (day.year - first.year) // rule.interval


def dates(rule: Rule, first: date, *, stop: date, after: date | None = None) -> Iterator[date]:
    """The occurrences' dates in order, `first` (DTSTART) first, before `stop` (excluded). With
    `after`, only dates on or after it (skipping ahead when the rule has no COUNT)."""
    emitted = 0
    if (after is None or first >= after) and first < stop:
        yield first
    emitted = 1
    if rule.count is not None and emitted >= rule.count:
        return
    k = 0
    if after is not None and rule.count is None:
        k = max(0, _period_of(rule, first, after) - 1)
    empty = 0
    while True:
        try:
            candidates = _period_dates(rule, first, k)
            if not candidates:
                # A skipped month or year: still stop once the walk is past `stop`.
                if rule.freq == "MONTHLY":
                    year, month = _add_months(first.year, first.month, k * rule.interval)
                    begins = date(year, month, 1)
                else:
                    begins = date(first.year + k * rule.interval, 1, 1)
                if begins >= stop:
                    return
        except (OverflowError, ValueError):
            return  # past the year 9999
        produced = False
        for day in candidates:
            if day <= first:
                continue
            if (rule.until is not None and day > rule.until) or day >= stop:
                return
            produced = True
            emitted += 1
            if after is None or day >= after:
                yield day
            if rule.count is not None and emitted >= rule.count:
                return
        empty = 0 if produced else empty + 1
        if empty > _MAX_EMPTY_PERIODS:
            return
        k += 1


def end_bound(rule: Rule, first: date) -> date | None:
    """A date on or after the last occurrence (the last one itself with COUNT, UNTIL otherwise),
    or None when the rule has no end."""
    if rule.count is not None:
        last = first
        for day in dates(rule, first, stop=date.max):
            last = day
        return last
    if rule.until is not None:
        return max(rule.until, first)
    return None


def is_occurrence(rule: Rule, first: date, day: date) -> bool:
    for found in dates(rule, first, stop=day + timedelta(days=1), after=day):
        return found == day
    return False


def count_before(rule: Rule, first: date, day: date) -> int:
    """How many occurrences fall before `day`."""
    return sum(1 for _ in dates(rule, first, stop=day))


# --- keys and instants ---------------------------------------------------------------------------


def timed_start(day: date, wall: time, zone: ZoneInfo) -> datetime:
    """The UTC instant of `wall` on `day` in `zone` (a time in a DST gap reads with the offset
    before the change, so it lands an hour later)."""
    return datetime.combine(day, wall, zone).astimezone(UTC)


def key_of_instant(value: datetime) -> str:
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def key_of_date(value: date) -> str:
    return value.isoformat()


def parse_key(value: str, all_day: bool) -> str:
    """A key from a URL: a date for an all-day series, an instant (any offset) for a timed one;
    normalized. Raises ValueError."""
    text = value.strip()
    if all_day:
        return date.fromisoformat(text).isoformat()
    if text.endswith("Z") or text.endswith("z"):
        text = text[:-1] + "+00:00"
    moment = datetime.fromisoformat(text)
    if moment.tzinfo is None:
        raise ValueError("An instant needs an offset")
    return key_of_instant(moment)
