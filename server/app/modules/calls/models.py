import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, Text, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class Call(Base):
    """An in-app call (M130, docs/CALLS.md §3.1). Its id is the LiveKit room's name (a random
    UUIDv4: guessing it gets nobody in, the access token does). At most one open call per
    conversation."""

    __tablename__ = "calls"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    # The call message (set in the transaction that starts the call).
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        # use_alter: calls and messages refer to each other (messages.call_id).
        ForeignKey(
            "messages.id", ondelete="SET NULL", use_alter=True, name="calls_message_id_fkey"
        ),
        unique=True,
    )
    started_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 'empty' (LiveKit closed the room) | 'reconciled' (found gone) | 'archived' | 'admin'.
    end_reason: Mapped[str | None] = mapped_column(Text)
    # The most people in the call at once, and the people who were ever in it (distinct).
    peak_participants: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    participant_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    __table_args__ = (
        CheckConstraint(
            "end_reason IS NULL OR end_reason IN ('empty', 'reconciled', 'archived', 'admin')",
            name="calls_end_reason_check",
        ),
        Index(
            "calls_channel_open_uidx",
            "channel_id",
            unique=True,
            postgresql_where=text("ended_at IS NULL"),
        ),
        Index("calls_open_idx", "started_at", postgresql_where=text("ended_at IS NULL")),
    )


class CallParticipant(Base):
    """One LiveKit connection to a call: the same person leaving and coming back is two rows.
    `livekit_sid` (the participant's sid) makes webhooks idempotent and absorbs reordering."""

    __tablename__ = "call_participants"

    # uuid7: rows sort in the order they were written (two joins in the same second).
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    call_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("calls.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    livekit_sid: Mapped[str] = mapped_column(Text, unique=True)
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    left_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Why it closed (migration 0105): 'left' (participant_left / hung up), 'reconciled' (missing
    # from LiveKit's list: reopened if a later list has it) or 'ended'. NULL: open, or closed
    # before 0105 (treated as confirmed).
    left_reason: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        CheckConstraint(
            "left_reason IS NULL OR left_reason IN ('left', 'reconciled', 'ended')",
            name="call_participants_left_reason_check",
        ),
        Index("call_participants_open_idx", "call_id", postgresql_where=text("left_at IS NULL")),
        Index("call_participants_call_idx", "call_id", "user_id"),
    )
