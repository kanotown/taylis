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

# Why a message is reported (POST /messages/{id}/report).
REPORT_REASONS = ("spam", "harassment", "inappropriate", "child_safety", "other")
# The category of a report about a person or the app (POST /reports, M119): the reasons above
# plus feedback. Both kinds are stored in message_reports.reason.
REPORT_CATEGORIES = ("child_safety", "harassment", "inappropriate", "spam", "feedback", "other")
REPORT_KINDS = ("message", "user", "general")


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
    """A report to the administrators (DATA_MODEL.md message_reports): of a message (`kind =
    message`, M104) or, since M119, of a person (`user`) or of anything else / feedback
    (`general`), which have no message or channel."""

    __tablename__ = "message_reports"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    kind: Mapped[str] = mapped_column(String(16), default="message", server_default="message")
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE")
    )
    channel_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE")
    )
    reporter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    reported_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    reason: Mapped[str] = mapped_column(String(16))
    # POST /reports: the client's id of the report, so a retried request returns the first.
    client_report_id: Mapped[uuid.UUID | None] = mapped_column()
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
            "reason IN ('spam', 'harassment', 'inappropriate', 'child_safety', 'feedback', "
            "'other')",
            name="message_reports_reason_check",
        ),
        CheckConstraint(
            "(kind = 'message' AND message_id IS NOT NULL AND channel_id IS NOT NULL"
            " AND reported_user_id IS NOT NULL AND reason <> 'feedback')"
            " OR (kind = 'user' AND message_id IS NULL AND channel_id IS NULL"
            " AND reported_user_id IS NOT NULL)"
            " OR (kind = 'general' AND message_id IS NULL AND channel_id IS NULL"
            " AND reported_user_id IS NULL)",
            name="message_reports_kind_check",
        ),
        CheckConstraint("status IN ('open', 'resolved')", name="message_reports_status_check"),
        UniqueConstraint("message_id", "reporter_id", name="message_reports_once"),
        UniqueConstraint("reporter_id", "client_report_id", name="message_reports_client_id"),
        Index("message_reports_status_idx", "status", "created_at"),
    )
