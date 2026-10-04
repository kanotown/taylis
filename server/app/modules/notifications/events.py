"""Events emitted by the notifications module."""

from pydantic import BaseModel

from app.modules.notifications.schemas import NotificationPreferenceOut

NOTIFICATION_PREFERENCE_UPDATED = "notification_preference.updated"
# POST /users/me/test-notification (PUSH_NOTIFICATIONS.md §15): my open apps show it themselves.
NOTIFICATION_TEST = "notification.test"


class NotificationPreferenceUpdatedData(BaseModel):
    channel_id: str
    level: str
    muted_until: str | None
    follows_default: bool = True
    muted: bool = False


class NotificationTestData(BaseModel):
    title: str
    body: str
    # The device that pressed the button: it has already shown its own notification.
    device_id: str | None
    sent_at: str


__all__ = [
    "NOTIFICATION_PREFERENCE_UPDATED",
    "NOTIFICATION_TEST",
    "NotificationPreferenceOut",
    "NotificationPreferenceUpdatedData",
    "NotificationTestData",
]
