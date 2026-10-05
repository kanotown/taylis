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

    kind: Literal[
        "message", "reminder", "reaction", "calendar", "task", "canvas", "reservation", "test"
    ] = "message"
    # Which deployment sent it (WORKSPACES.md §5): the app opens that workspace on a tap.
    workspace_id: UUID | None = None
    channel_id: UUID | None = None
    message_id: UUID | None = None
    # kind calendar (M51): the event whose alarm this is.
    event_id: UUID | None = None
    # kind task (M55): the task assigned to me or due today.
    task_id: UUID | None = None
    # kind canvas (M72): the canvas that mentions me.
    canvas_id: UUID | None = None
    # kind reservation (M112): the pool the notice is about (opens the reservations page).
    pool_id: UUID | None = None
    seq: int | None = None
    title: str = Field(max_length=120)
    subtitle: str | None = Field(default=None, max_length=120)
    body: str = Field(max_length=240)
    badge: int = 1
    collapse_key: str | None = None
    sent_at: datetime


# POST /users/me/test-notification (PUSH_NOTIFICATIONS.md §15).
TestNotificationStatus = Literal[
    "sent",  # the provider accepted it (APNs / FCM)
    "failed",  # the provider refused or could not be reached: see detail
    "no_token",  # a phone that has not registered for push (OS permission off, or not yet)
    "not_configured",  # this server's APNs / FCM is off: the push only went to the log
    "in_app",  # desktop / web: no push; the open app shows it from notification.test
    "disabled",  # logged out, or every session ran out
]


class TestNotificationDevice(BaseModel):
    __test__ = False  # not a pytest class

    device_id: UUID
    device_name: str | None
    platform: str
    push_provider: str
    # The device that pressed the button.
    current: bool
    status: TestNotificationStatus
    # failed: the provider's reason; disabled: why (logout, session_expired, revoked...).
    detail: str | None = None
    last_seen_at: datetime | None = None


class TestNotificationOut(BaseModel):
    __test__ = False  # not a pytest class

    # Whether this server sends to APNs / FCM at all (PUSH_APNS_ENABLED / PUSH_FCM_ENABLED).
    apns_configured: bool
    fcm_configured: bool
    # Do not disturb / quiet hours were on: the test was sent anyway (it ignores DND).
    dnd_active: bool
    sent_count: int
    devices: list[TestNotificationDevice]
