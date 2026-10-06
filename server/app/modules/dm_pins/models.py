import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.time import utcnow


class ConversationPin(Base):
    """One user's pinned DM or group DM (DATA_MODEL.md conversation_pins). Personal: no channel
    seq. The pins are ordered by `created_at`, oldest first."""

    __tablename__ = "conversation_pins"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (Index("conversation_pins_user_idx", "user_id", "created_at"),)
