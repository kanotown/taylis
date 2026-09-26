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
from app.modules.messages.mentions import notification_text
from app.modules.notifications import repository as repo
from app.modules.notifications.schemas import PushPayload
from app.modules.notifications.service import default_level
from app.modules.reads import service as reads
from app.modules.users import service as users
from app.modules.users.dnd import dnd_active
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
        thread = event.payload.get("parent_thread") or {}
        participants = {uuid.UUID(str(uid)) for uid in thread.get("participant_ids", [])}
        targets = await self.select_recipients(db, channel, recipients, message, participants)
        if not targets:
            return
        devices = await repo.push_devices_for_users(db, targets)
        if not devices:
            return
        sender = await users.get_user(db, sender_id)
        # Display names for the mentioned users, so the notification text never shows raw ids.
        names: dict[uuid.UUID, str] = {}
        for raw in message.get("mentioned_user_ids", []) or []:
            mentioned_user = await users.get_user(db, uuid.UUID(str(raw)))
            if mentioned_user is not None:
                names[mentioned_user.id] = mentioned_user.display_name
        expires_at = utcnow() + timedelta(seconds=self.settings.push_alert_ttl_seconds)
        planned = 0
        payloads: dict[uuid.UUID, dict[str, Any]] = {}
        for device in devices:
            if device.user_id not in payloads:
                badge = await self.badge_for(db, device.user_id)
                payload = self.build_payload(
                    channel, sender, message, event.seq, badge=badge, names=names
                )
                payloads[device.user_id] = payload.model_dump(mode="json") | {
                    "expires_at": expires_at.isoformat()
                }
            if await repo.add_delivery(
                db,
                event_id=event.id,
                device=device,
                kind="alert",
                collapse_key=str(channel.id),
                channel_id=channel.id,
                message_id=uuid.UUID(str(message["id"])),
                message_seq=event.seq,
                payload=payloads[device.user_id],
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
        participants: set[uuid.UUID] | None = None,
    ) -> list[uuid.UUID]:
        """PUSH_NOTIFICATIONS.md §4; ``participants`` are the thread's author and repliers."""
        now = utcnow()
        prefs = await repo.preferences_for_channel(db, channel.id, recipients)
        default = default_level(channel)
        mentioned = {uuid.UUID(str(uid)) for uid in (message or {}).get("mentioned_user_ids", [])}
        mention_all = bool((message or {}).get("mention_all"))
        seq = (message or {}).get("seq")
        positions = await reads.last_read_seqs(db, recipients, channel.id)
        rows = await users.get_users(db, recipients)
        targets: list[uuid.UUID] = []
        for user_id in recipients:
            pref = prefs.get(user_id)
            level = pref.level if pref else default
            if level == "none":
                continue
            if pref is not None and pref.muted_until is not None and pref.muted_until > now:
                continue
            user = rows.get(user_id)
            if user is not None and dnd_active(user, now):
                continue  # paused / quiet hours (M12c); the badge catches up with the next push
            involved = mention_all or user_id in mentioned or user_id in (participants or set())
            if level == "mentions" and not involved:
                continue
            if seq is not None and positions.get(user_id, 0) >= int(seq):
                continue  # already read on another device (§4)
            if self.is_active(user_id):
                continue  # the user is looking at another device right now (§4.1)
            targets.append(user_id)
        return targets

    async def badge_for(self, db: AsyncSession, user_id: uuid.UUID) -> int:
        """Unread DMs + channel mentions (PUSH_NOTIFICATIONS.md §4.2); an approximation is fine."""
        user = await users.get_user(db, user_id)
        if user is None:
            return 1
        listed = await channels.list_channels(db, user, include_public=False)
        states = await reads.states_for_user(db, user_id, [c.id for c in listed])
        badge = 0
        for c in listed:
            state = states.get(c.id)
            if state is None:
                continue
            badge += state.unread_count if c.type in ("dm", "group_dm") else state.mention_count
        return badge

    def build_payload(
        self,
        channel: Channel,
        sender: User | None,
        message: dict[str, object],
        seq: int | None,
        *,
        badge: int = 1,
        names: dict[uuid.UUID, str] | None = None,
    ) -> PushPayload:
        sender_name = sender.display_name if sender else "Someone"
        if channel.type == "dm":
            title, subtitle = sender_name, None
        elif channel.type == "group_dm":
            title, subtitle = "グループ DM", sender_name
        else:
            title, subtitle = f"#{channel.name}", sender_name
        body = (
            notification_text(str(message.get("body", "")), names or {})
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
            badge=max(badge, 1),
            collapse_key=str(channel.id),
            sent_at=utcnow(),
        )
