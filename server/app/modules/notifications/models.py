import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.time import utcnow


class NotificationPreference(Base):
    """Per user and channel. No row or no level: the overall setting (DATA_MODEL.md)."""

    __tablename__ = "notification_preferences"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"), primary_key=True)
    level: Mapped[str | None] = mapped_column(String(16))  # all | mentions | none; NULL = overall
    muted_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # M35: muted until unmuted (muted_until is the timed mute).
    muted: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )


class PushDelivery(Base):
    """One planned push per (outbox event, device).

    At-least-once delivery with a lease (PUSH_NOTIFICATIONS.md §2).
    """

    __tablename__ = "push_deliveries"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    event_id: Mapped[int] = mapped_column(BigInteger)
    device_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("devices.id"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    kind: Mapped[str] = mapped_column(String(8))  # alert | silent
    collapse_key: Mapped[str | None] = mapped_column(Text)
    channel_id: Mapped[uuid.UUID | None]
    message_id: Mapped[uuid.UUID | None]
    message_seq: Mapped[int | None] = mapped_column(BigInteger)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(8), default="pending", server_default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index(
            "push_deliveries_pending_idx",
            "next_attempt_at",
            postgresql_where=text("status = 'pending'"),
        ),
    )
