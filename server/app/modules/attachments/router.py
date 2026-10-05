from uuid import UUID

from fastapi import APIRouter, File, Query, Request, UploadFile
from fastapi.responses import StreamingResponse

from app.core.db import Db
from app.core.errors import not_found, rate_limited
from app.modules.attachments import service
from app.modules.attachments.schemas import AttachmentOut, FileListOut, to_attachment_out
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
    out = await service.upload(db, user, file, request.app.state.settings, request.app.state.blobs)
    if out.preview is not None and out.preview.status == "pending":
        request.app.state.preview_wake.set()  # M108: the preview loop starts on it now
    return out


@router.get("/files", response_model=FileListOut)
async def list_files(
    user: CurrentUser,
    db: Db,
    channel_id: UUID | None = Query(default=None),
    q: str | None = Query(default=None, max_length=200),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
) -> FileListOut:
    """M11i: attached files in my channels (optionally one channel), newest first."""
    return await service.list_files(
        db, user, channel_id=channel_id, query=q, cursor=cursor, limit=limit
    )


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


@router.get("/attachments/{attachment_id}/preview/thumbnail")
async def preview_thumbnail(
    attachment_id: UUID, request: Request, user: CurrentUser, db: Db
) -> StreamingResponse:
    """M108: the first page of a document's preview (WebP)."""
    attachment = await service.get_for_access(db, user, attachment_id)
    if attachment.preview_status != "ready" or attachment.preview_thumb_key is None:
        raise not_found("preview_not_found", "This attachment has no preview")
    return StreamingResponse(
        service.stream(request.app.state.blobs, attachment.preview_thumb_key),
        headers={
            "Content-Type": "image/webp",
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=3600",
        },
    )


@router.get("/attachments/{attachment_id}/preview/pdf")
async def preview_pdf(
    attachment_id: UUID, request: Request, user: CurrentUser, db: Db
) -> StreamingResponse:
    """M108: every page of a document's preview as a PDF (the converter's, or a PDF upload
    itself). Inline, and sandboxed by CSP (SECURITY.md §4 「文書のプレビュー」)."""
    attachment = await service.get_for_access(db, user, attachment_id)
    if attachment.preview_status != "ready":
        raise not_found("preview_not_found", "This attachment has no preview")
    key = attachment.preview_pdf_key or attachment.storage_key
    return StreamingResponse(
        service.stream(request.app.state.blobs, key),
        headers=service.preview_pdf_headers(attachment),
    )
