"""Recurring posts and collecting replies (L6, RECURRING.md).

A recurring post belongs to a channel and posts as its own bot (role `bot`, a member of the
channel, named after the post) through the ordinary message path, so seq, outbox, mentions,
pushes and search need nothing special. The body's placeholders are replaced with the posting
day in the post's zone. The worker (beside the reminders') posts the rows whose `next_run_at`
has come, once per row whatever was missed while the server was down, and moves `next_run_at`
on in the same transaction.

A post that collects gets a `collections` row: the targets (channel members then) and the due
time. A target has submitted when they have a live reply in the thread (MessageOut.collection,
counted when read). After the due time the worker makes, once, a personal reminder (kind
`collect`) for each target who has not, through the reminders' path (their list, push, badge).
"""

import logging
import secrets
import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app import i18n
from app.core.errors import AppError, bad_request, conflict, forbidden, not_found
from app.core.time import utcnow
from app.modules.admin import service as admin
from app.modules.audit import service as audit
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.groups import service as groups
from app.modules.messages import repository as message_repo
from app.modules.messages import service as messages
from app.modules.messages.models import Message
from app.modules.messages.schemas import MessageCreate
from app.modules.recurring import repository as repo
from app.modules.recurring.models import Collection, RecurringPost
from app.modules.recurring.schedule import (
    due_at,
    due_label,
    expand_template,
    local_date,
    next_run_after,
)
from app.modules.recurring.schemas import (
    CollectSpec,
    RecurringPostCreate,
    RecurringPostOut,
    RecurringPostUpdate,
    schedule_dict,
    to_recurring_out,
)
from app.modules.reminders import service as reminders
from app.modules.users import service as users
from app.modules.users.events import USER_UPDATED, emit_user_event
from app.modules.users.models import User

log = logging.getLogger(__name__)

# Recurring posts in one channel at most (SECURITY.md §5).
MAX_PER_CHANNEL = 20
# A scheduled run's client_msg_id is derived from the row and the time it was due, so a run
# repeated for the same time (it never should be) finds the message it made.
_RUN_NAMESPACE = uuid.UUID("6f0c1f4e-5a59-4c55-9a43-5d0f6b7c1e59")


# --- access -----------------------------------------------------------------------------------


