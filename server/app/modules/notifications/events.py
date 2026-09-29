"""Events emitted by the notifications module."""

from pydantic import BaseModel

from app.modules.notifications.schemas import NotificationPreferenceOut

NOTIFICATION_PREFERENCE_UPDATED = "notification_preference.updated"


class NotificationPreferenceUpdatedData(BaseModel):
    channel_id: str
    level: str
    muted_until: str | None
    follows_default: bool = True
    muted: bool = False


__all__ = [
    "NOTIFICATION_PREFERENCE_UPDATED",
    "NotificationPreferenceOut",
    "NotificationPreferenceUpdatedData",
]
