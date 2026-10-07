import uuid
from datetime import datetime

from sqlalchemy import ColumnElement, and_, delete, exists, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.channels.models import ChannelMember  # read-only (ARCHITECTURE.md §5 exception)
from app.modules.dm_closes.models import ConversationClose
from app.modules.messages.models import Message, timeline_filter  # read-only (same)


def _still_closed() -> ColumnElement[bool]:
    """No timeline message (top level or also_in_channel) after the closing point: one would
    reopen the conversation."""
    return ~exists().where(
        Message.channel_id == ConversationClose.channel_id,
        Message.seq > ConversationClose.closed_seq,
        timeline_filter(),
    )


async def is_closed(db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID) -> bool:
    stmt = select(ConversationClose.channel_id).where(
        ConversationClose.user_id == user_id,
        ConversationClose.channel_id == channel_id,
        _still_closed(),
    )
    return (await db.execute(stmt)).first() is not None


async def upsert(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, closed_seq: int, at: datetime
) -> None:
    stmt = pg_insert(ConversationClose).values(
        user_id=user_id, channel_id=channel_id, closed_seq=closed_seq, closed_at=at
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["user_id", "channel_id"],
        set_={"closed_seq": stmt.excluded.closed_seq, "closed_at": stmt.excluded.closed_at},
    )
    await db.execute(stmt)


async def remove(db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID) -> None:
    await db.execute(
        delete(ConversationClose).where(
            ConversationClose.user_id == user_id, ConversationClose.channel_id == channel_id
        )
    )


async def closed_channel_ids(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    """Conversations the user closed, still belongs to, and nobody wrote in since (a close
    survives leaving a group DM, but is not shown). Oldest close first."""
    stmt = (
        select(ConversationClose.channel_id)
        .join(
            ChannelMember,
            and_(
                ChannelMember.channel_id == ConversationClose.channel_id,
                ChannelMember.user_id == ConversationClose.user_id,
            ),
        )
        .where(ConversationClose.user_id == user_id, _still_closed())
        .order_by(ConversationClose.closed_at, ConversationClose.channel_id)
    )
    return list((await db.execute(stmt)).scalars().all())
