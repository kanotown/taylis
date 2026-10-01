"""Tasks and kanban (M55, TASKS.md).

A task lives on a channel's board (its members see it; public or private channels, not DMs) or in
someone's own list (channel_id NULL, only they see it). Who sees and changes what follows the
channel's membership (§2): members read, those who may post there add, change, move and complete,
and the creator, the assignees, the channel's owners and administrators delete. Someone who
cannot see a task gets 404.

Order: three fixed columns (status) ordered by a double `position`. A move takes the value
halfway between its new neighbours; when that gap is too small the column is renumbered first
(every card of it gets a fresh, evenly spaced position and a task.updated). A task with no place
asked for goes to the bottom of todo / doing and to the top of done (newest done first).

Every change writes an outbox row in the same transaction (§4): task.updated / task.deleted to the
channel's members (a personal task: its owner), without the channel's seq. can_delete differs per
person, so the event carries `deleter_ids` instead. Adding someone else to the assignees writes
task.assigned to them (the assignment push, §5).

Due dates (§5): one task_due_alarms row per task and person to notify (the assignees; a personal
task: its owner) at 8:00 of due_on in their zone, worked out again whenever the due date, the
assignees or the status change; done, deleted or unassigned cancels it, and a row already fired
for the same time is never sent again. The worker (`fire_due`, beside the reminders') marks due
rows fired and writes task.due, which the push planner turns into a notification. Leaving a
channel takes one off its tasks and cancels their alarms (`TaskLeaveHandler`, an outbox handler on
channel.member_removed: channels does not call tasks, ARCHITECTURE.md §5).
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, time
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy import update as sql_update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import bad_request, conflict, forbidden, not_found
from app.core.time import utcnow
from app.events.envelope import Audience
from app.events.models import OutboxEvent
from app.events.outbox import write_outbox
from app.modules.calendar.service import DEFAULT_TZ, zone_for
from app.modules.channels import service as channels
from app.modules.channels.events import CHANNEL_MEMBER_REMOVED
from app.modules.channels.models import Channel
from app.modules.messages import service as messages
from app.modules.messages.events import MESSAGE_DELETED, MESSAGE_UPDATED
from app.modules.tasks import repository as repo
from app.modules.tasks.events import (
    TASK_ASSIGNED,
    TASK_DELETED,
    TASK_DUE,
    TASK_REVIEW_DONE,
    TASK_UPDATED,
)
from app.modules.tasks.models import Task, TaskDueAlarm
from app.modules.tasks.schemas import (
    TaskAssignedData,
    TaskCreate,
    TaskData,
    TaskDeletedData,
    TaskDueData,
    TaskMove,
    TaskOut,
    TaskReviewDoneData,
    TaskSourceOut,
    TaskUpdate,
    TaskUpdatedData,
)
from app.modules.users import service as users
from app.modules.users.models import User

# Positions: a new card goes SPACING beyond the edge of its column; a gap smaller than MIN_GAP
# makes the column renumber (SPACING apart, in order) before the card goes in.
SPACING = 1024.0
MIN_GAP = 1e-6
# GET /tasks: the completed tasks of a board shown by default; GET /tasks/mine: of mine.
BOARD_DONE_LIMIT = 100
MINE_DONE_LIMIT = 50
# GET /tasks/due.
MAX_DUE_RANGE_DAYS = 100
MAX_DUE_TASKS = 1000
# Open tasks one board (or one person's own list) may hold: it bounds GET /tasks (SECURITY.md §5).
MAX_OPEN_PER_BOARD = 1000
# The due-date notification goes out at 8:00 of the day, in the person's zone.
DUE_ALARM_TIME = time(8, 0)


@dataclass(frozen=True)
class _Seen:
    """A task someone may see, with its channel (None: personal) and their role there."""

    task: Task
    channel: Channel | None
    role: str | None


@dataclass(frozen=True)
class DueNotice:
    task_id: uuid.UUID
    channel_id: uuid.UUID | None
    body: str


# --- output --------------------------------------------------------------------------------------


def _utc(value: datetime | None) -> datetime | None:
    return value.astimezone(UTC) if value is not None else None


def to_data(task: Task, channel: Channel | None, assignee_ids: list[uuid.UUID]) -> TaskData:
    source = None
    if task.source_channel_id is not None:
        source = TaskSourceOut(
            message_id=task.source_message_id,
            channel_id=task.source_channel_id,
            excerpt=task.source_excerpt,
        )
    return TaskData(
        id=task.id,
        channel_id=task.channel_id,
        channel_name=channel.name if channel is not None else None,
        owner_id=task.owner_id,
        kind=task.kind,  # type: ignore[arg-type]
        title=task.title,
        notes=task.notes,
        status=task.status,  # type: ignore[arg-type]
        position=task.position,
        due_on=task.due_on,
        assignee_ids=assignee_ids,
        source=source,
        completed_at=_utc(task.completed_at),
        completed_by=task.completed_by,
        created_at=task.created_at,
        updated_at=task.updated_at,
    )


def _can_delete(actor: User, seen: _Seen, assignee_ids: list[uuid.UUID]) -> bool:
    if seen.channel is None:
        return seen.task.owner_id == actor.id
    if seen.channel.is_archived:
        return False
    return (
        seen.task.owner_id == actor.id
        or actor.id in assignee_ids
        or seen.role == "owner"
        or actor.is_admin
    )


def to_out(seen: _Seen, actor: User, assignee_ids: list[uuid.UUID]) -> TaskOut:
    return TaskOut(
        **to_data(seen.task, seen.channel, assignee_ids).model_dump(),
        can_delete=_can_delete(actor, seen, assignee_ids),
    )


async def _outs(
    db: AsyncSession,
    actor: User,
    rows: list[Task],
    joined: dict[uuid.UUID, tuple[Channel, str]],
) -> list[TaskOut]:
    assignees = await repo.assignees_of(db, [row.id for row in rows])
    out: list[TaskOut] = []
    for row in rows:
        if row.channel_id is None:
            seen = _Seen(row, None, None)
        else:
            channel, role = joined[row.channel_id]
            seen = _Seen(row, channel, role)
        out.append(to_out(seen, actor, assignees.get(row.id, [])))
    return out


def _order(rows: list[Task]) -> list[Task]:
    rank = {"todo": 0, "doing": 1, "done": 2}
    return sorted(rows, key=lambda t: (t.channel_id is not None, rank[t.status], t.position, t.id))


# --- events --------------------------------------------------------------------------------------


async def _deleter_ids(
    db: AsyncSession, task: Task, channel: Channel | None, assignee_ids: list[uuid.UUID]
) -> list[uuid.UUID]:
    if channel is None:
        return [task.owner_id]
    if channel.is_archived:
        return []
    ids = await channels.manager_ids_of(db, channel.id)
    ids.update(assignee_ids)
    if task.owner_id in await channels.member_ids_of(db, channel.id):
        ids.add(task.owner_id)
    return sorted(ids)


def _audience(task: Task) -> dict[str, object]:
    if task.channel_id is not None:
        return {"audience_type": "channel", "audience_id": None, "channel_id": task.channel_id}
    return {"audience_type": "user", "audience_id": task.owner_id, "channel_id": None}


async def _emit_updated(
    db: AsyncSession, task: Task, channel: Channel | None, assignee_ids: list[uuid.UUID]
) -> None:
    data = TaskUpdatedData(
        task=to_data(task, channel, assignee_ids),
        deleter_ids=await _deleter_ids(db, task, channel, assignee_ids),
    )
    await write_outbox(
        db,
        event_type=TASK_UPDATED,
        payload=data.model_dump(mode="json"),
        **_audience(task),  # type: ignore[arg-type]
    )


async def _emit_deleted(db: AsyncSession, task: Task) -> None:
    await write_outbox(
        db,
        event_type=TASK_DELETED,
        payload=TaskDeletedData(id=task.id, channel_id=task.channel_id).model_dump(mode="json"),
        **_audience(task),  # type: ignore[arg-type]
    )


async def _emit_assigned(
    db: AsyncSession, task: Task, channel: Channel, actor_id: uuid.UUID, added: list[uuid.UUID]
) -> None:
    """task.assigned to each person someone else added (not to oneself, TASKS.md §5)."""
    for user_id in added:
        if user_id == actor_id:
            continue
        data = TaskAssignedData(
            task_id=task.id,
            channel_id=channel.id,
            channel_name=channel.name or "",
            title=task.title,
            by_user_id=actor_id,
            kind=task.kind,  # type: ignore[arg-type]
        )
        await write_outbox(
            db,
            event_type=TASK_ASSIGNED,
            audience_type="user",
            audience_id=user_id,
            channel_id=channel.id,
            payload=data.model_dump(mode="json"),
        )


async def _announce_source(db: AsyncSession, task: Task) -> None:
    """L9 (REVIEWS.md §2.2): a shared task's chip under its message changed (made, status,
    assignees, due date, deleted): the message takes a new seq and message.updated (change tasks),
    so devices that were away catch up through the delta. Personal tasks show no chip."""
    if task.source_message_id is None or task.channel_id != task.source_channel_id:
        return
    # Re-read under the channel's lock: an edit or a delete committed meanwhile must not be sent
    # back out with its old body (review v0.1.15 #1).
    await messages.announce_change_by_id_in_tx(db, task.source_message_id, "tasks")


async def _emit_review_done(
    db: AsyncSession, task: Task, channel: Channel | None, actor_id: uuid.UUID
) -> None:
    """L9 (§4): the requester hears when someone else completes their review request."""
    if task.kind != "review" or channel is None or actor_id == task.owner_id:
        return
    data = TaskReviewDoneData(
        task_id=task.id,
        channel_id=channel.id,
        channel_name=channel.name or "",
        title=task.title,
        by_user_id=actor_id,
    )
    await write_outbox(
        db,
        event_type=TASK_REVIEW_DONE,
        audience_type="user",
        audience_id=task.owner_id,
        channel_id=channel.id,
        payload=data.model_dump(mode="json"),
    )


# --- access --------------------------------------------------------------------------------------


def _not_found() -> Exception:
    return not_found("task_not_found", "Task not found")


async def _load(db: AsyncSession, actor: User, task_id: uuid.UUID, *, lock: bool = False) -> _Seen:
    """The task if the actor may see it; else 404 (whether it exists is not told)."""
    task = await repo.get(db, task_id, lock=lock)
    if task is None or task.is_deleted:
        raise _not_found()
    if task.channel_id is None:
        if task.owner_id != actor.id:
            raise _not_found()
        return _Seen(task, None, None)
    membership = await channels.membership_of(db, actor.id, task.channel_id)
    if membership is None:
        raise _not_found()
    channel = await channels.require_channel(db, task.channel_id)
    return _Seen(task, channel, membership.role)


def _require_poster(actor: User, channel: Channel, role: str | None) -> None:
    """Adding, changing, moving and completing a board's tasks: like posting there."""
    channels.require_writable(channel)
    if channel.posting_policy == "owners" and not actor.is_admin and role != "owner":
        raise forbidden(
            "posting_restricted", "Only owners and administrators can change tasks here"
        )


