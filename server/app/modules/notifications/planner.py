"""PushPlanner: an outbox handler that turns message.created into push_deliveries (§4)."""

import logging
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

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
from app.modules.groups import service as groups
from app.modules.messages import repository as messages_repo
from app.modules.messages import service as messages
from app.modules.messages.events import MESSAGE_CREATED
from app.modules.messages.mentions import attachment_text, extract_group_mentions, notification_text
from app.modules.notifications import repository as repo
from app.modules.notifications.schemas import PushPayload
from app.modules.notifications.service import is_muted, push_level
from app.modules.reads import rules as unread_rules
from app.modules.reads import service as reads
from app.modules.reminders import service as reminders
from app.modules.reminders.events import REMINDER_UPDATED
from app.modules.tasks import service as tasks
from app.modules.tasks.events import TASK_ASSIGNED, TASK_DUE, TASK_REVIEW_DONE
from app.modules.threads import service as threads
from app.modules.users import service as users
from app.modules.users.dnd import dnd_active
from app.modules.users.models import User
from app.modules.workspace import service as workspace

# A fired reminder's push title by kind (L4 ack, L6 collect); a personal one is リマインダー.
REMINDER_TITLES = {"ack": "確認のお願い", "collect": "提出のお願い"}

log = logging.getLogger("app.push")


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
        payloads: dict[uuid.UUID, dict[str, Any]] = {}
        for device in devices:
            if device.user_id not in payloads:
                badge = await self.badge_for(db, device.user_id)
                payload = self.build_payload(
                    channel,
                    sender,
                    message,
                    event.seq,
                    badge=badge,
                    names=names,
                    workspace_id=workspace_id,
                )
                # parent_id is for the sender's last check (a reply is read by its thread's
                # position), kept beside the payload like expires_at.
                payloads[device.user_id] = payload.model_dump(mode="json") | {
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
                payload=payloads[device.user_id],
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
        payload = PushPayload(
            kind="reminder",
            workspace_id=await workspace.workspace_id(db),
            channel_id=channel_id,
            message_id=message_id,
            seq=None,
            # L4: a request from the author to acknowledge reads as such.
            # L6: a nudge to submit to a collection reads as such too.
            title=REMINDER_TITLES.get(str(reminder.get("kind")), "リマインダー"),
            subtitle=None,
            body=(body if self.settings.push_include_content else "リマインダーの時間です")[:240]
            or "リマインダーの時間です",
            badge=max(await self.badge_for(db, user_id), 1),
            collapse_key=f"reminder:{reminder.get('id')}",
            sent_at=utcnow(),
        ).model_dump(mode="json") | {"expires_at": expires_at.isoformat()}
        for device in devices:
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
        payload = PushPayload(
            kind="calendar",
            workspace_id=await workspace.workspace_id(db),
            channel_id=notice.channel_id,
            event_id=notice.event_id,
            seq=None,
            title="予定",
            subtitle=None,
            body=(notice.body if self.settings.push_include_content else "予定の時間です")[:240],
            badge=max(await self.badge_for(db, user_id), 1),
            collapse_key=f"calendar:{notice.event_id}",
            sent_at=now,
        ).model_dump(mode="json") | {"expires_at": expires_at.isoformat()}
        for device in devices:
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
            who = actor.display_name if actor else "誰か"
            if event.event_type == TASK_REVIEW_DONE:  # L9 (REVIEWS.md §4)
                body = f"{who} がレビューを完了しました: {title}{where}"
                hidden = "レビューが完了しました"
            elif data.get("kind") == "review":
                body = f"{who} がレビューを依頼しました: {title}{where}"
                hidden = "レビューを依頼されました"
            else:
                body = f"{who} がタスクを割り当てました: {title}{where}"
                hidden = "タスクが割り当てられました"
        elif data.get("due_at"):
            # M81 (TASKS.md §11): a due time — the notification goes out at it.
            zone = str(data.get("tz") or calendar.zone_for(None, user))
            at = datetime.fromisoformat(str(data["due_at"])).astimezone(ZoneInfo(zone))
            body = f"{at:%H:%M} が期限: {title}{where}"
            hidden = "期限のタスクがあります"
        else:
            body = f"今日が期限: {title}{where}"
            hidden = "今日が期限のタスクがあります"
        devices = await repo.push_devices_for_users(db, [user_id])
        if not devices:
            return
        expires_at = now + timedelta(seconds=self.settings.push_alert_ttl_seconds)
        payload = PushPayload(
            kind="task",
            workspace_id=await workspace.workspace_id(db),
            channel_id=channel_id,
            task_id=task_id,
            seq=None,
            title="タスク",
            subtitle=None,
            body=(body if self.settings.push_include_content else hidden)[:240],
            badge=max(await self.badge_for(db, user_id), 1),
            collapse_key=f"task:{task_id}",
            sent_at=now,
        ).model_dump(mode="json") | {"expires_at": expires_at.isoformat()}
        for device in devices:
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
        who = actor.display_name if actor else "誰か"
        body = f"{who} が「{canvas.title}」であなたをメンションしました"
        expires_at = now + timedelta(seconds=self.settings.push_alert_ttl_seconds)
        payload = PushPayload(
            kind="canvas",
            workspace_id=await workspace.workspace_id(db),
            channel_id=channel_id,
            canvas_id=canvas_id,
            seq=None,
            title="キャンバス",
            subtitle=None if channel.is_dm else f"#{channel.name}",
            body=(
                body if self.settings.push_include_content else "キャンバスでメンションされました"
            )[:240],
            badge=max(await self.badge_for(db, user_id), 1),
            collapse_key=f"canvas:{canvas_id}",
            sent_at=now,
        ).model_dump(mode="json") | {"expires_at": expires_at.isoformat()}
        for device in devices:
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
        excerpt = (
            notification_text(message.body or "", {}) if self.settings.push_include_content else ""
        )
        where = None if channel.is_dm else f"#{channel.name}"
        expires_at = now + timedelta(seconds=self.settings.push_alert_ttl_seconds)
        payload = PushPayload(
            kind="reaction",
            workspace_id=await workspace.workspace_id(db),
            channel_id=channel_id,
            message_id=message_id,
            seq=None,
            title=f"{actor.display_name if actor else '誰か'} がリアクションしました",
            subtitle=where,
            body=(f"{emoji} 「{excerpt}」" if excerpt else emoji)[:240] or "リアクション",
            badge=max(await self.badge_for(db, user_id), 1),
            collapse_key=f"reaction:{message_id}",
            sent_at=now,
        ).model_dump(mode="json") | {"expires_at": expires_at.isoformat()}
        for device in devices:
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
    ) -> PushPayload:
        sender_name = sender.display_name if sender else "Someone"
        if channel.type == "dm":
            title, subtitle = sender_name, None
        elif channel.type == "group_dm":
            title, subtitle = "グループ DM", sender_name
        else:
            title, subtitle = f"#{channel.name}", sender_name
        attachments = message.get("attachments")
        body = (
            notification_text(str(message.get("body", "")), names or {})
            or attachment_text(attachments if isinstance(attachments, list) else [])
            if self.settings.push_include_content
            else "新しいメッセージ"
        )
        label = {"important": "[重要] ", "urgent": "[緊急] "}.get(str(message.get("priority")), "")
        body = label + (body or "新しいメッセージ")  # M15e
        return PushPayload(
            kind="message",
            workspace_id=workspace_id,
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
