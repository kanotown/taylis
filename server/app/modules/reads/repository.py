import uuid

from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.modules.messages.models import Message  # read-only (ARCHITECTURE.md §5 exception)
from app.modules.reads.models import ReadState


async def get(db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID) -> ReadState | None:
    return await db.get(ReadState, (user_id, channel_id))


async def initialize(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, last_read_seq: int
) -> None:
    """Joining: history before the join is not unread. Existing rows (re-join) are kept."""
    stmt = (
        pg_insert(ReadState)
        .values(user_id=user_id, channel_id=channel_id, last_read_seq=last_read_seq)
        .on_conflict_do_nothing(index_elements=["user_id", "channel_id"])
    )
    await db.execute(stmt)


async def advance(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, seq: int
) -> tuple[int, bool]:
    """Monotonic: (last_read_seq after the call, whether it moved)."""
    row = await db.get(ReadState, (user_id, channel_id), with_for_update=True)
    if row is None:
        db.add(ReadState(user_id=user_id, channel_id=channel_id, last_read_seq=seq))
        await db.flush()
        return seq, True
    if seq <= row.last_read_seq:
        return row.last_read_seq, False
    row.last_read_seq = seq
    row.updated_at = utcnow()
    await db.flush()
    return seq, True


async def last_read_seqs(
    db: AsyncSession, user_ids: list[uuid.UUID], channel_id: uuid.UUID
) -> dict[uuid.UUID, int]:
    if not user_ids:
        return {}
    stmt = select(ReadState.user_id, ReadState.last_read_seq).where(
        ReadState.channel_id == channel_id, ReadState.user_id.in_(user_ids)
    )
    return {user_id: int(seq) for user_id, seq in (await db.execute(stmt)).all()}


async def states_for_user(
    db: AsyncSession, user_id: uuid.UUID, channel_ids: list[uuid.UUID]
) -> dict[uuid.UUID, int]:
    if not channel_ids:
        return {}
    stmt = select(ReadState.channel_id, ReadState.last_read_seq).where(
        ReadState.user_id == user_id, ReadState.channel_id.in_(channel_ids)
    )
    return {channel_id: int(seq) for channel_id, seq in (await db.execute(stmt)).all()}


async def counts(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, last_read_seq: int
) -> tuple[int, int]:
    """(unread, mentions) derived from seq ranges (DATA_MODEL.md: no counters to keep in sync)."""
    mentioned = or_(Message.mentioned_user_ids.contains([user_id]), Message.mention_all.is_(True))
    stmt = select(func.count(), func.count().filter(mentioned)).where(
        Message.channel_id == channel_id,
        Message.seq > last_read_seq,
        Message.deleted_at.is_(None),
        Message.type == "user",
    )
    unread, mentions = (await db.execute(stmt)).one()
    return int(unread), int(mentions)