def _require_editor(actor: User, seen: _Seen) -> None:
    if seen.channel is not None:
        _require_poster(actor, seen.channel, seen.role)


async def _board_channel(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, *, from_message: bool = False
) -> tuple[Channel, str]:
    """A channel with a board the actor belongs to (public or private). A DM has no board, but
    (L9, REVIEWS.md §2.1) a task made from one of its messages is shared with its members."""
    channel, membership = await channels.require_member(db, actor.id, channel_id)
    if channel.is_dm and not from_message:
        raise bad_request("task_channel_unsupported", "Direct messages have no task board")
    return channel, membership.role


async def _check_assignees(
    db: AsyncSession, channel: Channel | None, assignee_ids: list[uuid.UUID]
) -> None:
    if not assignee_ids:
        return
    if channel is None:
        raise bad_request(
            "task_invalid_assignee", "A personal task has no assignees (it is always yours)"
        )
    members = set(await channels.member_ids_of(db, channel.id))
    outside = [uid for uid in assignee_ids if uid not in members]
    if outside:
        raise bad_request(
            "task_invalid_assignee",
            "Assignees must be members of the channel",
            details={"user_ids": [str(uid) for uid in outside]},
        )


async def _joined(db: AsyncSession, actor: User) -> dict[uuid.UUID, tuple[Channel, str]]:
    """The conversations whose shared tasks the actor sees, with their role in each."""
    # DMs too (L9): a task made from a DM's message is shared with its members.
    pairs = await channels.conversations_of(db, actor.id, include_dms=True)
    return {c.id: (c, role) for c, role in pairs}


