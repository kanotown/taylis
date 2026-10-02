"""Deadlines (M85, L5, DEADLINES.md): a channel task of kind `deadline` whose advance notices the
deadline bot (「締切」) posts in its channel.

A deadline plans one `task_deadline_notices` row per notice day: 9:00 in its zone (`notice_tz`,
which is `due_tz` when it has a due time) that many days before its date. A notice that would not
come before a timed deadline's time is not planned (the day before covers it). The key holds the
planned time, so moving the deadline plans new rows (and posts again for the new date) while a
time already posted is never posted again; completing, deleting it or dropping a day cancels the
pending rows, and a reopened deadline gets back the ones still ahead. A time already past when
planned is stored cancelled (no notice after the fact).

The worker (`fire_notices`, in the scheduled loop) posts, per deadline, the most recent notice
that has come (a server that was down posts once, the nearest day) through the ordinary message
path as the bot (the bot rejoins the channel if removed; it may post in an announcement channel,
like the other bots, but only someone allowed to change the board there sets a deadline), with
an idempotency key from the row, and never after the deadline itself or in an archived channel.
"""

import logging
import uuid
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.modules.admin import service as admin
from app.modules.channels import service as channels
from app.modules.messages import service as messages
from app.modules.messages.mentions import extract_mentions, notification_text
from app.modules.messages.schemas import MessageCreate
from app.modules.tasks import repository as repo
from app.modules.tasks.models import SystemBot, Task, TaskDeadlineNotice
from app.modules.users import service as users
from app.modules.users.models import User

log = logging.getLogger(__name__)

# The notices go out at 9:00 of the day, in the deadline's zone.
NOTICE_TIME = time(9, 0)
BOT_KEY = "deadlines"
BOT_NAME = "締切"
WEEKDAYS_JA = ("月", "火", "水", "木", "金", "土", "日")
# A notice's client_msg_id: uuid5(this, "<task>/<days>/<fire_at>").
_NOTICE_NAMESPACE = uuid.UUID("0d5e1c7a-85d1-4f0e-9a6b-3c2f8e5a0d85")


# --- the pure rules ------------------------------------------------------------------------------


def _at(day: date, clock: time, zone: ZoneInfo) -> datetime:
    return datetime.combine(day, clock, zone).astimezone(UTC)


def deadline_end(due_on: date, due_at: datetime | None, tz: str) -> datetime:
    """When the deadline has passed: its time, or the end of its day in its zone."""
    if due_at is not None:
        return due_at.astimezone(UTC)
    return _at(due_on + timedelta(days=1), time(0, 0), ZoneInfo(tz))


def notice_plan(
    due_on: date, due_at: datetime | None, tz: str, days: list[int]
) -> dict[int, datetime]:
    """{days before: when} — 9:00 in `tz` that many days before `due_on`; a time not before a
    timed deadline is left out."""
    zone = ZoneInfo(tz)
    plan: dict[int, datetime] = {}
    for day in days:
        moment = _at(due_on - timedelta(days=day), NOTICE_TIME, zone)
        if due_at is not None and moment >= due_at:
            continue
        plan[day] = moment
    return plan


def due_label(due_on: date, due_at: datetime | None, tz: str) -> str:
    """「10/9 (金)」, with the time for a timed deadline (「10/9 (金) 17:00」, in its zone)."""
    label = f"{due_on.month}/{due_on.day} ({WEEKDAYS_JA[due_on.weekday()]})"
    if due_at is not None:
        label += f" {due_at.astimezone(ZoneInfo(tz)):%H:%M}"
    return label


def notice_body(title: str, days: int, label: str, assignees: list[str]) -> str:
    """The bot's post: 「⏰ 締切まであと 3 日: **全国大会 原稿** (10/9 (金))」."""
    if days == 0:
        head = "今日が締切です"
    elif days == 1:
        head = "明日が締切です"
    else:
        head = f"締切まであと {days} 日です"
    body = f"⏰ {head}: **{title}** ({label})"
    if assignees:
        body += f"\n担当: {'、'.join(assignees)}"
    return body


def plain_title(title: str, names: dict[uuid.UUID, str]) -> str:
    """The title without mention tokens (the bot's post must not ping anyone) or Markdown."""
    return notification_text(title, names).replace("<", "\uff1c").replace("*", "\uff0a")


# --- planning ------------------------------------------------------------------------------------


def _wanted(task: Task) -> dict[int, datetime]:
    if (
        task.kind != "deadline"
        or task.is_deleted
        or task.status == "done"
        or task.due_on is None
        or not task.notice_days
        or task.notice_tz is None
    ):
        return {}
    return notice_plan(task.due_on, task.due_at, task.notice_tz, list(task.notice_days))


