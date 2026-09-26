from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class ReminderCreate(BaseModel):
    remind_at: datetime
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


class ReminderUpdatedData(BaseModel):
    reminder: ReminderOut
