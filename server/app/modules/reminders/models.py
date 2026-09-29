import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class Reminder(Base):
    """A personal reminder about a message (DATA_MODEL.md reminders)."""

    __tablename__ = "reminders"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    message_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("messages.id"))
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"))
    note: Mapped[str | None] = mapped_column(String(200))
    remind_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # pending → fired (the nudge went out) → done; or cancelled while pending.
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    fired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )
    preview: Mapped[str | None] = mapped_column(Text)
    # "personal" (M12e) or "ack": the author asked the members who had not acknowledged (L4).
    kind: Mapped[str] = mapped_column(String(16), default="personal", server_default="personal")

    __table_args__ = (
        Index("reminders_due_idx", "status", "remind_at"),
        Index("reminders_user_idx", "user_id", "status", "remind_at"),
    )
