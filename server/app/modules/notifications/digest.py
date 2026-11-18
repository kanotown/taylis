"""M192 (PUSH_NOTIFICATIONS.md §18): one summary push of what a pause held back.

While someone's notifications are paused (dnd_until: 取り込み中 / 通知を一時停止, or quiet hours),
message pushes to them are dropped (§4). The PushPlanner notes (`record`) each one that only the
pause held back and that addresses them: a mention (by name, group, @channel / @here, keyword) or
a DM / group DM. The scheduled worker (`send_due`) looks at everyone with notes; once no pause is
in effect for them, it takes their notes (DELETE … RETURNING) and, in the same transaction, plans
one push to each of their phones. The notes and the planned push commit together: a crash before
the commit leaves the notes for the next round, one after it leaves nothing to send twice.
"""

import logging
import uuid
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app import i18n
from app.core.time import utcnow
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.messages import repository as messages_repo
from app.modules.messages.models import Message
from app.modules.moderation import blocks
from app.modules.notifications import repository as repo
from app.modules.notifications.models import NotificationDigestItem
from app.modules.notifications.schemas import PushPayload
from app.modules.reads import service as reads
from app.modules.threads import service as threads
from app.modules.users import service as users
from app.modules.users.dnd import dnd_active
from app.modules.users.models import User
from app.modules.workspace import service as workspace

if TYPE_CHECKING:
    from app.modules.notifications.planner import PushPlanner

log = logging.getLogger("app.push")

COLLAPSE_KEY = "digest"
# Names and conversations listed before 「ほか」.
SHOWN = 2


async def record(db: AsyncSession, held: list[uuid.UUID], message_id: uuid.UUID) -> None:
    """Note the message for each of `held` that has a phone to tell later. Once per person and
    message: the outbox event may be processed again."""
    with_phone = {d.user_id for d in await repo.push_devices_for_users(db, held)}
    rows = [{"user_id": u, "message_id": message_id} for u in held if u in with_phone]
    if rows:
        await db.execute(
            insert(NotificationDigestItem)
            .values(rows)
            .on_conflict_do_nothing(constraint="notification_digest_items_user_message_uniq")
        )


async def send_due(db: AsyncSession, planner: "PushPlanner", *, now: datetime | None = None) -> int:
    """Everyone with notes and no pause in effect: take the notes and plan the summary, one
    transaction per person. Returns how many summaries were planned."""
    moment = now or utcnow()
    noted = select(NotificationDigestItem.user_id).distinct()
    planned = 0
    for user_id in list((await db.execute(noted)).scalars().all()):
        user = await db.get(User, user_id)  # (re)loaded: a rollback below expires the rows
        if user is None:
            continue
        if user.deactivated_at is None and dnd_active(user, moment):
            continue  # still paused (another pause may have begun as one ended): wait
        try:
            taken = (
                await db.execute(
                    delete(NotificationDigestItem)
                    .where(NotificationDigestItem.user_id == user.id)
                    .returning(NotificationDigestItem.id, NotificationDigestItem.message_id)
                )
            ).all()
            if taken and user.deactivated_at is None and user.notify_digest:
                if await _plan(db, planner, user, sorted(taken), moment):
                    planned += 1
            await db.commit()
        except Exception:
            # The notes stay for the next round; one person's failure does not hold up the rest.
            await db.rollback()
            log.exception("notification digest for user %s failed", user.id)
    return planned


