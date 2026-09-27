"""Query modifiers as in Slack / Mattermost: from:@user in:#channel before: after: on: (YYYY-MM-DD),
and (M15h) has:file / has:link / has:pin / has:reaction / has:poll and is:thread.

Parsing is pure; the service resolves names against what the caller can see.
"""

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

MODIFIER = re.compile(r"(?<!\S)(from|in|before|after|on|has|is):(\S+)")

# M15h: accepted spellings → the flag the repository understands (order = display order).
HAS_ALIASES = {
    "file": "file",
    "files": "file",
    "attachment": "file",
    "attachments": "file",
    "link": "link",
    "links": "link",
    "url": "link",
    "pin": "pin",
    "pins": "pin",
    "pinned": "pin",
    "reaction": "reaction",
    "reactions": "reaction",
    "poll": "poll",
    "polls": "poll",
}
IS_ALIASES = {"thread": "thread", "threads": "thread"}


@dataclass
class ParsedQuery:
    text: str
    from_users: list[str] = field(default_factory=list)
    in_channels: list[str] = field(default_factory=list)
    after: datetime | None = None
    before: datetime | None = None
    unresolved: list[str] = field(default_factory=list)
    # M15h: "has:<x>" flags (file, link, pin, reaction, poll) and "is:thread".
    has: list[str] = field(default_factory=list)
    is_thread: bool = False

    @property
    def has_modifiers(self) -> bool:
        return bool(
            self.from_users
            or self.in_channels
            or self.after
            or self.before
            or self.has
            or self.is_thread
        )


def parse_query(q: str, *, tz_offset_minutes: int = 0) -> ParsedQuery:
    """Strip modifiers from `q`; dates are midnight in the caller's zone, exclusive like Slack."""
    zone = timezone(timedelta(minutes=tz_offset_minutes))
    parsed = ParsedQuery(text="")

    def day(value: str) -> datetime | None:
        try:
            parsed_day = date.fromisoformat(value)
        except ValueError:
            return None
        return datetime(parsed_day.year, parsed_day.month, parsed_day.day, tzinfo=zone)

    def replace(match: re.Match[str]) -> str:
        key, value = match.group(1), match.group(2)
        if key == "from":
            parsed.from_users.append(value.lstrip("@"))
        elif key == "in":
            parsed.in_channels.append(value.lstrip("#"))
        elif key == "has":
            flag = HAS_ALIASES.get(value.lower())
            if flag is None:
                parsed.unresolved.append(match.group(0))
            elif flag not in parsed.has:
                parsed.has.append(flag)
        elif key == "is":
            if IS_ALIASES.get(value.lower()) is None:
                parsed.unresolved.append(match.group(0))
            else:
                parsed.is_thread = True
        else:
            start = day(value)
            if start is None:
                parsed.unresolved.append(match.group(0))
            elif key == "before":
                parsed.before = min_dt(parsed.before, start)
            elif key == "after":
                parsed.after = max_dt(parsed.after, start + timedelta(days=1))
            else:  # on
                parsed.after = max_dt(parsed.after, start)
                parsed.before = min_dt(parsed.before, start + timedelta(days=1))
        return " "

    parsed.text = " ".join(MODIFIER.sub(replace, q).split())
    return parsed


def min_dt(a: datetime | None, b: datetime | None) -> datetime | None:
    if a is None:
        return b
    if b is None:
        return a
    return min(a, b)


def max_dt(a: datetime | None, b: datetime | None) -> datetime | None:
    if a is None:
        return b
    if b is None:
        return a
    return max(a, b)
