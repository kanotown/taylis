import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.time import utcnow


class ConversationClose(Base):
    """One user's closed DM or group DM (DATA_MODEL.md conversation_closes). Personal: no channel
    seq. The conversation is closed while no timeline message (top level or also_in_channel) has a
    seq above `closed_seq`; a newer one reopens it without a write."""

    __tablename__ = "conversation_closes"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"), primary_key=True)
    # The channel's last_seq when it was closed.
    closed_seq: Mapped[int] = mapped_column(BigInteger)
    closed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
