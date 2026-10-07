"""Closed DMs (M141, Slack's 「会話を閉じる」). A member closes a DM or group DM (the self-DM too):
it disappears from their DM lists (every place of the sidebar, the DM tab, the home's DM section),
nothing is deleted and the other members see nothing. Closing marks it read and unpins it (a pin
says "keep it in sight"); a star or a sidebar section is kept, so a reopened conversation comes
back where it was filed.

It reopens by itself when a timeline message newer than the closing point arrives (computed on
read, no write), and explicitly when I open it (`DELETE /channels/{id}/close`) or resolve the DM
again (`POST /dms`, through the hook registered on channels). Changes fan out to my own devices as
dm_close.updated (outbox, audience user); a reopening by a new message is not announced (every
device sees the message.created)."""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import conflict
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.dm_closes import repository as repo
from app.modules.dm_closes.events import DM_CLOSE_UPDATED, DmCloseUpdatedData
from app.modules.dm_closes.schemas import DmCloseStateOut
from app.modules.dm_pins import service as dm_pins
from app.modules.reads import service as reads
from app.modules.users.models import User


async def _announce(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, closed: bool
) -> None:
    await write_outbox(
        db,
        event_type=DM_CLOSE_UPDATED,
        audience_type="user",
        audience_id=user_id,
        channel_id=channel_id,
        payload=DmCloseUpdatedData(channel_id=channel_id, closed=closed, at=utcnow()).model_dump(
            mode="json"
        ),
    )


async def _require_dm(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> Channel:
    channel, _ = await channels.require_member(db, actor.id, channel_id)
    if not channel.is_dm:
        raise conflict("dm_close_not_dm", "Only direct messages can be closed")
    return channel


async def close(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> DmCloseStateOut:
    """Idempotent: closing a closed conversation moves the closing point to now; only a change
    is announced."""
    channel = await _require_dm(db, actor, channel_id)
    was_closed = await repo.is_closed(db, actor.id, channel.id)
    at = utcnow()
    await repo.upsert(db, actor.id, channel.id, channel.last_seq, at)
    # Read to its end (Slack), so no badge counts a hidden conversation.
    await reads.advance_in_tx(db, actor.id, channel.id, channel.last_seq, last_seq=channel.last_seq)
    await dm_pins.unpin_in_tx(db, actor.id, channel.id)
    if not was_closed:
        await _announce(db, actor.id, channel.id, True)
    await db.commit()
    return DmCloseStateOut(channel_id=channel.id, closed=True, closed_at=at)


async def reopen_in_tx(db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID) -> bool:
    """Forget the close; announce it when the conversation was still closed. The caller commits."""
    was_closed = await repo.is_closed(db, user_id, channel_id)
    await repo.remove(db, user_id, channel_id)
    if was_closed:
        await _announce(db, user_id, channel_id, False)
    return was_closed


async def reopen(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> DmCloseStateOut:
    channel = await _require_dm(db, actor, channel_id)
    await reopen_in_tx(db, actor.id, channel.id)
    await db.commit()
    return DmCloseStateOut(channel_id=channel.id, closed=False)


async def _reopen_resolved(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> None:
    await reopen_in_tx(db, actor.id, channel_id)
    await db.commit()


async def ids_for(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    return await repo.closed_channel_ids(db, user_id)


# POST /dms for an existing DM ("start a DM with them again") opens it; channels does not depend
# on dm_closes.
channels.set_dm_resolved_hook(_reopen_resolved)
