"""PushPlanner: an outbox handler that turns message.created into push_deliveries (§4)."""

import logging
import re
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from app import i18n
from app.core.settings import Settings
from app.core.time import utcnow
from app.events.envelope import Audience
from app.events.models import OutboxEvent
from app.modules.activity.events import REACTION_ADDED
from app.modules.calendar import service as calendar
from app.modules.calendar.events import CALENDAR_ALARM_UPDATED
from app.modules.canvases import repository as canvases_repo
from app.modules.canvases.events import CANVAS_MENTIONED
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.emoji import repository as emoji_repo
from app.modules.groups import service as groups
from app.modules.messages import repository as messages_repo
from app.modules.messages import service as messages
from app.modules.messages.events import MESSAGE_CREATED
from app.modules.messages.mentions import attachment_text, extract_group_mentions, notification_text
from app.modules.moderation import blocks
from app.modules.notifications import repository as repo
from app.modules.notifications.schemas import PushPayload
from app.modules.notifications.service import is_muted, push_level
from app.modules.reads import rules as unread_rules
from app.modules.reads import service as reads
from app.modules.reminders import service as reminders
from app.modules.reminders.events import REMINDER_UPDATED
from app.modules.reservations import access as reservation_access
from app.modules.reservations.events import RESERVATION_NOTICE
from app.modules.reservations.models import ReservationNotice
from app.modules.tasks import service as tasks
from app.modules.tasks.events import TASK_ASSIGNED, TASK_DUE, TASK_REVIEW_DONE
from app.modules.threads import service as threads
from app.modules.users import service as users
from app.modules.users.dnd import dnd_active
from app.modules.users.models import User
from app.modules.workspace import service as workspace

# A fired reminder's push title by kind (L4 ack, L6 collect); a personal one is リマインダー.
REMINDER_TITLES = {"ack": "push.reminder.title_ack", "collect": "push.reminder.title_collect"}

log = logging.getLogger("app.push")

# A reaction that is a workspace emoji: exactly `:name:` (the clients' customEmojiName).
CUSTOM_EMOJI_REACTION = re.compile(r"^:([a-z0-9][a-z0-9_+-]{1,31}):$")


def reaction_text(emoji: str, label: str | None) -> str:
    """How a reaction reads in a push (a banner cannot draw the image): a workspace emoji with a
    label (a text emoji, or a pack emoji the manifest named) as 【label】 rather than its
    `:name:` (2026-10-05: 「:ckw-yay:」); a standard one, or one without a label, as it is."""
    label = (label or "").strip()
    return f"【{label}】" if label and CUSTOM_EMOJI_REACTION.match(emoji) else emoji


class _ByLocale:
    """M115 (docs/I18N.md): one payload per language among a person's devices, built once."""

    def __init__(self, build: Callable[[str], dict[str, Any]]) -> None:
        self.build = build
        self.made: dict[str, dict[str, Any]] = {}

    def __call__(self, locale: str) -> dict[str, Any]:
        if locale not in self.made:
            self.made[locale] = self.build(locale)
        return self.made[locale]


