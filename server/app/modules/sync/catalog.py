"""Catalog of WebSocket events for ``openapi/ws-events.json`` (SYNC_PROTOCOL.md §6)."""

from typing import Any

from pydantic import BaseModel, TypeAdapter

from app.modules.auth import events as auth_events
from app.modules.bookmarks import events as bookmark_events
from app.modules.channels import events as channel_events
from app.modules.emoji import events as emoji_events
from app.modules.favorites import events as favorite_events
from app.modules.messages import events as message_events
from app.modules.notifications import events as notification_events
from app.modules.reads import events as read_events
from app.modules.reminders import events as reminder_events
from app.modules.scheduled import events as scheduled_events
from app.modules.threads import events as thread_events
from app.modules.users import events as user_events
from app.realtime.protocol import (
    CLOSE_AUTH_FAILED,
    CLOSE_RECONNECT,
    CLOSE_SESSION_REVOKED,
    ClientFrame,
    ServerFrame,
)

EVENT_CATALOG: dict[str, tuple[type[BaseModel], str, bool]] = {
    # event name: (data model, audience, consumes a channel seq)
    message_events.MESSAGE_CREATED: (message_events.MessageCreatedData, "channel", True),
    message_events.MESSAGE_UPDATED: (message_events.MessageUpdatedData, "channel", True),
    message_events.MESSAGE_DELETED: (message_events.MessageDeletedData, "channel", True),
    channel_events.CHANNEL_CREATED: (
        channel_events.ChannelEventData,
        "channel (public: all)",
        False,
    ),
    channel_events.CHANNEL_UPDATED: (channel_events.ChannelEventData, "channel", False),
    channel_events.CHANNEL_ARCHIVED: (channel_events.ChannelArchivedData, "channel", False),
    channel_events.CHANNEL_MEMBER_ADDED: (channel_events.ChannelMemberData, "channel", False),
    channel_events.CHANNEL_MEMBER_REMOVED: (
        channel_events.ChannelMemberData,
        "channel + user",
        False,
    ),
    user_events.USER_CREATED: (user_events.UserEventData, "all", False),
    user_events.USER_UPDATED: (user_events.UserEventData, "all", False),
    user_events.USER_DEACTIVATED: (user_events.UserEventData, "all", False),
    auth_events.SESSION_REVOKED: (auth_events.SessionRevokedData, "session", False),
    read_events.READ_UPDATED: (read_events.ReadUpdatedData, "user", False),
    thread_events.THREAD_UPDATED: (thread_events.ThreadUpdatedData, "user", False),
    bookmark_events.BOOKMARK_UPDATED: (bookmark_events.BookmarkUpdatedData, "user", False),
    favorite_events.FAVORITE_UPDATED: (favorite_events.FavoriteUpdatedData, "user", False),
    scheduled_events.SCHEDULED_UPDATED: (scheduled_events.ScheduledUpdatedData, "user", False),
    reminder_events.REMINDER_UPDATED: (reminder_events.ReminderUpdatedData, "user", False),
    emoji_events.EMOJI_UPDATED: (emoji_events.EmojiUpdatedData, "all", False),
    notification_events.NOTIFICATION_PREFERENCE_UPDATED: (
        notification_events.NotificationPreferenceUpdatedData,
        "user",
        False,
    ),
}


def ws_events_document() -> dict[str, Any]:
    return {
        "frames": {
            "client": TypeAdapter(ClientFrame).json_schema(mode="validation"),
            "server": TypeAdapter(ServerFrame).json_schema(mode="serialization"),
        },
        "events": {
            name: {
                "audience": audience,
                "consumes_seq": consumes_seq,
                "data": model.model_json_schema(mode="serialization"),
            }
            for name, (model, audience, consumes_seq) in EVENT_CATALOG.items()
        },
        "close_codes": {
            "reconnect": CLOSE_RECONNECT,
            "auth_failed": CLOSE_AUTH_FAILED,
            "session_revoked": CLOSE_SESSION_REVOKED,
        },
    }