async def _managed_channel(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> Channel:
    """The channel's owners and the administrators among its members (RECURRING.md §1; as the
    calendar's editors: managing needs membership, so a private channel stays closed)."""
    channels.require_not_guest(actor)
    channel, membership = await channels.require_member(db, actor.id, channel_id)
    if channel.is_dm:
        raise bad_request(
            "recurring_channel_unsupported", "Recurring posts are for channels, not DMs"
        )
    if membership.role != "owner" and not actor.is_admin:
        raise forbidden(
            "recurring_manage_restricted",
            "Only the channel's owners and administrators manage recurring posts",
        )
    return channel


async def _managed_row(
    db: AsyncSession, actor: User, post_id: uuid.UUID
) -> tuple[RecurringPost, Channel]:
    row = await repo.get(db, post_id, for_update=True)
    if row is None:
        raise not_found("recurring_post_not_found", "Recurring post not found")
    try:
        await channels.require_readable(db, actor, row.channel_id)
    except AppError as exc:  # someone who cannot read the channel does not learn it exists
        raise not_found("recurring_post_not_found", "Recurring post not found") from exc
    channel = await _managed_channel(db, actor, row.channel_id)
    return row, channel


async def _check_targets(db: AsyncSession, collect: CollectSpec | None) -> None:
    if collect is None:
        return
    targets = collect.targets
    if targets.group_ids:
        found = await groups.names_for(db, targets.group_ids)
        if len(found) != len(targets.group_ids):
            raise not_found("group_not_found", "Group not found")
    if targets.user_ids:
        people = await users.get_users(db, targets.user_ids)
        if len(people) != len(targets.user_ids):
            raise not_found("user_not_found", "User not found")


# --- CRUD -------------------------------------------------------------------------------------


async def list_for_channel(
    db: AsyncSession, actor: User, channel_id: uuid.UUID
) -> list[RecurringPostOut]:
    """Whoever reads the channel sees its recurring posts (what is posted when, and whom it
    collects from: the posts themselves show the same); only managers change them."""
    await channels.require_readable(db, actor, channel_id)
    return [to_recurring_out(row) for row in await repo.list_for_channel(db, channel_id)]


async def create(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, data: RecurringPostCreate
) -> RecurringPostOut:
    channel = await _managed_channel(db, actor, channel_id)
    channels.require_writable(channel)
    if await repo.count_for_channel(db, channel.id) >= MAX_PER_CHANNEL:
        raise conflict(
            "too_many_recurring_posts", f"At most {MAX_PER_CHANNEL} recurring posts per channel"
        )
    await _check_targets(db, data.collect)
    now = utcnow()
    schedule = schedule_dict(data.schedule)
    bot = await admin.create_bot_in_tx(
        db,
        actor_id=actor.id,
        username=f"recurring-{secrets.token_hex(4)}",
        display_name=data.name,
    )
    await channels.add_member_in_tx(db, channel, bot.id)
    row = RecurringPost(
        channel_id=channel.id,
        created_by=actor.id,
        bot_user_id=bot.id,
        name=data.name,
        body=data.body,
        schedule=schedule,
        tz=data.tz,
        collect=data.collect.model_dump(mode="json") if data.collect else None,
        enabled=data.enabled,
        next_run_at=next_run_after(schedule, data.tz, now),
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.flush()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="recurring.created",
        target_type="recurring_post",
        target_id=row.id,
        details={"name": row.name, "channel_id": str(channel.id), "bot_user_id": str(bot.id)},
    )
    await db.commit()
    return to_recurring_out(row)


async def update(
    db: AsyncSession, actor: User, post_id: uuid.UUID, data: RecurringPostUpdate
) -> RecurringPostOut:
    row, channel = await _managed_row(db, actor, post_id)
    channels.require_writable(channel)
    fields = data.model_fields_set
    now = utcnow()
    reschedule = False
    if data.name is not None and data.name != row.name:
        row.name = data.name
        bot = await users.require_user(db, row.bot_user_id)
        bot.display_name = data.name
        bot.updated_at = now
        await db.flush()
        await emit_user_event(db, USER_UPDATED, bot)
    if data.body is not None:
        row.body = data.body
    if data.schedule is not None:
        row.schedule = schedule_dict(data.schedule)
        reschedule = True
    if data.tz is not None and data.tz != row.tz:
        row.tz = data.tz
        reschedule = True
    if "collect" in fields:
        await _check_targets(db, data.collect)
        row.collect = data.collect.model_dump(mode="json") if data.collect else None
    if data.enabled is not None and data.enabled != row.enabled:
        row.enabled = data.enabled
        # Resuming starts from the next time from now: nothing missed while paused is posted.
        reschedule = reschedule or data.enabled
    if reschedule:
        row.next_run_at = next_run_after(row.schedule, row.tz, now)
    row.updated_at = now
    await db.flush()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="recurring.updated",
        target_type="recurring_post",
        target_id=row.id,
        details={"fields": sorted(fields)},
    )
    await db.commit()
    return to_recurring_out(row)


async def delete(db: AsyncSession, actor: User, post_id: uuid.UUID) -> None:
    """Stops it for good: the bot leaves the channel and is deactivated; its posts (and their
    collections, nudges included) stay."""
    row, channel = await _managed_row(db, actor, post_id)
    now = utcnow()
    row.deleted_at = now
    row.enabled = False
    row.updated_at = now
    await channels.remove_member_in_tx(db, channel, row.bot_user_id)
    await admin.deactivate_bot_in_tx(db, row.bot_user_id)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="recurring.deleted",
        target_type="recurring_post",
        target_id=row.id,
        details={"name": row.name},
    )
    await db.commit()


async def run_now(db: AsyncSession, actor: User, post_id: uuid.UUID) -> uuid.UUID:
    """今すぐ投稿: posts now (also while paused); the next scheduled time does not change."""
    row, channel = await _managed_row(db, actor, post_id)
    channels.require_writable(channel)
    message = await _post_in_tx(db, row, channel, utcnow(), uuid.uuid4())
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="recurring.run",
        target_type="recurring_post",
        target_id=row.id,
        details={"message_id": str(message.id)},
    )
    await db.commit()
    return message.id


# --- posting ----------------------------------------------------------------------------------


async def _targets(db: AsyncSession, channel_id: uuid.UUID, spec: CollectSpec) -> list[uuid.UUID]:
    """The targets now: the union of the groups' members and the people (or every member), among
    the channel's active members who are not bots, by display name."""
    eligible = await repo.eligible_members(db, channel_id)
    if spec.targets.all_members:
        return eligible
    wanted = set(spec.targets.user_ids)
    if spec.targets.group_ids:
        wanted.update(await groups.expand(db, spec.targets.group_ids))
    return [user_id for user_id in eligible if user_id in wanted]