# --- positions -----------------------------------------------------------------------------------


async def _default_position(
    db: AsyncSession, channel_id: uuid.UUID | None, owner_id: uuid.UUID, status: str
) -> float:
    """The bottom of todo / doing, the top of done."""
    top = status == "done"
    edge = await repo.column_edge(db, channel_id, owner_id, status, top=top)
    if edge is None:
        return SPACING
    return edge - SPACING if top else edge + SPACING


def between(lo: float | None, hi: float | None) -> float | None:
    """The position halfway between two neighbours (None: no neighbour on that side); None when
    the gap is too small and the column must be renumbered first."""
    if lo is None and hi is None:
        return SPACING
    if lo is None:
        assert hi is not None
        return hi - SPACING
    if hi is None:
        return lo + SPACING
    if hi - lo < MIN_GAP:
        return None
    mid = (lo + hi) / 2
    return mid if lo < mid < hi else None


def insertion_index(
    column: list[uuid.UUID], after_id: uuid.UUID | None, before_id: uuid.UUID | None
) -> int | None:
    """Where a card goes among the column's other cards: just below `after_id`, else just above
    `before_id`; None when neither is in the column (the default place)."""
    if after_id is not None and after_id in column:
        return column.index(after_id) + 1
    if before_id is not None and before_id in column:
        return column.index(before_id)
    return None


