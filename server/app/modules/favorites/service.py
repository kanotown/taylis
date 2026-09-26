"""Starred channels (M12a). Only a member can star a channel; a change fans out to the user's
own devices as favorite.updated (outbox, audience user)."""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.events.outbox import write_outbox
from app.modules.channels import service as channels
from app.modules.favorites import repository as repo
from app.modules.favorites.events import FAVORITE_UPDATED, FavoriteUpdatedData
from app.modules.favorites.schemas import FavoriteStateOut
from app.modules.users.models import User


async def set_favorite(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, *, favorite: bool
) -> tuple[FavoriteStateOut, bool]:
    channel, _ = await channels.require_member(db, actor.id, channel_id)
    changed = (
        await repo.add(db, actor.id, channel.id)
        if favorite
        else await repo.remove(db, actor.id, channel.id)
    )
    if changed:
        await write_outbox(
            db,
            event_type=FAVORITE_UPDATED,
            audience_type="user",
            audience_id=actor.id,
            channel_id=channel.id,
            payload=FavoriteUpdatedData(channel_id=channel.id, favorite=favorite).model_dump(
                mode="json"
            ),
        )
    await db.commit()
    return FavoriteStateOut(channel_id=channel.id, favorite=favorite), changed


async def ids_for(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    return await repo.member_channel_ids(db, user_id)
