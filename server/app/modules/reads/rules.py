"""Whether a conversation counts as unread and its badge number (SYNC_PROTOCOL.md §10.5).

The same rule runs in the three clients; apps/shared/unread-rules.json holds the vectors every
implementation is tested against. Plain values in, plain values out: callers look up the channel,
the notification preference and the read state.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Conversation:
    is_dm: bool
    # Someone else's times (M24): quiet unread unless it is at level "all" (its own, or times_all).
    others_times: bool
    level: str | None  # "all" | "mentions" | "none"; None = the default
    muted: bool  # an active timed mute
    unread: int
    mentions: int
    # 2026-10-30: my users.times_notification_default is "all": someone else's times without a
    # level of its own counts like one at level "all" (normal unread). Its own level still wins.
    times_all: bool


def is_muted(c: Conversation) -> bool:
    return c.level == "none" or c.muted


def is_quiet(c: Conversation) -> bool:
    if not c.others_times or c.level == "all" or is_muted(c):
        return False
    return not (c.level is None and c.times_all)


def has_unread(c: Conversation) -> bool:
    return c.mentions > 0 if is_muted(c) or is_quiet(c) else c.unread > 0


def badge(c: Conversation) -> int:
    if is_muted(c):
        return c.mentions
    return c.unread if c.is_dm else c.mentions
