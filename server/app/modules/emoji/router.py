from uuid import UUID

from fastapi import APIRouter, File, Form, Request, Response, UploadFile
from fastapi.responses import StreamingResponse

from app.core.db import Db
from app.core.errors import rate_limited
from app.modules.attachments import service as attachments
from app.modules.auth.deps import CurrentUser
from app.modules.emoji import service
from app.modules.emoji.schemas import CustomEmojiOut

router = APIRouter(tags=["emoji"])


@router.get("/emoji", response_model=list[CustomEmojiOut])
async def list_emoji(user: CurrentUser, db: Db) -> list[CustomEmojiOut]:
    """Every custom emoji, by name (also part of bootstrap)."""
    return await service.list_all(db)


@router.post("/emoji", response_model=CustomEmojiOut, status_code=201)
async def add_emoji(
    request: Request,
    user: CurrentUser,
    db: Db,
    name: str = Form(...),
    file: UploadFile = File(...),
) -> CustomEmojiOut:
    """M12f: any member adds a `:name:` (2-32 chars of a-z 0-9 _ + -) with a small image."""
    limiter = request.app.state.limiters["upload"]
    key = str(user.id)
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))
    return await service.upload(
        db, user, name, file, request.app.state.settings, request.app.state.blobs
    )


@router.delete("/emoji/{emoji_id}", status_code=204)
async def delete_emoji(emoji_id: UUID, request: Request, user: CurrentUser, db: Db) -> Response:
    """The creator or an admin removes it; bodies keep the text `:name:`."""
    await service.delete(db, user, emoji_id, request.app.state.blobs)
    return Response(status_code=204)


@router.get("/emoji/{emoji_id}/image")
async def emoji_image(
    emoji_id: UUID, request: Request, user: CurrentUser, db: Db
) -> StreamingResponse:
    row = await service.require(db, emoji_id)
    return StreamingResponse(
        attachments.stream(request.app.state.blobs, row.storage_key),
        headers={
            "Content-Type": row.content_type,
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=86400",
        },
    )
