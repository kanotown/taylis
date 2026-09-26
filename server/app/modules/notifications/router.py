from uuid import UUID

from fastapi import APIRouter

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.notifications import service
from app.modules.notifications.schemas import NotificationPreferenceIn, NotificationPreferenceOut

router = APIRouter(tags=["notifications"])


@router.put(
    "/channels/{channel_id}/notification-preference", response_model=NotificationPreferenceOut
)
async def set_preference(
    channel_id: UUID, user: CurrentUser, body: NotificationPreferenceIn, db: Db
) -> NotificationPreferenceOut:
    return await service.set_preference(db, user, channel_id, body)
