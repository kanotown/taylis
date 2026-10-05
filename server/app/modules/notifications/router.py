import uuid
from uuid import UUID

from fastapi import APIRouter, Request

from app.core.db import Db
from app.core.errors import AppError, request_locale
from app.modules.auth.deps import CurrentUser
from app.modules.auth.models import UserSession
from app.modules.notifications import push_test, service
from app.modules.notifications.schemas import (
    NotificationPreferenceIn,
    NotificationPreferenceOut,
    TestNotificationOut,
)

router = APIRouter(tags=["notifications"])


@router.put(
    "/channels/{channel_id}/notification-preference", response_model=NotificationPreferenceOut
)
async def set_preference(
    channel_id: UUID, user: CurrentUser, body: NotificationPreferenceIn, db: Db
) -> NotificationPreferenceOut:
    return await service.set_preference(db, user, channel_id, body)


@router.post("/users/me/test-notification", response_model=TestNotificationOut)
async def send_test_notification(
    request: Request, user: CurrentUser, db: Db
) -> TestNotificationOut:
    """A test push to every device of mine, plus `notification.test` to my open apps
    (PUSH_NOTIFICATIONS.md §15). 5 in 10 minutes per user."""
    limiter = request.app.state.limiters["test_notification"]
    key = str(user.id)
    if not limiter.try_acquire(key):
        retry_after = limiter.retry_after_seconds(key)
        raise AppError(
            429,
            "test_notification_rate_limited",
            "Too many test notifications",
            details={"retry_after_seconds": retry_after},
            headers={"Retry-After": str(retry_after)},
        )
    current_device_id: uuid.UUID | None = None
    session_id = getattr(request.state, "session_id", None)
    if session_id:
        session = await db.get(UserSession, uuid.UUID(session_id))
        current_device_id = session.device_id if session is not None else None
    state = request.app.state
    return await push_test.send_test(
        db,
        user,
        current_device_id=current_device_id,
        providers=state.push_providers,
        settings=state.settings,
        locale=request_locale(request),
    )
