"""Starred channels (M12a). Only a member can star a channel; a change fans out to the user's
own devices as favorite.updated (outbox, audience user).

2026-10-07 (DATA_MODEL.md sidebar_sections 「1 つの会話は 1 か所」): a conversation sits in one
place of my sidebar, お気に入り or one of my sections. Starring one takes it out of my section
(the hook `sidebar` registers, as favorites does not depend on sidebar); putting one in a section
unstars it (`unstar_in_tx`, called by sidebar).
"""

import uuid
from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from app.events.outbox import write_outbox
from app.modules.channels import service as channels
from app.modules.favorites import repository as repo
from app.modules.favorites.events import FAVORITE_UPDATED, FavoriteUpdatedData
from app.modules.favorites.schemas import FavoriteStateOut
from app.modules.users.models import User

# Called in the transaction that stars a conversation: takes it out of my sidebar section.
StarredHook = Callable[[AsyncSession, User, uuid.UUID], Awaitable[None]]
_starred_hook: StarredHook | None = None


def set_starred_hook(hook: StarredHook | None) -> None:
    global _starred_hook
    _starred_hook = hook


async def _announce(db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, on: bool) -> None:
    await write_outbox(
        db,
        event_type=FAVORITE_UPDATED,
        audience_type="user",
        audience_id=user_id,
        channel_id=channel_id,
        payload=FavoriteUpdatedData(channel_id=channel_id, favorite=on).model_dump(mode="json"),
    )


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
        await _announce(db, actor.id, channel.id, favorite)
    if favorite and _starred_hook is not None:
        await _starred_hook(db, actor, channel.id)
    await db.commit()
    return FavoriteStateOut(channel_id=channel.id, favorite=favorite), changed


async def unstar_in_tx(db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID) -> bool:
    """The conversation went into one of my sections: no longer starred (favorite.updated when it
    was). The caller commits."""
    changed = await repo.remove(db, user_id, channel_id)
    if changed:
        await _announce(db, user_id, channel_id, False)
    return changed


async def ids_for(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    return await repo.member_channel_ids(db, user_id)