async def _place(
    db: AsyncSession,
    task: Task,
    status: str,
    after_id: uuid.UUID | None,
    before_id: uuid.UUID | None,
) -> list[Task]:
    """Sets task.position for its place in `status`'s column; returns the other cards that were
    renumbered on the way (they need a task.updated too)."""
    cards = await repo.column(db, task.channel_id, task.owner_id, status, lock=True)
    cards = [t for t in cards if t.id != task.id]
    index = insertion_index([t.id for t in cards], after_id, before_id)
    if index is None:
        if status == "done":
            task.position = (cards[0].position - SPACING) if cards else SPACING
        else:
            task.position = (cards[-1].position + SPACING) if cards else SPACING
        return []
    lo = cards[index - 1].position if index > 0 else None
    hi = cards[index].position if index < len(cards) else None
    position = between(lo, hi)
    if position is not None:
        task.position = position
        return []
    now = utcnow()
    for i, card in enumerate(cards):
        card.position = SPACING * (i + 1)
        card.updated_at = now
    task.position = SPACING * index + SPACING / 2  # between cards index - 1 and index
    return cards


def _set_status(task: Task, status: str, actor_id: uuid.UUID, now: datetime) -> None:
    if status == task.status:
        return
    if status == "done":
        task.completed_at = now
        task.completed_by = actor_id
    else:
        task.completed_at = None
        task.completed_by = None
    task.status = status


# --- due-date alarms -----------------------------------------------------------------------------


def due_fire_at(due_on: date, tz: str) -> datetime:
    """8:00 of the due date in the person's zone (TASKS.md §5)."""
    return datetime.combine(due_on, DUE_ALARM_TIME, ZoneInfo(tz)).astimezone(UTC)


def _notified(task: Task, assignee_ids: list[uuid.UUID]) -> set[uuid.UUID]:
    """Who gets the due-date notification: an open task's assignees, a personal one's owner."""
    if task.is_deleted or task.status == "done" or task.due_on is None:
        return set()
    if task.channel_id is None:
        return {task.owner_id}
    return set(assignee_ids)


async def _sync_alarms(
    db: AsyncSession,
    task: Task,
    assignee_ids: list[uuid.UUID],
    actor: User,
    tz: str | None,
    now: datetime,
) -> None:
    """Makes the task's alarm rows match who is to be notified and when. A row whose time is
    unchanged keeps its status (one fired is not sent again); one that went away is cancelled."""
    wanted = _notified(task, assignee_ids)
    rows = {row.user_id: row for row in await repo.alarms_of_task(db, task.id)}
    for user_id, stale in rows.items():
        if user_id not in wanted and stale.status == "pending":
            stale.status = "cancelled"
            stale.updated_at = now
    if not wanted:
        await db.flush()
        return
    assert task.due_on is not None
    people = await users.get_users(db, [uid for uid in wanted if uid not in rows])
    for user_id in sorted(wanted):
        row = rows.get(user_id)
        if row is None:
            person = actor if user_id == actor.id else people.get(user_id)
            zone = zone_for(tz if user_id == actor.id else None, person) if person else DEFAULT_TZ
            fire_at = due_fire_at(task.due_on, zone)
            db.add(
                TaskDueAlarm(
                    task_id=task.id,
                    user_id=user_id,
                    tz=zone,
                    fire_at=fire_at,
                    status="pending" if fire_at > now else "cancelled",
                    created_at=now,
                    updated_at=now,
                )
            )
            continue
        if user_id == actor.id and tz and tz != row.tz:
            row.tz = tz
        fire_at = due_fire_at(task.due_on, row.tz)
        if fire_at != row.fire_at:
            row.fire_at = fire_at
            row.status = "pending" if fire_at > now else "cancelled"
            row.updated_at = now
        elif row.status == "cancelled" and fire_at > now:
            row.status = "pending"
            row.updated_at = now
    await db.flush()


