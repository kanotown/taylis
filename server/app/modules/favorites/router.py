from uuid import UUID

from fastapi import APIRouter, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.favorites import service
from app.modules.favorites.schemas import FavoriteStateOut

router = APIRouter(tags=["favorites"])


@router.put("/channels/{channel_id}/favorite", response_model=FavoriteStateOut)
async def add_favorite(
    channel_id: UUID, user: CurrentUser, db: Db, response: Response
) -> FavoriteStateOut:
    """Star a channel I belong to (M12a); 201 when it was not starred yet."""
    state, changed = await service.set_favorite(db, user, channel_id, favorite=True)
    response.status_code = 201 if changed else 200
    return state


@router.delete("/channels/{channel_id}/favorite", response_model=FavoriteStateOut)
async def remove_favorite(channel_id: UUID, user: CurrentUser, db: Db) -> FavoriteStateOut:
    state, _ = await service.set_favorite(db, user, channel_id, favorite=False)
    return state
