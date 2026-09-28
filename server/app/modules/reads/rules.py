"""Whether a conversation counts as unread and its badge number (SYNC_PROTOCOL.md §10.5).

The same rule runs in the three clients; apps/shared/unread-rules.json holds the vectors every
implementation is tested against. Plain values in, plain values out: callers look up the channel,
the notification preference and the read state.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Conversation:
    is_dm: bool
    # Someone else's times (M24) that I have not set to level "all": quiet unread.
    others_times: bool
    level: str | None  # "all" | "mentions" | "none"; None = the default
    muted: bool  # an active timed mute
    unread: int
    mentions: int


def is_muted(c: Conversation) -> bool:
    return c.level == "none" or c.muted


def is_quiet(c: Conversation) -> bool:
    return c.others_times and c.level != "all" and not is_muted(c)


def has_unread(c: Conversation) -> bool:
    return c.mentions > 0 if is_muted(c) or is_quiet(c) else c.unread > 0


def badge(c: Conversation) -> int:
    if is_muted(c):
        return c.mentions
    return c.unread if c.is_dm else c.mentions
