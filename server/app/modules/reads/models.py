import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.time import utcnow


class ReadState(Base):
    """One row per user and channel: ``seq <= last_read_seq`` is read (DATA_MODEL.md)."""

    __tablename__ = "read_states"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"), primary_key=True)
    last_read_seq: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
