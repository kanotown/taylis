import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
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
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    attached_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("attachments_message_idx", "message_id"),
        Index("attachments_gc_idx", "status", "created_at"),
        Index(
            "attachments_canvas_idx",
            "canvas_id",
            postgresql_where=text("canvas_id IS NOT NULL"),
        ),
    )
