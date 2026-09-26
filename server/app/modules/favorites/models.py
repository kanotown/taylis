import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.time import utcnow


class ChannelFavorite(Base):
    """One user's starred channel (DATA_MODEL.md channel_favorites). Personal: no channel seq."""

    __tablename__ = "channel_favorites"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (Index("channel_favorites_user_idx", "user_id", "created_at"),)
