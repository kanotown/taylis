import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class Attachment(Base):
    """Metadata in PostgreSQL; bytes live in the object store (DATA_MODEL.md "attachments")."""

    __tablename__ = "attachments"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    uploader_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    message_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("messages.id"))
    channel_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("channels.id"))
    # M42: an image (or file) in a canvas's body (CANVAS.md §4.10). message_id stays NULL and
    # channel_id is the canvas's conversation; only its members read it.
    canvas_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("canvases.id", ondelete="SET NULL")
    )
    # M120 (docs/WIKI.md §4.7): an image or file in a wiki page's body. message_id, channel_id
    # and canvas_id stay NULL; whoever can read the page reads it.
    page_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("wiki_pages.id", ondelete="SET NULL")
    )
    # M160 (docs/DRIVE.md §4.1): one version of a drive file. message_id, channel_id, canvas_id
    # and page_id stay NULL; whoever can read the drive item reads it (status 'attached').
    drive_item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("drive_items.id", ondelete="SET NULL")
    )
    # M167 (docs/LENDING.md §4.3): an equipment item's photo. message_id, channel_id, canvas_id,
    # page_id and drive_item_id stay NULL; every person reads it while the feature is on.
    # (use_alter: lending_items.photo_attachment_id points back here.)
    lending_item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey(
            "lending_items.id",
            ondelete="SET NULL",
            use_alter=True,
            name="attachments_lending_item_id_fkey",
        )
    )
    # pending | scheduled | attached | deleted (gone at once; the GC removes the bytes, then the
    # row) | purged (CF1: a posted file's tombstone, below).
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    # CF1 (docs/CHANNEL_FILES.md §3.2): a file posted in a public or private channel is also
    # version 1 of an item in the channel's drive (message_id and drive_item_id both set). What
    # the channel sees of it, the same for every viewer (permissions never read it): 'available'
    # (in the channel's drive, not in the trash), 'moved' (in another location), 'trashed',
    # 'deleted' (purged from the drive; the GC keeps the row as a tombstone, status 'purged').
    # NULL for every other row.
    drive_state: Mapped[str | None] = mapped_column(String(12))
    filename: Mapped[str] = mapped_column(Text)
    content_type: Mapped[str] = mapped_column(Text)
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[bytes | None] = mapped_column(LargeBinary)
    storage_key: Mapped[str] = mapped_column(Text)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    # An image's thumbnail, or (M79) a video's poster frame: the same JPEG, the same endpoint.
    thumbnail_key: Mapped[str | None] = mapped_column(Text)
    # M79: a video's length; width / height are its upright display size, as for an image.
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    # M79: when the server looked at the video (found something or not). NULL: not yet (uploaded
    # before M79 or without ffmpeg); `app.cli probe-videos` takes those.
    video_probed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # M108 (docs/PREVIEWS.md): a document's preview. 'none' (not a previewable type, or uploaded
    # while previews were off: `app.cli generate-previews` takes those), 'pending' (queued for the
    # preview loop), 'ready', 'failed'.
    preview_status: Mapped[str] = mapped_column(String(16), default="none", server_default="none")
    preview_pages: Mapped[int | None] = mapped_column(Integer)
    # The PDF made by the converter; NULL for a PDF upload (the original is the preview).
    preview_pdf_key: Mapped[str | None] = mapped_column(Text)
    # The first page as WebP, preview_width x preview_height pixels.
    preview_thumb_key: Mapped[str | None] = mapped_column(Text)
    preview_width: Mapped[int | None] = mapped_column(Integer)
    preview_height: Mapped[int | None] = mapped_column(Integer)
    preview_attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Review v0.1.37 #4 / #9: +1 at every claim of a try. The try owns the row only while this is
    # still its number, and stores its objects under keys with the number (preview_kinds.pdf_key).
    preview_generation: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # When the loop may take it (again): after a failed try, or once a claimed try's lease runs out.
    preview_next_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    preview_error: Mapped[str | None] = mapped_column(Text)
    # AL1 (docs/ALBUMS.md §4.1, §6): a drive image's display-size copy (the long edge at most
    # 2048 px, WebP, no metadata) for the full-screen viewer and the public side; not counted by
    # any quota (a derived object, as the thumbnail).
    display_key: Mapped[str | None] = mapped_column(Text)
    display_width: Mapped[int | None] = mapped_column(Integer)
    display_height: Mapped[int | None] = mapped_column(Integer)
    display_bytes: Mapped[int | None] = mapped_column(Integer)
    # AL1: what the server read from a drive photo or video: its capture time (EXIF
    # DateTimeOriginal with its offset, a video's creation_time; for ordering and display only,
    # never trusted for anything else), whether the zone was unknown (read in the workspace's),
    # and whether the original holds a location (the value is never kept). photo_probed_at: when
    # it was read (whatever was found); NULL: not yet (`app.cli drive-photos`).
    taken_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    taken_at_local: Mapped[bool | None] = mapped_column(Boolean)
    has_location: Mapped[bool | None] = mapped_column(Boolean)
    photo_probed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    attached_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "drive_state IS NULL OR (drive_state IN ('available', 'moved', 'trashed', 'deleted') "
            "AND message_id IS NOT NULL)",
            name="drive_state_values",
        ),
        Index("attachments_message_idx", "message_id"),
        Index("attachments_gc_idx", "status", "created_at"),
        Index(
            "attachments_canvas_idx",
            "canvas_id",
            postgresql_where=text("canvas_id IS NOT NULL"),
        ),
        Index(
            "attachments_page_idx",
            "page_id",
            postgresql_where=text("page_id IS NOT NULL"),
        ),
        Index(
            "attachments_drive_item_idx",
            "drive_item_id",
            postgresql_where=text("drive_item_id IS NOT NULL"),
        ),
        Index(
            "attachments_drive_state_idx",
            "drive_item_id",
            postgresql_where=text("drive_state IS NOT NULL"),
        ),
        Index(
            "attachments_lending_item_idx",
            "lending_item_id",
            postgresql_where=text("lending_item_id IS NOT NULL"),
        ),
        Index(
            "attachments_preview_queue_idx",
            "preview_next_at",
            postgresql_where=text("preview_status = 'pending'"),
        ),
    )