async def sync_notices(db: AsyncSession, task: Task, now: datetime) -> None:
    """Makes the deadline's notice rows match its date, days and state (the module's note)."""
    if task.kind != "deadline":
        return
    wanted = _wanted(task)
    rows = await repo.notices_of(db, task.id)
    existing = {(row.days_before, row.fire_at): row for row in rows}
    for (days, fire_at), row in existing.items():
        if row.status == "pending" and wanted.get(days) != fire_at:
            row.status = "cancelled"
            row.updated_at = now
    for days, fire_at in wanted.items():
        found = existing.get((days, fire_at))
        if found is None:
            db.add(
                TaskDeadlineNotice(
                    task_id=task.id,
                    days_before=days,
                    fire_at=fire_at,
                    status="pending" if fire_at > now else "cancelled",
                    created_at=now,
                    updated_at=now,
                )
            )
        elif found.status == "cancelled" and fire_at > now:
            found.status = "pending"
            found.updated_at = now
    await db.flush()


# --- the bot -------------------------------------------------------------------------------------


async def deadline_bot(db: AsyncSession, actor_id: uuid.UUID) -> User | None:
    """The deadline bot, made the first time (`actor_id` is in its audit row). None when an
    administrator deactivated it: that stops every deadline's notices."""
    row = await db.get(SystemBot, BOT_KEY)
    if row is None:
        bot = await admin.create_bot_in_tx(
            db,
            actor_id=actor_id,
            username=f"deadline-bot-{uuid.uuid4().hex[:8]}",
            display_name=BOT_NAME,
        )
        await db.execute(
            pg_insert(SystemBot)
            .values(key=BOT_KEY, user_id=bot.id, created_at=utcnow())
            .on_conflict_do_nothing()
        )
        row = await db.get(SystemBot, BOT_KEY, populate_existing=True)
        if row is None:  # pragma: no cover - the insert above or a concurrent one wrote it
            return None
    user = await users.get_user(db, row.user_id)
    if user is None or not user.is_active:
        return None
    return user


async def bot_user_id(db: AsyncSession) -> uuid.UUID | None:
    """The deadline bot's id once it exists (for tests and the docs' "who posts")."""
    stmt = select(SystemBot.user_id).where(SystemBot.key == BOT_KEY)
    return (await db.execute(stmt)).scalar_one_or_none()


# --- the worker ----------------------------------------------------------------------------------


async def _post(
    db: AsyncSession, task: Task, notice: TaskDeadlineNotice, now: datetime
) -> uuid.UUID | None:
    """Posts the notice as the bot (in the caller's savepoint); the message's id, or None when it
    cannot be posted (the channel archived or gone, the bot deactivated)."""
    assert task.channel_id is not None and task.due_on is not None and task.notice_tz is not None
    channel = await channels.find_channel(db, task.channel_id)
    if channel is None or channel.is_archived:
        return None
    bot = await deadline_bot(db, task.owner_id)
    if bot is None:
        return None
    assignee_ids = (await repo.assignees_of(db, [task.id])).get(task.id, [])
    mentioned, _ = extract_mentions(task.title)
    people = await users.get_users(db, [*assignee_ids, *mentioned])
    names = {uid: person.display_name for uid, person in people.items()}
    body = notice_body(
        plain_title(task.title, names),
        notice.days_before,
        due_label(task.due_on, task.due_at, task.notice_tz),
        [names[uid] for uid in assignee_ids if uid in names],
    )
    key = uuid.uuid5(
        _NOTICE_NAMESPACE, f"{task.id}/{notice.days_before}/{notice.fire_at.isoformat()}"
    )
    if await channels.membership_of(db, bot.id, channel.id) is None:
        await channels.add_member_in_tx(db, channel, bot.id)
    message, _created = await messages.create_message(
        db,
        bot,
        channel.id,
        MessageCreate(client_msg_id=key, body=body),
        advance_read=False,
        commit=False,
    )
    return message.id


async def fire_notices(db: AsyncSession, *, now: datetime | None = None, limit: int = 50) -> int:
    """Posts the notices whose time has come (the module's note); the number posted."""
    moment = now or utcnow()
    due = await repo.due_notices(db, moment, limit)
    by_task: dict[uuid.UUID, list[TaskDeadlineNotice]] = {}
    for row in due:
        by_task.setdefault(row.task_id, []).append(row)
    posted = 0
    for task_id, rows in by_task.items():
        for row in rows:
            row.status = "cancelled"
            row.updated_at = moment
        task = await repo.get(db, task_id)
        if task is None:
            continue
        wanted = _wanted(task)
        live = [row for row in rows if wanted.get(row.days_before) == row.fire_at]
        if not live or task.due_on is None or task.notice_tz is None:
            continue
        if moment >= deadline_end(task.due_on, task.due_at, task.notice_tz):
            continue
        notice = min(live, key=lambda row: row.days_before)
        await db.flush()  # the cancellations stay whatever the post does
        try:
            async with db.begin_nested():
                message_id = await _post(db, task, notice, moment)
        except Exception:
            log.exception("deadline notice for task %s failed", task_id)
            continue
        if message_id is not None:
            notice.status = "fired"
            notice.message_id = message_id
            posted += 1
    await db.flush()
    await db.commit()
    return posted
