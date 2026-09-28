"""Read positions and unread counts (DATA_MODEL.md "read_states", SYNC_PROTOCOL.md §10).

A leaf module: callers (channels, messages, notifications, sync) pass ids they already
authorised. The channel row is passed in where the clamp to ``last_seq`` is needed.
"""

import uuid
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.events.outbox import write_outbox
from app.modules.reads import repository as repo
from app.modules.reads.events import READ_UPDATED, ReadUpdatedData
from app.modules.reads.schemas import ReadStateOut


async def initialize_in_tx(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, last_seq: int
) -> None:
    await repo.initialize(db, user_id, channel_id, last_seq)


async def _state(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, last_read_seq: int
) -> ReadStateOut:
    unread, mentions, first_unread_at = await repo.counts(db, user_id, channel_id, last_read_seq)
    return ReadStateOut(
        last_read_seq=last_read_seq,
        unread_count=unread,
        mention_count=mentions,
        first_unread_at=first_unread_at,
    )


async def state_for(db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID) -> ReadStateOut:
    row = await repo.get(db, user_id, channel_id)
    return await _state(db, user_id, channel_id, row.last_read_seq if row else 0)


async def states_for_user(
    db: AsyncSession, user_id: uuid.UUID, channel_ids: list[uuid.UUID]
) -> dict[uuid.UUID, ReadStateOut]:
    positions = await repo.states_for_user(db, user_id, channel_ids)
    result: dict[uuid.UUID, ReadStateOut] = {}
    for channel_id in channel_ids:
        result[channel_id] = await _state(db, user_id, channel_id, positions.get(channel_id, 0))
    return result


async def last_read_seqs(
    db: AsyncSession, user_ids: list[uuid.UUID], channel_id: uuid.UUID
) -> dict[uuid.UUID, int]:
    return await repo.last_read_seqs(db, user_ids, channel_id)


async def is_read(db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, seq: int) -> bool:
    row = await repo.get(db, user_id, channel_id)
    return row is not None and row.last_read_seq >= seq


async def advance_in_tx(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, seq: int, *, last_seq: int
) -> ReadStateOut:
    """GREATEST(current, min(seq, last_seq)); emits read.updated to the user's devices on change."""
    last_read_seq, changed = await repo.advance(db, user_id, channel_id, min(seq, last_seq))
    return await _state_after_change(db, user_id, channel_id, last_read_seq, changed, "advance")


async def set_in_tx(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, seq: int, *, last_seq: int
) -> ReadStateOut:
    """Exact position clamped to [0, last_seq] (mark as unread); devices follow via read.updated."""
    last_read_seq, changed = await repo.set_position(db, user_id, channel_id, min(seq, last_seq))
    return await _state_after_change(db, user_id, channel_id, last_read_seq, changed, "set")


async def _state_after_change(
    db: AsyncSession,
    user_id: uuid.UUID,
    channel_id: uuid.UUID,
    last_read_seq: int,
    changed: bool,
    reason: Literal["advance", "set"],
) -> ReadStateOut:
    state = await _state(db, user_id, channel_id, last_read_seq)
    if changed:
        await write_outbox(
            db,
            event_type=READ_UPDATED,
            audience_type="user",
            audience_id=user_id,
            channel_id=channel_id,
            payload=ReadUpdatedData(
                channel_id=channel_id, reason=reason, **state.model_dump()
            ).model_dump(mode="json"),
        )
    return state
