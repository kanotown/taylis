"""Pinned DMs (M118). A member pins a DM or group DM (the self-DM too) so that it stays at the top
of their DM list; a change fans out to the user's own devices as dm_pin.updated (outbox, audience
user). Channels cannot be pinned this way (they have favorites)."""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import conflict
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.channels import service as channels
from app.modules.dm_pins import repository as repo
from app.modules.dm_pins.events import DM_PIN_UPDATED, DmPinUpdatedData
from app.modules.dm_pins.schemas import DmPinStateOut
from app.modules.users.models import User


async def set_pinned(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, *, pinned: bool
) -> tuple[DmPinStateOut, bool]:
    """Idempotent: pinning a pinned DM keeps its place, unpinning an unpinned one changes
    nothing; only a change is announced."""
    channel, _ = await channels.require_member(db, actor.id, channel_id)
    if not channel.is_dm:
        raise conflict("dm_pin_not_dm", "Only direct messages can be pinned")
    changed = (
        await repo.add(db, actor.id, channel.id)
        if pinned
        else await repo.remove(db, actor.id, channel.id)
    )
    if changed:
        await _announce(db, actor.id, channel.id, pinned)
    await db.commit()
    return DmPinStateOut(channel_id=channel.id, pinned=pinned), changed


async def _announce(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, pinned: bool
) -> None:
    await write_outbox(
        db,
        event_type=DM_PIN_UPDATED,
        audience_type="user",
        audience_id=user_id,
        channel_id=channel_id,
        payload=DmPinUpdatedData(channel_id=channel_id, pinned=pinned, at=utcnow()).model_dump(
            mode="json"
        ),
    )


async def unpin_in_tx(db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID) -> bool:
    """M141: closing a DM unpins it (dm_pin.updated when it was pinned). The caller commits."""
    changed = await repo.remove(db, user_id, channel_id)
    if changed:
        await _announce(db, user_id, channel_id, False)
    return changed


async def ids_for(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    return await repo.member_channel_ids(db, user_id)