class PushPlanner:
    def __init__(self, settings: Settings, is_active: Callable[[uuid.UUID], bool]) -> None:
        self.settings = settings
        self.is_active = is_active

    async def handle(self, db: AsyncSession, event: OutboxEvent, audience: Audience) -> None:
        if event.event_type == REMINDER_UPDATED:
            await self.handle_reminder(db, event)
            return
        if event.event_type == REACTION_ADDED:
            await self.handle_reaction(db, event)
            return
        if event.event_type == CALENDAR_ALARM_UPDATED:
            await self.handle_calendar(db, event)
            return
        if event.event_type in (TASK_ASSIGNED, TASK_DUE, TASK_REVIEW_DONE):
            await self.handle_task(db, event)
            return
        if event.event_type == CANVAS_MENTIONED:
            await self.handle_canvas_mention(db, event)
            return
        if event.event_type == RESERVATION_NOTICE:
            await self.handle_reservation(db, event)
            return
        if (
            event.event_type != MESSAGE_CREATED
            or audience.kind != "users"
            or event.channel_id is None
        ):
            return
        message = event.payload.get("message") or {}
        if message.get("type", "user") != "user":
            return  # M88: a join / leave line is never pushed (docs/MEMBERSHIP.md §1)
        sender_id = uuid.UUID(str(message["sender_id"]))
        recipients = [uid for uid in audience.ids if uid != sender_id]
        # M104 (docs/MODERATION.md §4): nothing from someone the recipient blocked.
        blockers = await blocks.blockers_among(db, sender_id, recipients)
        recipients = [uid for uid in recipients if uid not in blockers]
        if not recipients:
            return
        channel = await channels.require_channel(db, event.channel_id)
        thread = event.payload.get("parent_thread") or {}
        participants = {uuid.UUID(str(uid)) for uid in thread.get("participant_ids", [])}
        # A reply also sent to the channel is a channel message; any other reply is read (and
        # muted) by its thread.
        parent_id = None
        if thread and not message.get("also_in_channel"):
            parent_id = uuid.UUID(str(thread["id"]))
            # A reply in a thread the user unfollowed stays silent whatever the channel level
            # (THREADS.md §4).
            muted = set(await threads.unfollowed(db, parent_id))
            recipients = [uid for uid in recipients if uid not in muted]
        targets = await self.select_recipients(
            db, channel, recipients, message, participants, parent_id=parent_id
        )
        if not targets:
            return
        devices = await repo.push_devices_for_users(db, targets)
        if not devices:
            return
        sender = await users.get_user(db, sender_id)
        people = await users.get_users(db, list({d.user_id for d in devices}))
        # Display names for the mentioned users, so the notification text never shows raw ids.
        names: dict[uuid.UUID, str] = {}
        for raw in message.get("mentioned_user_ids", []) or []:
            mentioned_user = await users.get_user(db, uuid.UUID(str(raw)))
            if mentioned_user is not None:
                names[mentioned_user.id] = mentioned_user.display_name
        names.update(await groups.names_for(db, extract_group_mentions(message.get("body") or "")))
        expires_at = utcnow() + timedelta(seconds=self.settings.push_alert_ttl_seconds)
        workspace_id = await workspace.workspace_id(db)
        planned = 0
        payloads: dict[tuple[uuid.UUID, str], dict[str, Any]] = {}
        badges: dict[uuid.UUID, int] = {}
        for device in devices:
            locale = i18n.device_locale(people.get(device.user_id), device)
            key = (device.user_id, locale)
            if key not in payloads:
                if device.user_id not in badges:
                    badges[device.user_id] = await self.badge_for(db, device.user_id)
                payload = self.build_payload(
                    channel,
                    sender,
                    message,
                    event.seq,
                    badge=badges[device.user_id],
                    names=names,
                    workspace_id=workspace_id,
                    locale=locale,
                )
                # parent_id is for the sender's last check (a reply is read by its thread's
                # position), kept beside the payload like expires_at.
                payloads[key] = payload.model_dump(mode="json") | {
                    "expires_at": expires_at.isoformat(),
                    "parent_id": str(parent_id) if parent_id is not None else None,
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
                payload=payloads[key],
                expires_at=expires_at,
            ):
                planned += 1
        log.info("planned %d push deliveries for event %s", planned, event.id)

    async def handle_reminder(self, db: AsyncSession, event: OutboxEvent) -> None:
        """A fired reminder (M12e) nudges its owner's devices; DND is honoured like any push."""
        reminder = event.payload.get("reminder") or {}
        if reminder.get("status") != "fired":
            return
        user_id = uuid.UUID(str(event.audience_id))
        user = await users.get_user(db, user_id)
        if user is None or dnd_active(user, utcnow()):
            return
        devices = await repo.push_devices_for_users(db, [user_id])
        if not devices:
            return
        note = (reminder.get("note") or "").strip()
        preview = str(reminder.get("preview") or "")
        body = f"{note} — {preview}" if note else preview
        expires_at = utcnow() + timedelta(seconds=self.settings.push_alert_ttl_seconds)
        channel_id = uuid.UUID(str(reminder["channel_id"]))
        message_id = uuid.UUID(str(reminder["message_id"]))
        workspace_id = await workspace.workspace_id(db)
        badge = max(await self.badge_for(db, user_id), 1)

        def build(lc: str) -> dict[str, Any]:
            hidden = i18n.t("push.reminder.hidden", lc)
            return PushPayload(
                kind="reminder",
                workspace_id=workspace_id,
                channel_id=channel_id,
                message_id=message_id,
                seq=None,
                # L4: a request from the author to acknowledge reads as such.
                # L6: a nudge to submit to a collection reads as such too.
                title=i18n.t(
                    REMINDER_TITLES.get(str(reminder.get("kind")), "push.reminder.title"), lc
                ),
                subtitle=None,
                body=(body if self.settings.push_include_content else hidden)[:240] or hidden,
                badge=badge,
                collapse_key=f"reminder:{reminder.get('id')}",
                sent_at=utcnow(),
            ).model_dump(mode="json") | {"expires_at": expires_at.isoformat()}

        payloads = _ByLocale(build)
        for device in devices:
            payload = payloads(i18n.device_locale(user, device))
            await repo.add_delivery(
                db,
                event_id=event.id,
                device=device,
                kind="alert",
                collapse_key=str(payload["collapse_key"]),
                channel_id=channel_id,
                message_id=message_id,
                message_seq=None,
                payload=payload,
                expires_at=expires_at,
            )

    async def handle_calendar(self, db: AsyncSession, event: OutboxEvent) -> None:
        """A fired calendar alarm (M51, CALENDAR.md §6) on its owner's devices; DND is honoured
        like a reminder's. The text is read live (the event may have changed since)."""
        alarm = event.payload.get("alarm") or {}
        if alarm.get("status") != "fired":
            return
        user_id = uuid.UUID(str(event.audience_id))
        user = await users.get_user(db, user_id)
        now = utcnow()
        if user is None or dnd_active(user, now):
            return
        fired_at = alarm.get("fire_at")
        notice = await calendar.alarm_notice(
            db,
            uuid.UUID(str(event.payload["event_id"])),
            user_id,
            occurrence_start=alarm.get("occurrence_start"),
            fire_at=datetime.fromisoformat(str(fired_at)) if fired_at else None,
        )
        if notice is None:
            return
        devices = await repo.push_devices_for_users(db, [user_id])
        if not devices:
            return
        expires_at = now + timedelta(seconds=self.settings.push_alert_ttl_seconds)
        workspace_id = await workspace.workspace_id(db)
        badge = max(await self.badge_for(db, user_id), 1)

        def build(lc: str) -> dict[str, Any]:
            hidden = i18n.t("push.calendar.hidden", lc)
            return PushPayload(
                kind="calendar",
                workspace_id=workspace_id,
                channel_id=notice.channel_id,
                event_id=notice.event_id,
                seq=None,
                title=i18n.t("push.calendar.title", lc),
                subtitle=None,
                body=(notice.text(lc) if self.settings.push_include_content else hidden)[:240],
                badge=badge,
                collapse_key=f"calendar:{notice.event_id}",
                sent_at=now,
            ).model_dump(mode="json") | {"expires_at": expires_at.isoformat()}

        payloads = _ByLocale(build)
        for device in devices:
            payload = payloads(i18n.device_locale(user, device))
            await repo.add_delivery(
                db,
                event_id=event.id,
                device=device,
                kind="alert",
                collapse_key=str(payload["collapse_key"]),
                channel_id=notice.channel_id,
                message_id=None,
                message_seq=None,
                payload=payload,
                expires_at=expires_at,
            )

    async def handle_task(self, db: AsyncSession, event: OutboxEvent) -> None:
        """M55 (TASKS.md §5): someone assigned me a task, or one of mine is due today. Only with
        task notifications on (notify_tasks) and not during DND. An assignment is also held back
        like a reaction: not in a conversation muted or set to nothing, not while I am on another
        device, not for a task deleted or completed since. A due date is a reminder: it goes out
        whatever the channel's level (like the calendar's alarms)."""
        data = event.payload
        user_id = uuid.UUID(str(event.audience_id))
        user = await users.get_user(db, user_id)
        now = utcnow()
        if user is None or not user.notify_tasks or dnd_active(user, now):
            return
        task_id = uuid.UUID(str(data["task_id"]))
        channel_id = uuid.UUID(str(data["channel_id"])) if data.get("channel_id") else None
        title = str(data.get("title") or "")
        where = f" (#{data['channel_name']})" if data.get("channel_name") else ""
        if event.event_type in (TASK_ASSIGNED, TASK_REVIEW_DONE):
            if self.is_active(user_id) or channel_id is None:
                return
            if await channels.membership_of(db, user_id, channel_id) is None:
                return
            if event.event_type == TASK_ASSIGNED and not await tasks.still_open(db, task_id):
                return
            channel = await channels.require_channel(db, channel_id)
            pref = (await repo.preferences_for_channel(db, channel_id, [user_id])).get(user_id)
            level = push_level(
                pref.level if pref else None,
                is_dm=channel.is_dm,
                others_times=channel.times_owner_id is not None
                and channel.times_owner_id != user_id,
                overall=user.notification_default,
            )
            if level == "none" or is_muted(pref, now):
                return
            actor = await users.get_user(db, uuid.UUID(str(data["by_user_id"])))
            who = actor.display_name if actor else None
            if event.event_type == TASK_REVIEW_DONE:  # L9 (REVIEWS.md §4)
                key = "push.task.review_done"
            elif data.get("kind") == "review":
                key = "push.task.review_requested"
            else:
                key = "push.task.assigned"
            params: dict[str, object] = {"title": title, "where": where}
        elif data.get("due_at"):
            # M81 (TASKS.md §11): a due time — the notification goes out at it.
            zone = str(data.get("tz") or calendar.zone_for(None, user))
            at = datetime.fromisoformat(str(data["due_at"])).astimezone(ZoneInfo(zone))
            key, who = "push.task.due_at", None
            params = {"time": f"{at:%H:%M}", "title": title, "where": where}
        else:
            key, who = "push.task.due_today", None
            params = {"title": title, "where": where}
        devices = await repo.push_devices_for_users(db, [user_id])
        if not devices:
            return
        expires_at = now + timedelta(seconds=self.settings.push_alert_ttl_seconds)
        workspace_id = await workspace.workspace_id(db)
        badge = max(await self.badge_for(db, user_id), 1)

        def build(lc: str) -> dict[str, Any]:
            extra = {"who": who or i18n.t("someone", lc)} if "{who}" in i18n.t(key, "ja") else {}
            body = i18n.t(key, lc, **params, **extra)
            return PushPayload(
                kind="task",
                workspace_id=workspace_id,
                channel_id=channel_id,
                task_id=task_id,
                seq=None,
                title=i18n.t("push.task.title", lc),
                subtitle=None,
                body=(body if self.settings.push_include_content else i18n.t(f"{key}_hidden", lc))[
                    :240
                ],
                badge=badge,
                collapse_key=f"task:{task_id}",
                sent_at=now,
            ).model_dump(mode="json") | {"expires_at": expires_at.isoformat()}

        payloads = _ByLocale(build)
        for device in devices:
            payload = payloads(i18n.device_locale(user, device))
            await repo.add_delivery(
                db,
                event_id=event.id,
                device=device,
                kind="alert",
                collapse_key=str(payload["collapse_key"]),
                channel_id=channel_id,
                message_id=None,
                message_seq=None,
                payload=payload,
                expires_at=expires_at,
            )

    async def handle_canvas_mention(self, db: AsyncSession, event: OutboxEvent) -> None:
        """M72 (CANVAS.md §18.1): a save of a canvas newly mentions me. Held back like a message's
        mention: not in a conversation muted or set to nothing, not during DND, not while I am on
        another device; not for a canvas in the trash since, nor once I left the conversation."""
        data = event.payload
        user_id = uuid.UUID(str(event.audience_id))
        user = await users.get_user(db, user_id)
        now = utcnow()
        if user is None or user.deactivated_at is not None or dnd_active(user, now):
            return
        if self.is_active(user_id):
            return
        by_user = data.get("by_user_id")
        if by_user and await blocks.is_blocked(db, user_id, uuid.UUID(str(by_user))):
            return  # M104: a mention by someone I blocked
        canvas_id = uuid.UUID(str(data["canvas_id"]))
        canvas = await canvases_repo.get(db, canvas_id)
        if canvas is None or canvas.is_deleted:
            return
        channel_id = canvas.channel_id
        if await channels.membership_of(db, user_id, channel_id) is None:
            return
        channel = await channels.require_channel(db, channel_id)
        pref = (await repo.preferences_for_channel(db, channel_id, [user_id])).get(user_id)
        level = push_level(
            pref.level if pref else None,
            is_dm=channel.is_dm,
            others_times=channel.times_owner_id is not None and channel.times_owner_id != user_id,
            overall=user.notification_default,
        )
        if level == "none" or is_muted(pref, now):
            return
        devices = await repo.push_devices_for_users(db, [user_id])
        if not devices:
            return
        actor = await users.get_user(db, uuid.UUID(str(data["by_user_id"])))
        expires_at = now + timedelta(seconds=self.settings.push_alert_ttl_seconds)
        workspace_id = await workspace.workspace_id(db)
        badge = max(await self.badge_for(db, user_id), 1)
        canvas_title = canvas.title

        def build(lc: str) -> dict[str, Any]:
            who = actor.display_name if actor else i18n.t("someone", lc)
            body = i18n.t("push.canvas.mention", lc, who=who, title=canvas_title)
            return PushPayload(
                kind="canvas",
                workspace_id=workspace_id,
                channel_id=channel_id,
                canvas_id=canvas_id,
                seq=None,
                title=i18n.t("push.canvas.title", lc),
                subtitle=None if channel.is_dm else f"#{channel.name}",
                body=(
                    body
                    if self.settings.push_include_content
                    else i18n.t("push.canvas.mention_hidden", lc)
                )[:240],
                badge=badge,
                collapse_key=f"canvas:{canvas_id}",
                sent_at=now,
            ).model_dump(mode="json") | {"expires_at": expires_at.isoformat()}

        payloads = _ByLocale(build)
        for device in devices:
            payload = payloads(i18n.device_locale(user, device))
            await repo.add_delivery(
                db,
                event_id=event.id,
                device=device,
                kind="alert",
                collapse_key=str(payload["collapse_key"]),
                channel_id=channel_id,
                message_id=None,
                message_seq=None,
                payload=payload,
                expires_at=expires_at,
            )

    async def handle_reservation(self, db: AsyncSession, event: OutboxEvent) -> None:
        """M112 (RESERVATIONS.md §5): a reservation notice for me (an operator's to-do, or news
        about my own booking or seat). Not during DND, not while I am on another device (the open
        app shows it); an operator's to-do another operator handled before the push was planned
        is dropped (the item is done)."""
        data = event.payload
        user_id = uuid.UUID(str(event.audience_id))
        user = await users.get_user(db, user_id)
        now = utcnow()
        if user is None or user.deactivated_at is not None or dnd_active(user, now):
            return
        if self.is_active(user_id):
            return
        item = await db.get(ReservationNotice, uuid.UUID(str(data["item_id"])))
        if item is None or item.done_at is not None:
            return
        if not await reservation_access.may_deliver(db, item.id, user_id):
            return  # an operator's to-do for someone who can no longer operate (review v0.1.37 #2)
        devices = await repo.push_devices_for_users(db, [user_id])
        if not devices:
            return
        expires_at = now + timedelta(seconds=self.settings.push_alert_ttl_seconds)
        workspace_id = await workspace.workspace_id(db)
        badge = max(await self.badge_for(db, user_id), 1)

        def build(lc: str) -> dict[str, Any]:
            # The item's text is written in the person's language already (docs/I18N.md).
            hidden = i18n.t("push.reservation.hidden", lc)
            return PushPayload(
                kind="reservation",
                workspace_id=workspace_id,
                pool_id=item.pool_id,
                seq=None,
                title=i18n.t("push.reservation.title", lc),
                subtitle=None,
                body=(item.text if self.settings.push_include_content else hidden)[:240],
                badge=badge,
                collapse_key=f"reservation:{item.id}",
                sent_at=now,
            ).model_dump(mode="json") | {"expires_at": expires_at.isoformat()}

        payloads = _ByLocale(build)
        for device in devices:
            payload = payloads(i18n.device_locale(user, device))
            await repo.add_delivery(
                db,
                event_id=event.id,
                device=device,
                kind="alert",
                collapse_key=str(payload["collapse_key"]),
                channel_id=None,
                message_id=None,
                message_seq=None,
                payload=payload,
                expires_at=expires_at,
            )

    async def handle_reaction(self, db: AsyncSession, event: OutboxEvent) -> None:
        """M39: someone reacted to my message. A push only for those who turned reaction banners on
        (the activity lists it either way), and like any push not in a muted or silent conversation,
        not during DND, not while I am on another device."""
        data = event.payload
        user_id = uuid.UUID(str(event.audience_id))
        user = await users.get_user(db, user_id)
        now = utcnow()
        if user is None or not user.notify_reactions or dnd_active(user, now):
            return
        if self.is_active(user_id):
            return
        if await blocks.is_blocked(db, user_id, uuid.UUID(str(data["user_id"]))):
            return  # M104: a reaction by someone I blocked
        channel_id = uuid.UUID(str(data["channel_id"]))
        message_id = uuid.UUID(str(data["message_id"]))
        channel = await channels.require_channel(db, channel_id)
        if await channels.membership_of(db, user_id, channel_id) is None:
            return
        pref = (await repo.preferences_for_channel(db, channel_id, [user_id])).get(user_id)
        level = push_level(
            pref.level if pref else None,
            is_dm=channel.is_dm,
            others_times=channel.times_owner_id is not None and channel.times_owner_id != user_id,
            overall=user.notification_default,
        )
        if level == "none" or is_muted(pref, now):
            return
        message = await messages_repo.get_message(db, message_id)
        if message is None or message.deleted_at is not None:
            return
        devices = await repo.push_devices_for_users(db, [user_id])
        if not devices:
            return
        actor = await users.get_user(db, uuid.UUID(str(data["user_id"])))
        emoji = str(data.get("emoji") or "")
        if custom := CUSTOM_EMOJI_REACTION.match(emoji):
            row = await emoji_repo.get_by_name(db, custom.group(1))
            emoji = reaction_text(emoji, row.label if row else None)
        excerpt = (
            notification_text(message.body or "", {}) if self.settings.push_include_content else ""
        )
        where = None if channel.is_dm else f"#{channel.name}"
        expires_at = now + timedelta(seconds=self.settings.push_alert_ttl_seconds)
        workspace_id = await workspace.workspace_id(db)
        badge = max(await self.badge_for(db, user_id), 1)

        def build(lc: str) -> dict[str, Any]:
            who = actor.display_name if actor else i18n.t("someone", lc)
            quoted = i18n.t("push.reaction.quote", lc, emoji=emoji, excerpt=excerpt)
            return PushPayload(
                kind="reaction",
                workspace_id=workspace_id,
                channel_id=channel_id,
                message_id=message_id,
                seq=None,
                title=i18n.t("push.reaction.title", lc, who=who),
                subtitle=where,
                body=(quoted if excerpt else emoji)[:240] or i18n.t("push.reaction.fallback", lc),
                badge=badge,
                collapse_key=f"reaction:{message_id}",
                sent_at=now,
            ).model_dump(mode="json") | {"expires_at": expires_at.isoformat()}

        payloads = _ByLocale(build)
        for device in devices:
            payload = payloads(i18n.device_locale(user, device))
            await repo.add_delivery(
                db,
                event_id=event.id,
                device=device,
                kind="alert",
                collapse_key=str(payload["collapse_key"]),
                channel_id=channel_id,
                message_id=message_id,
                message_seq=None,
                payload=payload,
                expires_at=expires_at,
            )

    async def select_recipients(
        self,
        db: AsyncSession,
        channel: Channel,
        recipients: list[uuid.UUID],
        message: dict[str, Any] | None = None,
        participants: set[uuid.UUID] | None = None,
        *,
        parent_id: uuid.UUID | None = None,
    ) -> list[uuid.UUID]:
        """PUSH_NOTIFICATIONS.md §4; ``participants`` are the thread's author and repliers, and
        ``parent_id`` the thread a reply is read in (its position, not the channel's)."""
        now = utcnow()
        prefs = await repo.preferences_for_channel(db, channel.id, recipients)
        mentioned = {uuid.UUID(str(uid)) for uid in (message or {}).get("mentioned_user_ids", [])}
        if message and message.get("id"):  # keyword hits are not in the event (they are private)
            mentioned |= await messages.keyword_user_ids(db, uuid.UUID(str(message["id"])))
        mention_all = bool((message or {}).get("mention_all"))
        seq = (message or {}).get("seq")
        followers: set[uuid.UUID] = set()
        if parent_id is not None:
            positions = await threads.last_read_seqs(db, parent_id, recipients)
            # A reply only in its thread is for those who follow it (author, repliers, followed by
            # hand): at level "all" too, others are not woken by a talk they never joined (Slack's
            # rule, PUSH_NOTIFICATIONS.md §4). A mention still reaches them.
            followers = set(await threads.followers(db, parent_id))
        else:
            positions = await reads.last_read_seqs(db, recipients, channel.id)
        rows = await users.get_users(db, recipients)
        targets: list[uuid.UUID] = []
        for user_id in recipients:
            pref = prefs.get(user_id)
            user = rows.get(user_id)
            level = push_level(
                pref.level if pref else None,
                is_dm=channel.is_dm,
                others_times=channel.times_owner_id is not None
                and channel.times_owner_id != user_id,
                overall=user.notification_default if user is not None else "mentions",
            )
            if level == "none" or is_muted(pref, now):
                continue
            if user is not None and dnd_active(user, now):
                continue  # paused / quiet hours (M12c); the badge catches up with the next push
            involved = mention_all or user_id in mentioned or user_id in (participants or set())
            if level == "mentions" and not involved:
                continue
            if parent_id is not None and not involved and user_id not in followers:
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
        listed = [
            c
            for c in await channels.list_channels(db, user, include_public=False)
            if not c.archived
        ]
        states = await reads.states_for_user(db, user_id, [c.id for c in listed])
        prefs = await repo.preferences_for_user(db, user_id)
        now = utcnow()
        badge = 0
        for c in listed:
            state = states.get(c.id)
            if state is None:
                continue
            pref = prefs.get(c.id)
            # The same rule as GET /sync/summary and the clients (SYNC_PROTOCOL.md §10.5).
            badge += unread_rules.badge(
                unread_rules.Conversation(
                    is_dm=c.type in ("dm", "group_dm"),
                    others_times=c.times_owner_id is not None and c.times_owner_id != user_id,
                    level=pref.level if pref is not None else None,
                    muted=is_muted(pref, now),
                    unread=state.unread_count,
                    mentions=state.mention_count,
                )
            )
        return badge + await reminders.fired_count(db, user_id)  # M12e: nudges not yet done

    def build_payload(
        self,
        channel: Channel,
        sender: User | None,
        message: dict[str, object],
        seq: int | None,
        *,
        badge: int = 1,
        names: dict[uuid.UUID, str] | None = None,
        workspace_id: uuid.UUID | None = None,
        locale: str = "ja",
    ) -> PushPayload:
        """The message push in `locale` (M115: the recipient's device's language)."""
        sender_name = sender.display_name if sender else i18n.t("someone", locale)
        new_message = i18n.t("push.new_message", locale)
        if channel.type == "dm":
            title, subtitle = sender_name, None
        elif channel.type == "group_dm":
            title, subtitle = i18n.t("push.group_dm", locale), sender_name
        else:
            title, subtitle = f"#{channel.name}", sender_name
        attachments = message.get("attachments")
        body = (
            notification_text(str(message.get("body", "")), names or {}, locale=locale)
            or attachment_text(attachments if isinstance(attachments, list) else [], locale)
            if self.settings.push_include_content
            else new_message
        )
        priority = str(message.get("priority"))
        label = (
            i18n.t(f"push.priority.{priority}", locale)
            if priority in ("important", "urgent")
            else ""
        )
        body = label + (body or new_message)  # M15e
        return PushPayload(
            kind="message",
            workspace_id=workspace_id,
            channel_id=channel.id,
            message_id=uuid.UUID(str(message["id"])),
            seq=seq,
            title=title,
            subtitle=subtitle,
            body=body or new_message,
            badge=max(badge, 1),
            collapse_key=str(channel.id),
            sent_at=utcnow(),
        )
