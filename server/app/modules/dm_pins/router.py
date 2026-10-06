from uuid import UUID

from fastapi import APIRouter, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.dm_pins import service
from app.modules.dm_pins.schemas import DmPinStateOut

router = APIRouter(tags=["dm-pins"])


@router.put("/channels/{channel_id}/dm-pin", response_model=DmPinStateOut)
async def pin_dm(channel_id: UUID, user: CurrentUser, db: Db, response: Response) -> DmPinStateOut:
    """Pin a DM or group DM I belong to at the top of my DM list (M118); 201 when it was not
    pinned yet, 200 when it was (it keeps its place). 403 not_a_member, 409 dm_pin_not_dm for a
    channel."""
    state, changed = await service.set_pinned(db, user, channel_id, pinned=True)
    response.status_code = 201 if changed else 200
    return state


@router.delete("/channels/{channel_id}/dm-pin", response_model=DmPinStateOut)
async def unpin_dm(channel_id: UUID, user: CurrentUser, db: Db) -> DmPinStateOut:
    """Idempotent: 200 whether or not it was pinned."""
    state, _ = await service.set_pinned(db, user, channel_id, pinned=False)
    return state
