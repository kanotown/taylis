"""Scheduling polls (M53, SCHEDULING.md): the slots' rules and their Japanese labels.

A slot is either timed ({"starts_at", "ends_at"}, UTC instants, 15 minutes to 12 hours) or all
day ({"date"}). The labels are made once, in the poll's zone (the creator's device), and stored
as the poll's `options`, so an app before M53 shows the poll as a plain multiple-choice one.
"""

from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

MIN_SLOTS = 2
MAX_SLOTS = 20
MIN_SLOT = timedelta(minutes=15)
MAX_SLOT = timedelta(hours=12)

_WEEKDAYS = "月火水木金土日"  # date.weekday(): Monday is 0


def _day(value: date) -> str:
    """「10/3 (土)」."""
    return f"{value.month}/{value.day} ({_WEEKDAYS[value.weekday()]})"


def _clock(value: datetime) -> str:
    return f"{value.hour}:{value.minute:02d}"


def slot_label(slot: dict[str, Any], tz: str) -> str:
    """「10/3 (土) 14:00〜15:00」, 「10/5 (月) 終日」; past midnight 「22:00〜24:00」 /
    「22:00〜翌1:30」, in `tz`."""
    if "date" in slot:
        return f"{_day(date.fromisoformat(slot['date']))} 終日"
    zone = ZoneInfo(tz)
    start = datetime.fromisoformat(slot["starts_at"]).astimezone(zone)
    end = datetime.fromisoformat(slot["ends_at"]).astimezone(zone)
    if end.date() == start.date():
        until = _clock(end)
    elif end.date() == start.date() + timedelta(days=1) and (end.hour, end.minute) == (0, 0):
        until = "24:00"
    else:
        until = f"翌{_clock(end)}"
    return f"{_day(start.date())} {_clock(start)}〜{until}"


def stored_slot(
    starts_at: datetime | None, ends_at: datetime | None, day: date | None
) -> dict[str, str]:
    """The JSON a slot is kept as in messages.poll (validated beforehand)."""
    if day is not None:
        return {"date": day.isoformat()}
    assert starts_at is not None and ends_at is not None
    return {
        "starts_at": starts_at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        "ends_at": ends_at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
    }


def slot_key(slot: dict[str, str]) -> tuple[str, ...]:
    """Two slots are the same when they cover the same time (the order the client sent stays)."""
    if "date" in slot:
        return ("date", slot["date"])
    return (
        "time",
        datetime.fromisoformat(slot["starts_at"]).isoformat(),
        datetime.fromisoformat(slot["ends_at"]).isoformat(),
    )


def decided_text(label: str, yes: int, maybe: int) -> str:
    """The thread reply's first line (SCHEDULING.md §4)."""
    return f"📅 日程が決まりました: {label} (○ {yes} · △ {maybe})"
