import uuid
from datetime import date, datetime

from sqlalchemy import ColumnElement, and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.tasks.models import Task, TaskAssignee, TaskDueAlarm


async def get(db: AsyncSession, task_id: uuid.UUID, *, lock: bool = False) -> Task | None:
    stmt = select(Task).where(Task.id == task_id)
    if lock:
        stmt = stmt.with_for_update()
    return (await db.execute(stmt)).scalar_one_or_none()


async def by_client_id(db: AsyncSession, owner_id: uuid.UUID, client_task_id: str) -> Task | None:
    stmt = select(Task).where(Task.owner_id == owner_id, Task.client_task_id == client_task_id)
    return (await db.execute(stmt)).scalar_one_or_none()


def _board(channel_id: uuid.UUID | None, owner_id: uuid.UUID) -> ColumnElement[bool]:
    """The live tasks of a channel's board, or of someone's own list."""
    if channel_id is not None:
        return and_(Task.channel_id == channel_id, Task.deleted_at.is_(None))
    return and_(Task.channel_id.is_(None), Task.owner_id == owner_id, Task.deleted_at.is_(None))


async def column(
    db: AsyncSession,
    channel_id: uuid.UUID | None,
    owner_id: uuid.UUID,
    status: str,
    *,
    lock: bool = False,
) -> list[Task]:
    """One column of a board in order (position, then id for ties)."""
    stmt = (
        select(Task)
        .where(_board(channel_id, owner_id), Task.status == status)
        .order_by(Task.position, Task.id)
    )
    if lock:
        stmt = stmt.with_for_update()
    return list((await db.execute(stmt)).scalars().all())


async def column_edge(
    db: AsyncSession, channel_id: uuid.UUID | None, owner_id: uuid.UUID, status: str, *, top: bool
) -> float | None:
    """The smallest (top) or largest position in a column; None when it is empty."""
    agg = func.min(Task.position) if top else func.max(Task.position)
    stmt = select(agg).where(_board(channel_id, owner_id), Task.status == status)
    value = (await db.execute(stmt)).scalar_one_or_none()
    return float(value) if value is not None else None


async def count_open(db: AsyncSession, channel_id: uuid.UUID | None, owner_id: uuid.UUID) -> int:
    stmt = (
        select(func.count())
        .select_from(Task)
        .where(_board(channel_id, owner_id), Task.status != "done")
    )
    return int((await db.execute(stmt)).scalar_one())


async def board(
    db: AsyncSession,
    channel_id: uuid.UUID | None,
    owner_id: uuid.UUID,
    *,
    done_limit: int | None,
) -> list[Task]:
    """Every open task of a board and its completed ones (the most recent `done_limit`)."""
    open_rows = select(Task).where(_board(channel_id, owner_id), Task.status != "done")
    rows = list((await db.execute(open_rows)).scalars().all())
    done = (
        select(Task)
        .where(_board(channel_id, owner_id), Task.status == "done")
        .order_by(Task.completed_at.desc(), Task.id.desc())
    )
    if done_limit is not None:
        done = done.limit(done_limit)
    rows += list((await db.execute(done)).scalars().all())
    return rows


async def assigned_to(
    db: AsyncSession, user_id: uuid.UUID, channel_ids: list[uuid.UUID], *, done: bool, limit: int
) -> list[Task]:
    """Shared tasks assigned to someone in the given channels: open ones, or the most recently
    completed `limit`."""
    if not channel_ids:
        return []
    stmt = (
        select(Task)
        .join(TaskAssignee, TaskAssignee.task_id == Task.id)
        .where(
            TaskAssignee.user_id == user_id,
            Task.channel_id.in_(channel_ids),
            Task.deleted_at.is_(None),
            Task.status == "done" if done else Task.status != "done",
        )
    )
    if done:
        stmt = stmt.order_by(Task.completed_at.desc(), Task.id.desc())
    return list((await db.execute(stmt.limit(limit))).scalars().all())


