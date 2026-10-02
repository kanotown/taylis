import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Text, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class CanvasMention(Base):
    """M76 (CANVAS.md §20): an activity item for a person a canvas newly mentions.

    Written with canvas.mentioned, in the save's transaction. While unread (`at` after the
    person's activity_read_at) a later mention in the same canvas moves this row (time, version,
    who, excerpt) instead of adding another; once read, the next one is a new row. A purged canvas
    takes its rows with it; a canvas in the trash, or a conversation the person left, hides them."""

    __tablename__ = "canvas_mentions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    canvas_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("canvases.id", ondelete="CASCADE"))
    # The version that added the mention (no foreign key: old versions are thinned).
    rev_id: Mapped[uuid.UUID] = mapped_column()
    actor_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    # The line around the mention as one plain line (mentions as names), at most 200 characters.
    excerpt: Mapped[str] = mapped_column(Text, default="", server_default="")
    at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (
        Index("canvas_mentions_user_idx", "user_id", text("at DESC")),
        Index("canvas_mentions_canvas_idx", "canvas_id", "user_id"),
    )
