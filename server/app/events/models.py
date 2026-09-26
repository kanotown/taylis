import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, DateTime, Identity, Index, Integer, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.time import utcnow


class OutboxEvent(Base):
    """A domain event written in the same transaction as the change it describes."""

    __tablename__ = "outbox_events"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    event_type: Mapped[str] = mapped_column(String(64))
    channel_id: Mapped[uuid.UUID | None]
    seq: Mapped[int | None] = mapped_column(BigInteger)
    audience_type: Mapped[str] = mapped_column(String(16))  # channel | user | session | all
    audience_id: Mapped[uuid.UUID | None]
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    last_error: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        Index("outbox_events_pending_idx", "id", postgresql_where=text("processed_at IS NULL")),
    )
