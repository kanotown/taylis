from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

NotificationLevel = Literal["all", "mentions", "none"]


class NotificationPreferenceIn(BaseModel):
    level: NotificationLevel
    muted_until: datetime | None = None


class NotificationPreferenceOut(BaseModel):
    channel_id: UUID
    level: NotificationLevel
    muted_until: datetime | None


class PushPayload(BaseModel):
    """Provider-independent notification content stored in push_deliveries.payload (§5)."""

    kind: Literal["message", "reminder", "test"] = "message"
    channel_id: UUID | None = None
    message_id: UUID | None = None
    seq: int | None = None
    title: str = Field(max_length=120)
    subtitle: str | None = Field(default=None, max_length=120)
    body: str = Field(max_length=240)
    badge: int = 1
    collapse_key: str | None = None
    sent_at: datetime
