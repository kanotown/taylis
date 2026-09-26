"""Do not disturb (M12c): a manual pause (`dnd_until`) or a daily quiet-hours window.

Quiet hours are evaluated in the user's own time zone. A window that crosses midnight
(22:00 → 07:00) belongs to the day it starts on: with days = {Fri} it runs Friday night
into Saturday morning. Both the push planner and the clients apply this same rule.
"""

from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.modules.users.models import User


def valid_zone(name: str) -> bool:
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return False
    return True


def in_quiet_hours(now: datetime, *, start: int, end: int, days: list[int] | None, tz: str) -> bool:
    """`start` / `end` are minutes after local midnight; `days` are weekdays (0 = Monday)."""
    if start == end:
        return False
    local = now.astimezone(ZoneInfo(tz))
    minutes = local.hour * 60 + local.minute
    weekday = local.weekday()
    allowed = set(days) if days else set(range(7))
    if start < end:
        return start <= minutes < end and weekday in allowed
    # Overnight: the evening part belongs to today, the morning part to yesterday's window.
    if minutes >= start:
        return weekday in allowed
    return minutes < end and (weekday - 1) % 7 in allowed


def dnd_active(user: User, now: datetime) -> bool:
    if user.dnd_until is not None and user.dnd_until > now:
        return True
    if (
        user.quiet_hours_start is None
        or user.quiet_hours_end is None
        or not user.quiet_hours_tz
        or not valid_zone(user.quiet_hours_tz)
    ):
        return False
    return in_quiet_hours(
        now,
        start=user.quiet_hours_start,
        end=user.quiet_hours_end,
        days=user.quiet_hours_days,
        tz=user.quiet_hours_tz,
    )