async def personal(db: AsyncSession, owner_id: uuid.UUID, *, done: bool, limit: int) -> list[Task]:
    stmt = select(Task).where(
        _board(None, owner_id), Task.status == "done" if done else Task.status != "done"
    )
    if done:
        stmt = stmt.order_by(Task.completed_at.desc(), Task.id.desc())
    return list((await db.execute(stmt.limit(limit))).scalars().all())


async def due_between(
    db: AsyncSession,
    owner_id: uuid.UUID,
    channel_ids: list[uuid.UUID],
    first: date,
    end: date,
    limit: int,
) -> list[Task]:
    """Live tasks due in [first, end): my own and those of the given channels."""
    whose = [and_(Task.channel_id.is_(None), Task.owner_id == owner_id)]
    if channel_ids:
        whose.append(Task.channel_id.in_(channel_ids))
    stmt = (
        select(Task)
        .where(
            Task.deleted_at.is_(None),
            Task.due_on >= first,
            Task.due_on < end,
            or_(*whose),
        )
        .order_by(Task.due_on, Task.status, Task.position, Task.id)
        .limit(limit)
    )
    return list((await db.execute(stmt)).scalars().all())


async def from_message(db: AsyncSession, message_id: uuid.UUID) -> list[Task]:
    """The live tasks made from a message, locked (TaskSourceHandler)."""
    stmt = (
        select(Task)
        .where(Task.source_message_id == message_id, Task.deleted_at.is_(None))
        .order_by(Task.id)
        .with_for_update()
    )
    return list((await db.execute(stmt)).scalars().all())


async def assignees_of(
    db: AsyncSession, task_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[uuid.UUID]]:
    if not task_ids:
        return {}
    stmt = (
        select(TaskAssignee.task_id, TaskAssignee.user_id)
        .where(TaskAssignee.task_id.in_(task_ids))
        .order_by(TaskAssignee.created_at, TaskAssignee.user_id)
    )
    out: dict[uuid.UUID, list[uuid.UUID]] = {}
    for task_id, user_id in (await db.execute(stmt)).all():
        out.setdefault(task_id, []).append(user_id)
    return out


async def set_assignees(
    db: AsyncSession, task_id: uuid.UUID, current: list[uuid.UUID], wanted: list[uuid.UUID]
) -> None:
    gone = [uid for uid in current if uid not in wanted]
    if gone:
        await db.execute(
            delete(TaskAssignee).where(
                TaskAssignee.task_id == task_id, TaskAssignee.user_id.in_(gone)
            )
        )
    for uid in wanted:
        if uid not in current:
            db.add(TaskAssignee(task_id=task_id, user_id=uid))
    await db.flush()


async def unassign_in_channel(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID
) -> list[uuid.UUID]:
    """Someone left a channel: they come off its tasks (TASKS.md §1). The tasks touched."""
    tasks = select(Task.id).where(Task.channel_id == channel_id)
    result = await db.execute(
        delete(TaskAssignee)
        .where(TaskAssignee.user_id == user_id, TaskAssignee.task_id.in_(tasks))
        .returning(TaskAssignee.task_id)
    )
    return [row[0] for row in result.all()]


async def alarms_of_task(db: AsyncSession, task_id: uuid.UUID) -> list[TaskDueAlarm]:
    stmt = (
        select(TaskDueAlarm)
        .where(TaskDueAlarm.task_id == task_id)
        .order_by(TaskDueAlarm.user_id)
        .with_for_update()
    )
    return list((await db.execute(stmt)).scalars().all())


async def alarm(db: AsyncSession, task_id: uuid.UUID, user_id: uuid.UUID) -> TaskDueAlarm | None:
    return await db.get(TaskDueAlarm, (task_id, user_id))


async def due_alarms(db: AsyncSession, now: datetime, limit: int) -> list[TaskDueAlarm]:
    stmt = (
        select(TaskDueAlarm)
        .where(TaskDueAlarm.status == "pending", TaskDueAlarm.fire_at <= now)
        .order_by(TaskDueAlarm.fire_at.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    return list((await db.execute(stmt)).scalars().all())
