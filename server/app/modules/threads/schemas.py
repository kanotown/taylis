from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.modules.messages.schemas import MessageOut


class ThreadState(BaseModel):
    """One user's view of one thread (THREADS.md §3)."""

    parent_id: UUID
    channel_id: UUID
    following: bool
    last_read_seq: int
    unread_count: int
    mention_count: int
    reply_count: int
    last_reply_at: datetime | None
    # Current followers (THREADS.md §3): who gets thread.updated and the reply's push.
    participant_ids: list[UUID] = []


class ThreadItem(BaseModel):
    parent: MessageOut
    state: ThreadState


class ThreadSummary(BaseModel):
    """Followed threads with unread replies / unread mentions (sidebar badge, bootstrap)."""

    unread_count: int
    mention_count: int


class ThreadListOut(BaseModel):
    items: list[ThreadItem]
    # last_reply_at of the last item; pass it back as `cursor` for the next page (null: no more).
    next_cursor: datetime | None
    summary: ThreadSummary


class ThreadRead(BaseModel):
    last_read_seq: int = Field(ge=0)


class ThreadFollowIn(BaseModel):
    following: bool


class ThreadUpdatedData(ThreadState):
    reason: Literal["reply", "deleted", "read", "follow"]
