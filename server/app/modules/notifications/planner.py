"""PushPlanner: an outbox handler that turns message.created into push_deliveries (§4)."""

import logging
import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.events.envelope import Audience
from app.events.models import OutboxEvent
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.messages.events import MESSAGE_CREATED
from app.modules.notifications import repository as repo
from app.modules.notifications.schemas import PushPayload
from app.modules.notifications.service import default_level
from app.modules.users import service as users
from app.modules.users.models import User

log = logging.getLogger("app.push")


class PushPlanner:
    def __init__(self, settings: Settings, is_active: Callable[[uuid.UUID], bool]) -> None:
        self.settings = settings
        self.is_active = is_active

    async def handle(self, db: AsyncSession, event: OutboxEvent, audience: Audience) -> None:
        if (
            event.event_type != MESSAGE_CREATED
            or audience.kind != "users"
            or event.channel_id is None
        ):
            return
        message = event.payload.get("message") or {}
        sender_id = uuid.UUID(str(message["sender_id"]))
        recipients = [uid for uid in audience.ids if uid != sender_id]
        if not recipients:
            return
        channel = await channels.require_channel(db, event.channel_id)
        targets = await self.select_recipients(db, channel, recipients, message)
        if not targets:
            return
        devices = await repo.push_devices_for_users(db, targets)
        if not devices:
            return
        sender = await users.get_user(db, sender_id)
        payload = self.build_payload(channel, sender, message, event.seq)
        expires_at = utcnow() + timedelta(seconds=self.settings.push_alert_ttl_seconds)
        planned = 0
        for device in devices:
            if await repo.add_delivery(
                db,
                event_id=event.id,
                device=device,
                kind="alert",
                collapse_key=str(channel.id),
                channel_id=channel.id,
                message_id=uuid.UUID(str(message["id"])),
                message_seq=event.seq,
                payload=payload.model_dump(mode="json") | {"expires_at": expires_at.isoformat()},
                expires_at=expires_at,
            ):
                planned += 1
        log.info("planned %d push deliveries for event %s", planned, event.id)

    async def select_recipients(
        self,
        db: AsyncSession,
        channel: Channel,
        recipients: list[uuid.UUID],
        message: dict[str, Any] | None = None,
    ) -> list[uuid.UUID]:
        """The rules of PUSH_NOTIFICATIONS.md §4 (the read check arrives with M8b)."""
        now = utcnow()
        prefs = await repo.preferences_for_channel(db, channel.id, recipients)
        default = default_level(channel)
        mentioned = {uuid.UUID(str(uid)) for uid in (message or {}).get("mentioned_user_ids", [])}
        mention_all = bool((message or {}).get("mention_all"))
        targets: list[uuid.UUID] = []
        for user_id in recipients:
            pref = prefs.get(user_id)
            level = pref.level if pref else default
            if level == "none":
                continue
            if pref is not None and pref.muted_until is not None and pref.muted_until > now:
                continue
            if level == "mentions" and not (mention_all or user_id in mentioned):
                continue
            if self.is_active(user_id):
                continue  # the user is looking at another device right now (§4.1)
            targets.append(user_id)
        return targets

    def build_payload(
        self, channel: Channel, sender: User | None, message: dict[str, object], seq: int | None
    ) -> PushPayload:
        sender_name = sender.display_name if sender else "Someone"
        if channel.type == "dm":
            title, subtitle = sender_name, None
        elif channel.type == "group_dm":
            title, subtitle = "グループ DM", sender_name
        else:
            title, subtitle = f"#{channel.name}", sender_name
        body = (
            str(message.get("body", ""))[:200]
            if self.settings.push_include_content
            else "新しいメッセージ"
        )
        return PushPayload(
            kind="message",
            channel_id=channel.id,
            message_id=uuid.UUID(str(message["id"])),
            seq=seq,
            title=title,
            subtitle=subtitle,
            body=body or "新しいメッセージ",
            badge=1,  # M8b: unread DMs + mentions
            collapse_key=str(channel.id),
            sent_at=utcnow(),
        )
