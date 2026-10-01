"""SQL of the ai module. Besides its own tables it reads `messages` (read-only, like `search`:
ARCHITECTURE.md §5) to build the conversation it sends."""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.ai.models import AiAgent, AiRun
from app.modules.messages.models import Message, timeline_filter

# --- agents -------------------------------------------------------------------------------------


async def get_agent(
    db: AsyncSession, agent_id: uuid.UUID, *, for_update: bool = False
) -> AiAgent | None:
    stmt = select(AiAgent).where(AiAgent.id == agent_id, AiAgent.deleted_at.is_(None))
    if for_update:
        stmt = stmt.with_for_update()
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_agent_any(db: AsyncSession, agent_id: uuid.UUID) -> AiAgent | None:
    return await db.get(AiAgent, agent_id)


async def list_agents(db: AsyncSession, *, enabled_only: bool = False) -> list[AiAgent]:
    """Live agents, oldest first (the first enabled one is the default for summaries)."""
    stmt = select(AiAgent).where(AiAgent.deleted_at.is_(None))
    if enabled_only:
        stmt = stmt.where(AiAgent.enabled.is_(True))
    stmt = stmt.order_by(AiAgent.created_at, AiAgent.id)
    return list((await db.execute(stmt)).scalars().all())


async def agents_for_bots(db: AsyncSession, bot_user_ids: list[uuid.UUID]) -> list[AiAgent]:
    """Live agents (enabled or not) whose bot is one of these users."""
    if not bot_user_ids:
        return []
    stmt = select(AiAgent).where(
        AiAgent.bot_user_id.in_(bot_user_ids), AiAgent.deleted_at.is_(None)
    )
    return list((await db.execute(stmt)).scalars().all())


# --- runs ---------------------------------------------------------------------------------------


async def get_run(db: AsyncSession, run_id: uuid.UUID, *, for_update: bool = False) -> AiRun | None:
    stmt = select(AiRun).where(AiRun.id == run_id).execution_options(populate_existing=True)
    if for_update:
        stmt = stmt.with_for_update()
    return (await db.execute(stmt)).scalar_one_or_none()


