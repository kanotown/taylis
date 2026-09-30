from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

NotificationLevel = Literal["all", "mentions", "none"]


class NotificationPreferenceIn(BaseModel):
    # null = the person's overall setting (M35).
    level: NotificationLevel | None
    muted_until: datetime | None = None
    # M35: muted until unmuted; omitted = unchanged.
    muted: bool | None = None


class NotificationPreferenceOut(BaseModel):
    channel_id: UUID
    # What the channel notifies of now (its own level, else the overall setting: §4).
    level: NotificationLevel
    muted_until: datetime | None
    # M35: the level is the overall setting's (the channel has none of its own).
    follows_default: bool = True
    muted: bool = False


class PushPayload(BaseModel):
    """Provider-independent notification content stored in push_deliveries.payload (§5)."""

    kind: Literal["message", "reminder", "reaction", "calendar", "test"] = "message"
    # Which deployment sent it (WORKSPACES.md §5): the app opens that workspace on a tap.
    workspace_id: UUID | None = None
    channel_id: UUID | None = None
    message_id: UUID | None = None
    # kind calendar (M51): the event whose alarm this is.
    event_id: UUID | None = None
    seq: int | None = None
    title: str = Field(max_length=120)
    subtitle: str | None = Field(default=None, max_length=120)
    body: str = Field(max_length=240)
    badge: int = 1
    collapse_key: str | None = None
    sent_at: datetime
