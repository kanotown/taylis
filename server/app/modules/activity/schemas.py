from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel

from app.modules.messages.schemas import MessageOut

ActivityKind = Literal["mention", "reaction", "thread_reply", "canvas_mention"]
ActivityFilter = Literal["all", "mentions", "reactions", "threads"]
# M76 (CANVAS.md §20): canvas_mention items only go to clients that name the kind in `include`
# (clients before them cannot read an item without `message`). Unknown `include` values are
# ignored, so a newer client may name kinds an older server does not have.


class ActivityCanvas(BaseModel):
    """A canvas_mention item's canvas (M76): it opens the canvas in its conversation."""

    # The item itself (one per canvas while unread; a later mention moves it).
    item_id: UUID
    canvas_id: UUID
    channel_id: UUID
    # The canvas's title now.
    title: str
    # The line around the mention as one plain line (mentions as names), at most 200 characters.
    excerpt: str
    # The version that added the (latest) mention.
    rev_id: UUID


class ActivityItem(BaseModel):
    kind: ActivityKind
    # When it happened: the message's time, a reaction's (the newest on that message), or the
    # canvas save's.
    at: datetime
    # The message mentioning me, my message reacted to, or the reply; null for canvas_mention.
    message: MessageOut | None = None
    # canvas_mention only (M76): the canvas and the excerpt.
    canvas: ActivityCanvas | None = None
    # Who did it: the sender, or everyone who reacted (not me).
    actor_ids: list[UUID]
    # A reaction item's emoji (the distinct ones on my message by others).
    emojis: list[str] = []


class ActivityListOut(BaseModel):
    items: list[ActivityItem]
    # The oldest item's time: the next page's `cursor`; null at the end.
    next_cursor: datetime | None
    read_at: datetime


class ActivitySummaryOut(BaseModel):
    read_at: datetime
    # Items after read_at (at most 99), and whether one of them is a mention (the badge turns red).
    unread_count: int
    mention_unread: bool


class ActivityReadIn(BaseModel):
    read_at: datetime


class ActivityReadData(BaseModel):
    read_at: datetime


class ReactionAddedData(BaseModel):
    """To the message's author: someone reacted to it (the activity badge; a push if they asked for
    one)."""

    channel_id: UUID
    message_id: UUID
    user_id: UUID
    emoji: str
    at: datetime
