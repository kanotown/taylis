from uuid import UUID

from fastapi import APIRouter, File, Request, UploadFile
from fastapi.responses import StreamingResponse

from app.core.db import Db
from app.core.errors import rate_limited
from app.modules.attachments import service as attachments
from app.modules.auth.deps import CurrentUser
from app.modules.avatars import service
from app.modules.users.schemas import UserMe, to_user_me

router = APIRouter(tags=["users"])


@router.post("/users/me/avatar", response_model=UserMe)
async def upload_avatar(
    request: Request, user: CurrentUser, db: Db, file: UploadFile = File(...)
) -> UserMe:
    """M14a: a PNG / JPEG / GIF / WebP, cropped square and resized to 256px."""
    limiter = request.app.state.limiters["upload"]
    key = str(user.id)
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))
    updated = await service.upload(
        db, user, file, request.app.state.settings, request.app.state.blobs
    )
    return to_user_me(updated)


@router.delete("/users/me/avatar", response_model=UserMe)
async def delete_avatar(request: Request, user: CurrentUser, db: Db) -> UserMe:
    return to_user_me(await service.remove(db, user, request.app.state.blobs))


@router.get("/users/{user_id}/avatar")
async def get_avatar(user_id: UUID, request: Request, _: CurrentUser, db: Db) -> StreamingResponse:
    """The picture (PNG). Clients add `?v=<avatar_updated_at>` so a change is not cached away."""
    key = await service.storage_key(db, user_id)
    return StreamingResponse(
        attachments.stream(request.app.state.blobs, key),
        headers={
            "Content-Type": "image/png",
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=86400",
        },
    )
