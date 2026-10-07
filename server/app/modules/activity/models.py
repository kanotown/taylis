import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ColumnElement, DateTime, ForeignKey, Index, Text, exists, func, text
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


class ActivityItemRead(Base):
    """2026-10-07 (MOBILE_UI.md §6.4): an activity item I opened, by its id in GET /activity. Read
    while the item's `at` is not after read_at. Kept only above users.activity_read_at: moving it
    deletes the rows at or below it."""

    __tablename__ = "activity_item_reads"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    item_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    read_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )


def item_read(user_id: uuid.UUID, item_id: Any, at: Any) -> ColumnElement[bool]:
    """The activity item (`item_id`, last happened `at`: expressions of the outer query) was
    opened by the user since (2026-10-07)."""
    return exists().where(
        ActivityItemRead.user_id == user_id,
        ActivityItemRead.item_id == item_id,
        ActivityItemRead.read_at >= at,
    )
