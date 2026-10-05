from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel

from app.modules.attachments.models import Attachment
from app.modules.attachments.videos import is_video


class AttachmentPreviewOut(BaseModel):
    """M108 (docs/PREVIEWS.md): a PDF's or Office file's preview. 'pending': being made (show
    「プレビューを作成中…」); 'ready': the first page at GET /attachments/{id}/preview/thumbnail
    (WebP, width x height pixels) and every page at GET /attachments/{id}/preview/pdf; 'failed':
    none (a plain file card)."""

    status: Literal["pending", "ready", "failed"]
    pages: int | None
    width: int | None
    height: int | None


class AttachmentOut(BaseModel):
    id: UUID
    filename: str
    content_type: str
    size_bytes: int
    # An image's size, or (M79) a video's upright display size: None when the server does not
    # know it (older uploads, or a file it could not read).
    width: int | None
    height: int | None
    # An image's thumbnail at GET /attachments/{id}/thumbnail. Always false for a video (the
    # Android app before M82 shows every attachment with a thumbnail as a photo): see has_poster.
    has_thumbnail: bool
    # M79: a video's poster frame, a JPEG at the same GET /attachments/{id}/thumbnail.
    has_poster: bool
    # M79: a video's length in milliseconds, when known.
    duration_ms: int | None
    status: str
    created_at: datetime
    # M108: null for a file without a preview (not a document, or stored before previews and not
    # generated yet).
    preview: AttachmentPreviewOut | None = None


class FileItem(BaseModel):
    """One row of the files list (M11i): the attachment and where it was posted."""

    attachment: AttachmentOut
    message_id: UUID
    channel_id: UUID
    parent_id: UUID | None
    uploader_id: UUID
    attached_at: datetime


class FileListOut(BaseModel):
    items: list[FileItem]
    next_cursor: str | None


def to_attachment_out(attachment: Attachment) -> AttachmentOut:
    video = is_video(attachment.content_type)
    return AttachmentOut(
        id=attachment.id,
        filename=attachment.filename,
        content_type=attachment.content_type,
        size_bytes=attachment.size_bytes,
        width=attachment.width,
        height=attachment.height,
        has_thumbnail=attachment.thumbnail_key is not None and not video,
        has_poster=attachment.thumbnail_key is not None and video,
        duration_ms=attachment.duration_ms,
        status=attachment.status,
        created_at=attachment.created_at,
        preview=_preview_out(attachment),
    )


def _preview_out(attachment: Attachment) -> AttachmentPreviewOut | None:
    status = attachment.preview_status
    if status == "ready":
        return AttachmentPreviewOut(
            status="ready",
            pages=attachment.preview_pages,
            width=attachment.preview_width,
            height=attachment.preview_height,
        )
    if status == "pending":
        return AttachmentPreviewOut(status="pending", pages=None, width=None, height=None)
    if status == "failed":
        return AttachmentPreviewOut(status="failed", pages=None, width=None, height=None)
    return None