async def _plan(
    db: AsyncSession,
    planner: "PushPlanner",
    user: User,
    taken: list[Any],
    now: datetime,
) -> bool:
    """Plans the summary of `taken` (id, message_id) for `user`'s phones; False when there is
    nothing to tell: they are looking at the app right now (§4.1), or every message was deleted,
    read (the thread's position for a reply only in its thread), left with its conversation or
    sent by someone they blocked since."""
    if planner.is_active(user.id):
        return False
    kept: list[Message] = []
    for _, message_id in taken:
        message = await messages_repo.get_message(db, message_id)
        if message is not None and await _still_to_tell(db, user.id, message):
            kept.append(message)
    if not kept:
        return False
    devices = await repo.push_devices_for_users(db, [user.id])
    if not devices:
        return False
    senders = await users.get_users(db, list({m.sender_id for m in kept}))
    rows = await db.execute(select(Channel).where(Channel.id.in_({m.channel_id for m in kept})))
    conversations = {c.id: c for c in rows.scalars().all()}
    expires_at = now + timedelta(seconds=planner.settings.push_alert_ttl_seconds)
    workspace_id = await workspace.workspace_id(db)
    badge = max(await planner.badge_for(db, user.id), 1)
    payloads: dict[str, dict[str, Any]] = {}

    def build(lc: str) -> dict[str, Any]:
        entries = []
        for message in kept:
            sender = senders.get(message.sender_id)
            channel = conversations[message.channel_id]
            entries.append(
                (
                    "dm" if channel.is_dm else "mention",
                    sender.display_name if sender else i18n.t("someone", lc),
                    place(channel, lc),
                )
            )
        return PushPayload(
            kind="digest",
            workspace_id=workspace_id,
            seq=None,
            title=i18n.t("push.digest.title", lc),
            subtitle=None,
            body=summary(entries, lc, include_content=planner.settings.push_include_content),
            badge=badge,
            collapse_key=COLLAPSE_KEY,
            sent_at=now,
        ).model_dump(mode="json") | {"expires_at": expires_at.isoformat()}

    # push_deliveries.event_id is the planned push's key (an outbox event's id elsewhere). The
    # summary has no outbox event: it takes the negated id of its newest note, which no other
    # summary has (a note is taken once) and no outbox event has (those are positive).
    event_id = -max(item_id for item_id, _ in taken)
    for device in devices:
        lc = i18n.device_locale(user, device)
        if lc not in payloads:
            payloads[lc] = build(lc)
        await repo.add_delivery(
            db,
            event_id=event_id,
            device=device,
            kind="alert",
            collapse_key=COLLAPSE_KEY,
            channel_id=None,
            message_id=None,
            message_seq=None,
            payload=payloads[lc],
            expires_at=expires_at,
        )
    log.info("planned a digest of %d message(s) for user %s", len(kept), user.id)
    return True


async def _still_to_tell(db: AsyncSession, user_id: uuid.UUID, message: Message) -> bool:
    if message.deleted_at is not None:
        return False
    if await channels.membership_of(db, user_id, message.channel_id) is None:
        return False  # left or removed: no longer theirs to read
    if await blocks.is_blocked(db, user_id, message.sender_id):
        return False  # M104: nothing from someone they blocked, not even a name
    if message.parent_id is not None and not message.also_in_channel:
        return not await threads.is_read(db, user_id, message.parent_id, message.seq)
    return not await reads.is_read(db, user_id, message.channel_id, message.seq)


def place(channel: Channel, locale: str) -> str:
    """How a conversation reads in the summary: #name, DM, グループ DM."""
    if channel.type == "dm":
        return i18n.t("push.digest.dm", locale)
    if channel.type == "group_dm":
        return i18n.t("push.group_dm", locale)
    return f"#{channel.name}"


def summary(entries: list[tuple[str, str, str]], locale: str, *, include_content: bool) -> str:
    """The body from (kind, sender's name, conversation) per message, oldest first:
    「メンション 3 件：田中 一郎、高橋 健太 ほか（#研究ミーティング、DM）」,
    or 「DM 2 件：田中 一郎」 when every message is a DM;
    without content 「通知を止めていた間にメンションが 3 件あります」.
    A DM among mentions counts with them (it addresses me as much)."""
    only_dms = all(kind == "dm" for kind, _, _ in entries)
    key = "push.digest.dms" if only_dms else "push.digest.mentions"
    if not include_content:
        return i18n.t(f"{key}_hidden", locale, count=len(entries))
    who = _listed([name for _, name, _ in entries], locale)
    where = _listed([conversation for _, _, conversation in entries], locale)
    return i18n.t(key, locale, count=len(entries), who=who, where=where)[:240]


def _listed(values: list[str], locale: str) -> str:
    """The distinct values in order, the first SHOWN of them, then 「ほか」."""
    distinct = list(dict.fromkeys(values))
    text = i18n.t("push.digest.sep", locale).join(distinct[:SHOWN])
    return i18n.t("push.digest.more", locale, list=text) if len(distinct) > SHOWN else text
