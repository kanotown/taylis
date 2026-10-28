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


DriveState = Literal["available", "moved", "trashed", "deleted"]


class AttachmentDriveOut(BaseModel):
    """CF1 (docs/CHANNEL_FILES.md §11.1): a file posted in a channel is also version
    `version_number` of the item `item_id` in the channel's drive. The message keeps showing this
    version (a newer one in the drive does not change it). `state`, the same for every viewer:
    'available' (in the channel's drive), 'moved' (in another location: only who can read it
    there can open it; GET /drive/items/{item_id} tells), 'trashed' (「削除されたファイル」, it
    can be restored from the drive's trash), 'deleted' (purged: a tombstone, item_id and the
    version are null and the bytes are gone)."""

    item_id: UUID | None
    version_id: UUID | None
    version_number: int | None
    state: DriveState


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
    # CF1: the drive item this posted file is a version of; null for every other attachment (a
    # DM's, a canvas's, a channel's whose files stay out of the drive). Older clients ignore it
    # and show the attachment as before.
    drive: AttachmentDriveOut | None = None
    # AL1 (docs/ALBUMS.md §6): a display-size copy (long edge ≤ 2048 px, WebP, no metadata) at
    # GET /attachments/{id}/display, for the full-screen viewer. Only drive images get one (a
    # posted photo too, CHANNEL_FILES.md); without it /display answers the original image.
    has_display: bool = False


class FileItem(BaseModel):
    """One row of the files list (M11i): the attachment and where it was posted. CF1: a posted
    file that is in the channel's drive has `attachment.drive` (「ドライブで表示」); one moved
    elsewhere, in the trash or purged is not listed."""

    attachment: AttachmentOut
    message_id: UUID
    channel_id: UUID
    parent_id: UUID | None
    uploader_id: UUID
    attached_at: datetime


class FileListOut(BaseModel):
    items: list[FileItem]
    next_cursor: str | None


def to_attachment_out(
    attachment: Attachment, drive: AttachmentDriveOut | None = None
) -> AttachmentOut:
    """`drive`: the posted file's place in the drive (repository.drive_versions); a row with a
    drive_state but none given gets the state alone."""
    video = is_video(attachment.content_type)
    if drive is None and attachment.drive_state is not None:
        drive = AttachmentDriveOut(
            item_id=attachment.drive_item_id,
            version_id=None,
            version_number=None,
            state=attachment.drive_state,  # type: ignore[arg-type]
        )
    if drive is not None and drive.state == "deleted":
        # A tombstone: its thumbnail, poster and preview are gone (or about to be); an older
        # client shows the plain file row, which answers 404 when opened (§11.2).
        return AttachmentOut(
            id=attachment.id,
            filename=attachment.filename,
            content_type=attachment.content_type,
            size_bytes=attachment.size_bytes,
            width=None,
            height=None,
            has_thumbnail=False,
            has_poster=False,
            duration_ms=None,
            status="attached",
            created_at=attachment.created_at,
            preview=None,
            drive=AttachmentDriveOut(
                item_id=None, version_id=None, version_number=None, state="deleted"
            ),
        )
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
        drive=drive,
        has_display=attachment.display_key is not None,
    )


def preview_out(attachment: Attachment) -> AttachmentPreviewOut | None:
    """The preview's state as the API shows it (None: no preview, not made or not wanted)."""
    return _preview_out(attachment)


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
