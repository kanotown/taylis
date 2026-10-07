from uuid import UUID

from fastapi import APIRouter

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.dm_closes import service
from app.modules.dm_closes.schemas import DmCloseStateOut

router = APIRouter(tags=["dm-closes"])


@router.put("/channels/{channel_id}/close", response_model=DmCloseStateOut)
async def close_dm(channel_id: UUID, user: CurrentUser, db: Db) -> DmCloseStateOut:
    """Close a DM or group DM I belong to (M141, 「会話を閉じる」): hidden from my DM lists until a
    new message arrives in it or I open it again. It is marked read and unpinned. Idempotent
    (closing again moves the closing point to now). 403 not_a_member, 409 dm_close_not_dm for a
    channel."""
    return await service.close(db, user, channel_id)


@router.delete("/channels/{channel_id}/close", response_model=DmCloseStateOut)
async def reopen_dm(channel_id: UUID, user: CurrentUser, db: Db) -> DmCloseStateOut:
    """Open it again (clients call this when I open a closed conversation). Idempotent: 200
    whether or not it was closed."""
    return await service.reopen(db, user, channel_id)