async def insert_run_once(db: AsyncSession, values: dict[str, object]) -> uuid.UUID | None:
    """A run for a source message, unless that message already has one of this kind (the
    outbox may deliver an event twice). The new id, or None."""
    stmt = (
        insert(AiRun)
        .values(**values)
        .on_conflict_do_nothing(
            index_elements=["kind", "source_message_id"],
            index_where=text("source_message_id IS NOT NULL"),
        )
        .returning(AiRun.id)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def has_run_for(db: AsyncSession, kind: str, source_message_id: uuid.UUID) -> bool:
    stmt = select(AiRun.id).where(AiRun.kind == kind, AiRun.source_message_id == source_message_id)
    return (await db.execute(stmt)).first() is not None


async def cost_between(db: AsyncSession, start: datetime, end: datetime) -> Decimal:
    stmt = select(func.coalesce(func.sum(AiRun.cost_usd), 0)).where(
        AiRun.created_at >= start, AiRun.created_at < end
    )
    return Decimal((await db.execute(stmt)).scalar_one())


async def runs_since(db: AsyncSession, requester_id: uuid.UUID, since: datetime) -> int:
    stmt = select(func.count()).where(AiRun.requester_id == requester_id, AiRun.created_at >= since)
    return int((await db.execute(stmt)).scalar_one())


async def recent_runs(
    db: AsyncSession, requester_id: uuid.UUID, kind: str | None, limit: int
) -> list[AiRun]:
    stmt = select(AiRun).where(AiRun.requester_id == requester_id)
    if kind is not None:
        stmt = stmt.where(AiRun.kind == kind)
    stmt = stmt.order_by(AiRun.created_at.desc(), AiRun.id.desc()).limit(limit)
    return list((await db.execute(stmt)).scalars().all())


_CLAIM = text(
    """
    UPDATE ai_runs SET
        status = 'running',
        attempts = attempts + 1,
        locked_until = :lease,
        next_attempt_at = NULL,
        started_at = COALESCE(started_at, :now)
    WHERE id IN (
        SELECT id FROM ai_runs
        WHERE (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= :now))
           OR (status = 'running' AND locked_until < :now)
        ORDER BY created_at
        LIMIT :limit
        FOR UPDATE SKIP LOCKED
    )
    RETURNING id
    """
)


async def claim(db: AsyncSession, now: datetime, lease: datetime, limit: int) -> list[uuid.UUID]:
    """Open runs (pending and due, or running with a lease that ran out: the process that held
    it died), marked running under a new lease, oldest first."""
    rows = await db.execute(_CLAIM, {"now": now, "lease": lease, "limit": limit})
    return [row[0] for row in rows.all()]


async def usage_by_agent(
    db: AsyncSession, start: datetime, end: datetime
) -> list[tuple[uuid.UUID, str, int, int, int, Decimal]]:
    stmt = (
        select(
            AiAgent.id,
            AiAgent.name,
            func.count(AiRun.id),
            func.coalesce(
                func.sum(AiRun.input_tokens + AiRun.cache_read_tokens + AiRun.cache_write_tokens), 0
            ),
            func.coalesce(func.sum(AiRun.output_tokens), 0),
            func.coalesce(func.sum(AiRun.cost_usd), 0),
        )
        .join(AiAgent, AiAgent.id == AiRun.agent_id)
        .where(AiRun.created_at >= start, AiRun.created_at < end)
        .group_by(AiAgent.id, AiAgent.name)
        .order_by(func.sum(AiRun.cost_usd).desc(), AiAgent.name)
    )
    return [
        (r[0], r[1], int(r[2]), int(r[3]), int(r[4]), Decimal(r[5]))
        for r in (await db.execute(stmt)).all()
    ]


async def usage_by_user(
    db: AsyncSession, start: datetime, end: datetime
) -> list[tuple[uuid.UUID, int, Decimal]]:
    stmt = (
        select(
            AiRun.requester_id,
            func.count(AiRun.id),
            func.coalesce(func.sum(AiRun.cost_usd), 0),
        )
        .where(AiRun.created_at >= start, AiRun.created_at < end)
        .group_by(AiRun.requester_id)
        .order_by(func.sum(AiRun.cost_usd).desc(), AiRun.requester_id)
    )
    return [(r[0], int(r[1]), Decimal(r[2])) for r in (await db.execute(stmt)).all()]


async def count_between(db: AsyncSession, start: datetime, end: datetime) -> int:
    stmt = select(func.count()).where(AiRun.created_at >= start, AiRun.created_at < end)
    return int((await db.execute(stmt)).scalar_one())


async def purge_inputs(db: AsyncSession, before: datetime) -> int:
    result = await db.execute(
        update(AiRun)
        .where(AiRun.input.is_not(None), AiRun.created_at < before)
        .values(input=None)
        .execution_options(synchronize_session=False)
    )
    return int(result.rowcount or 0)  # type: ignore[attr-defined]


# --- messages (read-only) ----------------------------------------------------------------------


async def thread_upto(
    db: AsyncSession, parent_id: uuid.UUID, upto_seq: int | None
) -> list[Message]:
    """A thread's live parent and replies, oldest first (up to a seq when given)."""
    stmt = select(Message).where(
        (Message.id == parent_id) | (Message.parent_id == parent_id),
        Message.deleted_at.is_(None),
    )
    if upto_seq is not None:
        stmt = stmt.where(Message.seq <= upto_seq)
    stmt = stmt.order_by(Message.seq)
    return list((await db.execute(stmt)).scalars().all())


async def timeline_before(
    db: AsyncSession, channel_id: uuid.UUID, before_seq: int, limit: int
) -> list[Message]:
    """The channel timeline's last `limit` live messages before a seq, oldest first."""
    stmt = (
        select(Message)
        .where(
            Message.channel_id == channel_id,
            Message.seq < before_seq,
            Message.deleted_at.is_(None),
            timeline_filter(),
        )
        .order_by(Message.seq.desc())
        .limit(limit)
    )
    return list(reversed((await db.execute(stmt)).scalars().all()))


async def channel_range(
    db: AsyncSession,
    channel_id: uuid.UUID,
    *,
    after_seq: int | None,
    since: datetime | None,
    limit: int,
) -> tuple[list[Message], int]:
    """Live messages of a channel (replies included) after a seq or since a time: the newest
    `limit`, oldest first, and how many there are in all."""
    conditions = [Message.channel_id == channel_id, Message.deleted_at.is_(None)]
    if after_seq is not None:
        conditions.append(Message.seq > after_seq)
    if since is not None:
        conditions.append(Message.created_at >= since)
    total = int((await db.execute(select(func.count()).where(*conditions))).scalar_one())
    stmt = select(Message).where(*conditions).order_by(Message.seq.desc()).limit(limit)
    rows = list((await db.execute(stmt)).scalars().all())
    return list(reversed(rows)), total
