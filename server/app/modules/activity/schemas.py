from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel

from app.modules.messages.schemas import MessageOut

ActivityKind = Literal["mention", "reaction", "thread_reply"]
ActivityFilter = Literal["all", "mentions", "reactions", "threads"]


class ActivityItem(BaseModel):
    kind: ActivityKind
    # When it happened: the message's time, or a reaction's (the newest on that message).
    at: datetime
    # The message mentioning me, my message reacted to, or the reply.
    message: MessageOut
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