# --- reading -------------------------------------------------------------------------------------


async def list_board(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, *, include_done: bool
) -> list[TaskOut]:
    channel, role = await _board_channel(db, actor, channel_id)
    rows = await repo.board(
        db, channel_id, actor.id, done_limit=None if include_done else BOARD_DONE_LIMIT
    )
    return await _outs(db, actor, _order(rows), {channel.id: (channel, role)})


async def list_mine(db: AsyncSession, actor: User) -> list[TaskOut]:
    """My own tasks and the shared ones assigned to me; of the completed, the 50 most recent."""
    joined = await _joined(db, actor)
    channel_ids = list(joined)
    rows = await repo.personal(db, actor.id, done=False, limit=MAX_OPEN_PER_BOARD)
    rows += await repo.assigned_to(db, actor.id, channel_ids, done=False, limit=MAX_DUE_TASKS)
    done = await repo.personal(db, actor.id, done=True, limit=MINE_DONE_LIMIT)
    done += await repo.assigned_to(db, actor.id, channel_ids, done=True, limit=MINE_DONE_LIMIT)
    done.sort(key=lambda t: (t.completed_at or t.updated_at, t.id), reverse=True)
    return await _outs(db, actor, _order(rows + done[:MINE_DONE_LIMIT]), joined)


async def list_requested(db: AsyncSession, actor: User) -> list[TaskOut]:
    """L9 (REVIEWS.md §2.3): shared tasks I made with someone else assigned (my requests) in the
    conversations I am in; open ones by due date, then the 50 most recently completed."""
    joined = await _joined(db, actor)
    rows = await repo.requested_by(db, actor.id, list(joined), done=False, limit=MAX_DUE_TASKS)
    done = await repo.requested_by(db, actor.id, list(joined), done=True, limit=MINE_DONE_LIMIT)
    return await _outs(db, actor, rows + done, joined)


async def list_due(db: AsyncSession, actor: User, start: date, end: date) -> list[TaskOut]:
    """Tasks I can see due in [start, end): mine and my channels' boards (the calendar)."""
    if end <= start or (end - start).days > MAX_DUE_RANGE_DAYS:
        raise bad_request(
            "task_invalid_range",
            f"`to` must be after `from`, at most {MAX_DUE_RANGE_DAYS} days later",
        )
    joined = await _joined(db, actor)
    rows = await repo.due_between(db, actor.id, list(joined), start, end, MAX_DUE_TASKS)
    return await _outs(db, actor, rows, joined)


async def get_task(db: AsyncSession, actor: User, task_id: uuid.UUID) -> TaskOut:
    seen = await _load(db, actor, task_id)
    assignees = (await repo.assignees_of(db, [task_id])).get(task_id, [])
    return to_out(seen, actor, assignees)


# --- changes -------------------------------------------------------------------------------------


