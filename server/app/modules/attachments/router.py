from uuid import UUID

from fastapi import APIRouter, File, Query, Request, UploadFile
from fastapi.responses import StreamingResponse

from app.core.db import Db
from app.core.errors import not_found, rate_limited
from app.modules.attachments import service
from app.modules.attachments.schemas import AttachmentOut, to_attachment_out
from app.modules.auth.deps import CurrentUser

router = APIRouter(tags=["attachments"])


@router.post("/attachments", response_model=AttachmentOut, status_code=201)
async def upload(
    request: Request, user: CurrentUser, db: Db, file: UploadFile = File(...)
) -> AttachmentOut:
    limiter = request.app.state.limiters["upload"]
    key = str(user.id)
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))
    return await service.upload(db, user, file, request.app.state.settings, request.app.state.blobs)


@router.get("/attachments/{attachment_id}", response_model=AttachmentOut)
async def get_attachment(attachment_id: UUID, user: CurrentUser, db: Db) -> AttachmentOut:
    return to_attachment_out(await service.get_for_access(db, user, attachment_id))


@router.get("/attachments/{attachment_id}/content")
async def download(
    attachment_id: UUID,
    request: Request,
    user: CurrentUser,
    db: Db,
    inline: bool = Query(default=False),
) -> StreamingResponse:
    attachment = await service.get_for_access(db, user, attachment_id)
    return StreamingResponse(
        service.stream(request.app.state.blobs, attachment.storage_key),
        headers=service.content_headers(attachment, inline=inline),
    )


@router.get("/attachments/{attachment_id}/thumbnail")
async def thumbnail(
    attachment_id: UUID, request: Request, user: CurrentUser, db: Db
) -> StreamingResponse:
    attachment = await service.get_for_access(db, user, attachment_id)
    if attachment.thumbnail_key is None:
        raise not_found("thumbnail_not_found", "This attachment has no thumbnail")
    return StreamingResponse(
        service.stream(request.app.state.blobs, attachment.thumbnail_key),
        headers={
            "Content-Type": "image/jpeg",
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=3600",
        },
    )
