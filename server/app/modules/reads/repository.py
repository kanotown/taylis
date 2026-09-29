import uuid
from datetime import datetime

from sqlalchemy import BigInteger, ColumnElement, Uuid, and_, column, func, select, values
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.modules.messages.models import (  # read-only (ARCHITECTURE.md §5 exception)
    Message,
    mentions_of,
    timeline_filter,
)
from app.modules.reads.models import ReadState


async def get(db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID) -> ReadState | None:
    return await db.get(ReadState, (user_id, channel_id))


async def initialize(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, last_read_seq: int
) -> None:
    """Joining: history before the join is not unread. A row kept from an earlier membership
    (leaving keeps it, DATA_MODEL.md) moves forward to the same point: what was posted while the
    person was away is history to them, not a year of unread."""
    stmt = pg_insert(ReadState).values(
        user_id=user_id, channel_id=channel_id, last_read_seq=last_read_seq
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["user_id", "channel_id"],
        set_={
            "last_read_seq": func.greatest(ReadState.last_read_seq, stmt.excluded.last_read_seq),
            "updated_at": utcnow(),
        },
    )
    await db.execute(stmt)


async def advance(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, seq: int
) -> tuple[int, bool]:
    """Monotonic: (last_read_seq after the call, whether it moved)."""
    row = await db.get(ReadState, (user_id, channel_id), with_for_update=True)
    if row is not None:
        if seq <= row.last_read_seq:
            return row.last_read_seq, False
        row.last_read_seq = seq
        row.updated_at = utcnow()
        await db.flush()
        return seq, True
    # No row yet: an upsert, so two devices making the first one at once (a new DM read on both)
    # do not collide on the key; the later one only moves the position forward.
    insert = pg_insert(ReadState).values(user_id=user_id, channel_id=channel_id, last_read_seq=seq)
    upsert = insert.on_conflict_do_update(
        index_elements=["user_id", "channel_id"],
        set_={"last_read_seq": seq, "updated_at": utcnow()},
        where=ReadState.last_read_seq < seq,
    ).returning(ReadState.last_read_seq)
    moved = (await db.execute(upsert)).scalar_one_or_none()
    if moved is not None:
        return int(moved), True
    return await _current(db, user_id, channel_id), False


async def set_position(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, seq: int
) -> tuple[int, bool]:
    """Exact position, may move backwards (mark as unread): (last_read_seq, whether it changed)."""
    row = await db.get(ReadState, (user_id, channel_id), with_for_update=True)
    if row is not None:
        if row.last_read_seq == seq:
            return seq, False
        row.last_read_seq = seq
        row.updated_at = utcnow()
        await db.flush()
        return seq, True
    insert = pg_insert(ReadState).values(user_id=user_id, channel_id=channel_id, last_read_seq=seq)
    upsert = insert.on_conflict_do_update(
        index_elements=["user_id", "channel_id"],
        set_={"last_read_seq": seq, "updated_at": utcnow()},
        where=ReadState.last_read_seq != seq,
    ).returning(ReadState.last_read_seq)
    changed = (await db.execute(upsert)).scalar_one_or_none()
    return seq, changed is not None


async def _current(db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID) -> int:
    stmt = select(ReadState.last_read_seq).where(
        ReadState.user_id == user_id, ReadState.channel_id == channel_id
    )
    return int((await db.execute(stmt)).scalar_one())


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


def _counted(user_id: uuid.UUID) -> list[ColumnElement[bool]]:
    """The rows that are unread for the user (DATA_MODEL.md: no counters, derived from seq)."""
    return [
        Message.sender_id != user_id,  # my own posts are never unread (replies no longer read)
        timeline_filter(),  # replies count only when also sent to the channel (M15c)
        Message.deleted_at.is_(None),
        Message.type == "user",
    ]


async def counts(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, last_read_seq: int
) -> tuple[int, int, datetime | None]:
    """(unread, mentions, first_unread_at) derived from seq ranges (DATA_MODEL.md: no counters).

    first_unread_at is the oldest counted message's created_at, from the same aggregate.
    """
    mentioned = mentions_of(Message, user_id)
    stmt = select(func.count(), func.count().filter(mentioned), func.min(Message.created_at)).where(
        Message.channel_id == channel_id, Message.seq > last_read_seq, *_counted(user_id)
    )
    unread, mentions, first_unread_at = (await db.execute(stmt)).one()
    return int(unread), int(mentions), first_unread_at


async def counts_for_user(
    db: AsyncSession, user_id: uuid.UUID, positions: dict[uuid.UUID, int]
) -> dict[uuid.UUID, tuple[int, int, datetime | None]]:
    """`counts` for every channel of `positions` ({channel_id: last_read_seq}) in one query
    (bootstrap, the summary and each push's badge used to ask once per channel). Channels with
    nothing unread are absent."""
    if not positions:
        return {}
    wanted = values(
        column("channel_id", Uuid), column("last_read_seq", BigInteger), name="positions"
    ).data(list(positions.items()))
    mentioned = mentions_of(Message, user_id)
    stmt = (
        select(
            wanted.c.channel_id,
            func.count(),
            func.count().filter(mentioned),
            func.min(Message.created_at),
        )
        .select_from(wanted)
        .join(
            Message,
            and_(
                Message.channel_id == wanted.c.channel_id,
                Message.seq > wanted.c.last_read_seq,
                *_counted(user_id),
            ),
        )
        .group_by(wanted.c.channel_id)
    )
    return {row[0]: (int(row[1]), int(row[2]), row[3]) for row in (await db.execute(stmt)).all()}