async def _can_read(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> bool:
    """A conversation's messages: its members, and a public channel's everyone but a guest."""
    if await channels.membership_of(db, actor.id, channel_id) is not None:
        return True
    channel = await channels.require_channel(db, channel_id)
    return channel.type == "public" and not actor.is_guest


async def _source(
    db: AsyncSession, actor: User, message_id: uuid.UUID, channel: Channel | None
) -> tuple[uuid.UUID, uuid.UUID, str]:
    """The message a task is made from: one the actor can read (else 404, like a message they
    cannot see); a board's task only from a message of that channel (its excerpt is shown to the
    board's members)."""
    message = await messages.find_message(db, message_id)
    if message is None:
        raise not_found("message_not_found", "Message not found")
    if not await _can_read(db, actor, message.channel_id):
        raise not_found("message_not_found", "Message not found")
    if channel is not None and message.channel_id != channel.id:
        raise bad_request(
            "task_invalid_source", "A board's task can only be made from a message of its channel"
        )
    excerpt = await messages.one_line(db, message, await channels.visible_user_ids(db, actor))
    return message.id, message.channel_id, excerpt


async def create(db: AsyncSession, actor: User, data: TaskCreate) -> tuple[TaskOut, bool]:
    """A new task. A retry with the same client_task_id returns the task the first request made
    (False)."""
    actor_id = actor.id  # instances expire on rollback
    if data.client_task_id is not None:
        existing = await repo.by_client_id(db, actor_id, data.client_task_id)
        if existing is not None:  # (404 if it was deleted since)
            return await get_task(db, actor, existing.id), False
    channel: Channel | None = None
    role: str | None = None
    if data.kind == "review" and data.source_message_id is None:
        raise bad_request("task_invalid_source", "A review request is made from a message")
    if data.channel_id is not None:
        channel, role = await _board_channel(
            db, actor, data.channel_id, from_message=data.source_message_id is not None
        )
        _require_poster(actor, channel, role)
    await _check_assignees(db, channel, data.assignee_ids)
    source = (
        await _source(db, actor, data.source_message_id, channel)
        if data.source_message_id is not None
        else None
    )
    if (
        data.status != "done"
        and await repo.count_open(db, data.channel_id, actor_id) >= MAX_OPEN_PER_BOARD
    ):
        raise conflict(
            "task_limit_reached", f"A board holds at most {MAX_OPEN_PER_BOARD} open tasks"
        )
    now = utcnow()
    task = Task(
        channel_id=data.channel_id,
        owner_id=actor_id,
        title=data.title,
        notes=data.notes,
        status=data.status,
        kind=data.kind,
        due_on=data.due_on,
        source_message_id=source[0] if source else None,
        source_channel_id=source[1] if source else None,
        source_excerpt=source[2] if source else None,
        completed_at=now if data.status == "done" else None,
        completed_by=actor_id if data.status == "done" else None,
        client_task_id=data.client_task_id,
        created_at=now,
        updated_at=now,
    )
    task.position = await _default_position(db, data.channel_id, actor_id, data.status)
    db.add(task)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()  # a concurrent retry won: answer with its task
        if data.client_task_id is None:
            raise
        await db.refresh(actor)
        existing = await repo.by_client_id(db, actor_id, data.client_task_id)
        if existing is None:
            raise
        return await get_task(db, actor, existing.id), False
    assignees = list(data.assignee_ids)
    if assignees:
        await repo.set_assignees(db, task.id, [], assignees)
    await _sync_alarms(db, task, assignees, actor, data.tz, now)
    await _emit_updated(db, task, channel, assignees)
    if channel is not None:
        await _emit_assigned(db, task, channel, actor_id, assignees)
    await _announce_source(db, task)
    await db.commit()
    return to_out(_Seen(task, channel, role), actor, assignees), True


async def update(db: AsyncSession, actor: User, task_id: uuid.UUID, data: TaskUpdate) -> TaskOut:
    seen = await _load(db, actor, task_id, lock=True)
    _require_editor(actor, seen)
    task = seen.task
    sent = data.model_fields_set
    # What the chip under its message shows, before anything changes (L9, REVIEWS.md §2.2).
    shown_before = (task.status, task.due_on)
    current = (await repo.assignees_of(db, [task.id])).get(task.id, [])
    assignees = current
    if "assignee_ids" in sent:
        assignees = list(data.assignee_ids or [])
        await _check_assignees(db, seen.channel, assignees)
    if "title" in sent:
        if data.title is None:
            raise bad_request("validation_error", "A title cannot be null")
        task.title = data.title
    if "notes" in sent:
        task.notes = data.notes
    if "due_on" in sent:
        task.due_on = data.due_on
    now = utcnow()
    renumbered: list[Task] = []
    if "status" in sent and data.status is not None and data.status != task.status:
        if data.status != "done" and task.status == "done":
            await _check_room(db, task)
        renumbered = await _place(db, task, data.status, None, None)
        _set_status(task, data.status, actor.id, now)
        if data.status == "done":
            await _emit_review_done(db, task, seen.channel, actor.id)
    task.updated_at = now
    if assignees != current:
        await repo.set_assignees(db, task.id, current, assignees)
    await db.flush()
    await _sync_alarms(db, task, assignees, actor, data.tz, now)
    await _emit_changes(db, task, seen.channel, assignees, renumbered)
    if seen.channel is not None:
        added = [uid for uid in assignees if uid not in current]
        await _emit_assigned(db, task, seen.channel, actor.id, added)
    if (task.status, task.due_on) != shown_before or assignees != current:
        await _announce_source(db, task)
    await db.commit()
    return to_out(seen, actor, assignees)


async def _check_room(db: AsyncSession, task: Task) -> None:
    if await repo.count_open(db, task.channel_id, task.owner_id) >= MAX_OPEN_PER_BOARD:
        raise conflict(
            "task_limit_reached", f"A board holds at most {MAX_OPEN_PER_BOARD} open tasks"
        )


async def _emit_changes(
    db: AsyncSession,
    task: Task,
    channel: Channel | None,
    assignee_ids: list[uuid.UUID],
    renumbered: list[Task],
) -> None:
    """task.updated for the task and for each card a renumbering moved."""
    if renumbered:
        others = await repo.assignees_of(db, [t.id for t in renumbered])
        for card in renumbered:
            await _emit_updated(db, card, channel, others.get(card.id, []))
    await _emit_updated(db, task, channel, assignee_ids)


async def move(db: AsyncSession, actor: User, task_id: uuid.UUID, data: TaskMove) -> TaskOut:
    """To a column and between two cards there (TASKS.md §3)."""
    seen = await _load(db, actor, task_id, lock=True)
    _require_editor(actor, seen)
    task = seen.task
    if data.status != "done" and task.status == "done":
        await _check_room(db, task)
    now = utcnow()
    renumbered = await _place(db, task, data.status, data.after_id, data.before_id)
    status_changed = data.status != task.status
    _set_status(task, data.status, actor.id, now)
    task.updated_at = now
    await db.flush()
    assignees = (await repo.assignees_of(db, [task.id])).get(task.id, [])
    if status_changed:
        await _sync_alarms(db, task, assignees, actor, None, now)
    await _emit_changes(db, task, seen.channel, assignees, renumbered)
    if status_changed:
        if data.status == "done":
            await _emit_review_done(db, task, seen.channel, actor.id)
        await _announce_source(db, task)
    await db.commit()
    return to_out(seen, actor, assignees)


async def delete(db: AsyncSession, actor: User, task_id: uuid.UUID) -> None:
    """Soft delete (the event tells the devices it is gone); its alarms are cancelled."""
    seen = await _load(db, actor, task_id, lock=True)
    assignees = (await repo.assignees_of(db, [task_id])).get(task_id, [])
    if seen.channel is not None:
        channels.require_writable(seen.channel)
    if not _can_delete(actor, seen, assignees):
        raise forbidden(
            "task_delete_restricted",
            "Only its creator, its assignees, the channel's owners and administrators delete it",
        )
    now = utcnow()
    task = seen.task
    task.deleted_at = now
    task.updated_at = now
    await _sync_alarms(db, task, assignees, actor, None, now)
    await _emit_deleted(db, task)
    await db.flush()
    await _announce_source(db, task)
    await db.commit()


# --- the worker and the push planner -------------------------------------------------------------


async def _still_notified(
    db: AsyncSession, task: Task, user_id: uuid.UUID
) -> tuple[bool, Channel | None]:
    """Whether the person is still to be told about the task, and its channel (None for a
    personal task). An archived channel's tasks stay silent (nobody can complete them)."""
    if task.channel_id is None:
        return task.owner_id == user_id, None
    if await channels.membership_of(db, user_id, task.channel_id) is None:
        return False, None
    if user_id not in (await repo.assignees_of(db, [task.id])).get(task.id, []):
        return False, None
    channel = await channels.require_channel(db, task.channel_id)
    return not channel.is_archived, channel


async def fire_due(db: AsyncSession, *, now: datetime | None = None, limit: int = 50) -> int:
    """Marks due alarms fired; task.due carries each to the push planner. One whose task is gone,
    done, moved to another day or no longer the person's is cancelled without a word."""
    moment = now or utcnow()
    fired = 0
    for alarm in await repo.due_alarms(db, moment, limit):
        alarm.updated_at = moment
        task = await repo.get(db, alarm.task_id)
        if (
            task is None
            or task.is_deleted
            or task.status == "done"
            or task.due_on is None
            or due_fire_at(task.due_on, alarm.tz) != alarm.fire_at
        ):
            alarm.status = "cancelled"
            continue
        notified, channel = await _still_notified(db, task, alarm.user_id)
        if not notified:
            alarm.status = "cancelled"
            continue
        alarm.status = "fired"
        data = TaskDueData(
            task_id=task.id,
            channel_id=task.channel_id,
            channel_name=channel.name if channel is not None else None,
            title=task.title,
            due_on=task.due_on,
        )
        await write_outbox(
            db,
            event_type=TASK_DUE,
            audience_type="user",
            audience_id=alarm.user_id,
            channel_id=task.channel_id,
            payload=data.model_dump(mode="json"),
        )
        fired += 1
    await db.commit()
    return fired


async def still_open(db: AsyncSession, task_id: uuid.UUID) -> bool:
    """For the push planner: the task is still there and not done (an assignment push for a task
    deleted or completed in the meantime is dropped)."""
    task = await repo.get(db, task_id)
    return task is not None and not task.is_deleted and task.status != "done"


class TaskLeaveHandler:
    """OutboxHandler: channel.member_removed (the copy addressed to the person who left) takes
    them off that channel's tasks (task.updated for each) and cancels their due-date alarms
    there (TASKS.md §1, §5). Idempotent."""

    async def handle(self, db: AsyncSession, event: OutboxEvent, audience: Audience) -> None:
        if (
            event.event_type != CHANNEL_MEMBER_REMOVED
            or event.audience_type != "user"
            or event.channel_id is None
        ):
            return
        user_id = uuid.UUID(str(event.payload["user_id"]))
        if await channels.membership_of(db, user_id, event.channel_id) is not None:
            return  # back in the channel since
        now = utcnow()
        await db.execute(
            sql_update(TaskDueAlarm)
            .where(
                TaskDueAlarm.user_id == user_id,
                TaskDueAlarm.status == "pending",
                TaskDueAlarm.task_id.in_(
                    select(Task.id).where(Task.channel_id == event.channel_id)
                ),
            )
            .values(status="cancelled", updated_at=now)
            .execution_options(synchronize_session=False)
        )
        touched = await repo.unassign_in_channel(db, user_id, event.channel_id)
        if not touched:
            return
        channel = await channels.require_channel(db, event.channel_id)
        assignees = await repo.assignees_of(db, touched)
        for task_id in sorted(touched):
            task = await repo.get(db, task_id)
            if task is None or task.is_deleted:
                continue
            task.updated_at = now
            await _emit_updated(db, task, channel, assignees.get(task_id, []))
            await _announce_source(db, task)  # the chip loses the person who left


class TaskSourceHandler:
    """OutboxHandler: message.updated (a body edit) and message.deleted keep the excerpt of the
    tasks made from that message in step (SECURITY.md §3: no copy of an edited-away or deleted
    body stays behind). An edit refreshes it (a personal task whose owner can no longer read the
    message loses it); a deletion clears the link and the excerpt. task.updated for each task
    that changed. Idempotent."""

    async def handle(self, db: AsyncSession, event: OutboxEvent, audience: Audience) -> None:
        if event.event_type == MESSAGE_UPDATED:
            if event.payload.get("change") != "body":
                return
        elif event.event_type != MESSAGE_DELETED:
            return
        message_id = uuid.UUID(str((event.payload.get("message") or {})["id"]))
        rows = await repo.from_message(db, message_id)
        if not rows:
            return
        message = await messages.find_message(db, message_id)
        now = utcnow()
        for task in rows:
            if message is None:
                link, excerpt = None, None
            else:
                link = message.id
                owner = await users.get_user(db, task.owner_id)
                readable = owner is not None and await _can_read(db, owner, message.channel_id)
                excerpt = (
                    await messages.one_line(db, message, await channels.visible_user_ids(db, owner))
                    if owner is not None and readable
                    else None
                )
            if (task.source_message_id, task.source_excerpt) == (link, excerpt):
                continue
            task.source_message_id, task.source_excerpt = link, excerpt
            task.updated_at = now
            channel = (
                await channels.require_channel(db, task.channel_id) if task.channel_id else None
            )
            assignees = (await repo.assignees_of(db, [task.id])).get(task.id, [])
            await _emit_updated(db, task, channel, assignees)
