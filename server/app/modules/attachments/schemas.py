from datetime import datetime
from uuid import UUID

from pydantic import BaseModel

from app.modules.attachments.models import Attachment


class AttachmentOut(BaseModel):
    id: UUID
    filename: str
    content_type: str
    size_bytes: int
    width: int | None
    height: int | None
    has_thumbnail: bool
    status: str
    created_at: datetime


def to_attachment_out(attachment: Attachment) -> AttachmentOut:
    return AttachmentOut(
        id=attachment.id,
        filename=attachment.filename,
        content_type=attachment.content_type,
        size_bytes=attachment.size_bytes,
        width=attachment.width,
        height=attachment.height,
        has_thumbnail=attachment.thumbnail_key is not None,
        status=attachment.status,
        created_at=attachment.created_at,
    )