async def _post_in_tx(
    db: AsyncSession,
    row: RecurringPost,
    channel: Channel,
    now: datetime,
    client_msg_id: uuid.UUID,
) -> Message:
    """The post (and its collection), uncommitted. The bot rejoins the channel if someone removed
    it: a recurring post keeps going until a manager stops it."""
    bot = await users.require_user(db, row.bot_user_id)
    if await channels.membership_of(db, bot.id, channel.id) is None:
        await channels.add_member_in_tx(db, channel, bot.id)
    body = expand_template(row.body, local_date(now, row.tz))
    message, created = await messages.create_message(
        db,
        bot,
        channel.id,
        MessageCreate(client_msg_id=client_msg_id, body=body),
        advance_read=False,
        commit=False,
    )
    row.last_run_at = now
    if created and row.collect:
        spec = CollectSpec.model_validate(row.collect)
        db.add(
            Collection(
                message_id=message.id,
                recurring_post_id=row.id,
                channel_id=channel.id,
                target_user_ids=await _targets(db, channel.id, spec),
                due_at=due_at(now, spec.due.after_days, spec.due.time, row.tz),
                created_at=now,
            )
        )
        await db.flush()
        # message.created went out without it: the clients learn the collection at once.
        await messages.announce_change_in_tx(db, message, "collection")
    return message


async def run_due(db: AsyncSession, *, now: datetime | None = None, limit: int = 20) -> int:
    """The worker: posts every enabled row whose time has come, once each (a server that was
    down posts the missed times as one), and moves next_run_at past now in the same transaction.
    A row in an archived (or vanished) channel is paused instead. A post that fails is logged and
    skipped, so one broken row does not come back every few seconds."""
    moment = now or utcnow()
    posted = 0
    for row in await repo.due(db, moment, limit):
        channel = await channels.find_channel(db, row.channel_id)
        if channel is None or channel.is_archived:
            row.enabled = False
            row.updated_at = moment
            await db.flush()
            continue
        # Read before the savepoint: a failed post expires the row's attributes.
        scheduled_for, schedule, tz = row.next_run_at, dict(row.schedule), row.tz
        client_msg_id = uuid.uuid5(_RUN_NAMESPACE, f"{row.id}/{scheduled_for.isoformat()}")
        try:
            async with db.begin_nested():
                await _post_in_tx(db, row, channel, moment, client_msg_id)
            posted += 1
        except Exception:
            log.exception("recurring post %s failed", row.id)
        row.next_run_at = next_run_after(schedule, tz, moment)
        await db.flush()
    await db.commit()
    return posted


async def remind_due(db: AsyncSession, *, now: datetime | None = None, limit: int = 20) -> int:
    """The worker: once a collection is past due, each target who has not submitted (and is
    still an active member) gets a personal reminder, once (`reminded_at`). Only they learn it."""
    moment = now or utcnow()
    nudged = 0
    for row in await repo.overdue_collections(db, moment, limit):
        row.reminded_at = moment
        message = await messages.find_message(db, row.message_id)
        channel = await channels.find_channel(db, row.channel_id)
        if message is None or channel is None or channel.is_archived:
            await db.flush()
            continue
        post = await repo.get_post_any(db, row.recurring_post_id)
        tz = post.tz if post is not None else "Asia/Tokyo"
        submitted = (await message_repo.repliers_for(db, [message.id])).get(message.id, set())
        members = set(await repo.eligible_members(db, channel.id))
        people = await users.get_users(db, list(row.target_user_ids))
        for user_id in row.target_user_ids:
            if user_id in submitted or user_id not in members:
                continue
            # M115: the note in the reader's language (docs/I18N.md).
            lc = await i18n.text_locale(db, people[user_id]) if user_id in people else "ja"
            name = post.name if post is not None else i18n.t("reminder.collect_default", lc)
            due = due_label(row.due_at, tz, lc)
            note = i18n.t("reminder.collect_note", lc, name=name, due=due)[:200]
            await reminders.create_system_in_tx(
                db,
                user_id=user_id,
                message_id=message.id,
                channel_id=channel.id,
                note=note,
                kind="collect",
                body=message.body,
                now=moment,
            )
            nudged += 1
        await db.flush()
        await messages.announce_change_in_tx(db, message, "collection")
    await db.commit()
    return nudged
