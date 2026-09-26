import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, Text, Uuid, func
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class ScheduledMessage(Base):
    """A message the server posts on the author's behalf at `send_at` (DATA_MODEL.md)."""

    __tablename__ = "scheduled_messages"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"))
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("messages.id"))
    # Becomes the posted message's idempotency key, so a retry after a crash never posts twice.
    client_msg_id: Mapped[uuid.UUID] = mapped_column(unique=True)
    body: Mapped[str] = mapped_column(Text)
    attachment_ids: Mapped[list[uuid.UUID] | None] = mapped_column(ARRAY(Uuid))
    send_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    error: Mapped[str | None] = mapped_column(Text)
    sent_message_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("messages.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )

    __table_args__ = (
        Index("scheduled_messages_due_idx", "status", "send_at"),
        Index("scheduled_messages_user_idx", "user_id", "send_at"),
    )
