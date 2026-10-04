"""Moderation (M104, docs/MODERATION.md): blocked users and message reports."""

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow

REPORT_REASONS = ("spam", "harassment", "inappropriate", "other")


class UserBlock(Base):
    """One person's private block of another (DATA_MODEL.md user_blocks). The blocked person is
    never told; only the blocker's devices see the row."""

    __tablename__ = "user_blocks"

    blocker_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    blocked_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("blocker_id <> blocked_id", name="user_blocks_not_self_check"),
        Index("user_blocks_blocked_idx", "blocked_id"),
    )


class MessageReport(Base):
    """A message reported to the administrators (DATA_MODEL.md message_reports)."""

    __tablename__ = "message_reports"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    message_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"))
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    reporter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    reported_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    reason: Mapped[str] = mapped_column(String(16))
    note: Mapped[str | None] = mapped_column(Text)
    # The body when it was reported: the author may edit or delete the message afterwards.
    body_snapshot: Mapped[str] = mapped_column(Text, default="", server_default="")
    status: Mapped[str] = mapped_column(String(16), default="open", server_default="open")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    __table_args__ = (
        CheckConstraint(
            "reason IN ('spam', 'harassment', 'inappropriate', 'other')",
            name="message_reports_reason_check",
        ),
        CheckConstraint("status IN ('open', 'resolved')", name="message_reports_status_check"),
        UniqueConstraint("message_id", "reporter_id", name="message_reports_once"),
        Index("message_reports_status_idx", "status", "created_at"),
    )
