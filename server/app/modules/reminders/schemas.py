from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, Field


class ReminderCreate(BaseModel):
    remind_at: AwareDatetime
    note: str | None = Field(default=None, max_length=200)


class ReminderOut(BaseModel):
    id: UUID
    message_id: UUID
    channel_id: UUID
    note: str | None
    # The message text when the reminder was set (the message may change or vanish later).
    preview: str
    remind_at: datetime
    status: Literal["pending", "fired", "done", "cancelled"]
    fired_at: datetime | None
    created_at: datetime
    # L4: "ack" when the message's author asked me to acknowledge it. L6: "collect" when a
    # recurring post's collection is past due and I have not replied in its thread.
    kind: Literal["personal", "ack", "collect"] = "personal"


class AckRemindOut(BaseModel):
    """L4: how many members were reminded (those already reminded and still open are skipped)."""

    reminded: int


class ReminderUpdatedData(BaseModel):
    reminder: ReminderOut
