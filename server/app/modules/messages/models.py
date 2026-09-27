import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    or_,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql.elements import ColumnElement

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"))
    sender_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    # Thread reply (one level: replies to replies are rejected).
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("messages.id"))
    # M15c: a reply that is also shown in the channel timeline ("also send to channel").
    also_in_channel: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    seq: Mapped[int] = mapped_column(BigInteger)
    updated_seq: Mapped[int] = mapped_column(BigInteger)
    client_msg_id: Mapped[uuid.UUID | None]
    type: Mapped[str] = mapped_column(String(16), default="user", server_default="user")
    body: Mapped[str] = mapped_column(Text, default="", server_default="")
    mentioned_user_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid()), default=list, server_default=text("'{}'::uuid[]")
    )
    mention_all: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    # Thread parent bookkeeping (DATA_MODEL.md "各操作と seq").
    reply_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_reply_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Pinned in its channel (M11c): any member pins / unpins; the change consumes a seq.
    pinned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    pinned_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    # Poll (M14b): {question, options, multiple, closed_at}; the votes live in poll_votes.
    poll: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # M15e: "important" / "urgent" on a top-level post, and whether readers are asked to
    # acknowledge it (the acknowledgements live in message_acks).
    priority: Mapped[str | None] = mapped_column(String(16))
    ack_requested: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )

    __table_args__ = (
        UniqueConstraint("channel_id", "seq", name="uq_messages_channel_seq"),
        CheckConstraint(
            "NOT also_in_channel OR parent_id IS NOT NULL", name="also_in_channel_needs_parent"
        ),
        CheckConstraint(
            "priority IS NULL OR priority IN ('important', 'urgent')", name="priority_values"
        ),
        CheckConstraint(
            "parent_id IS NULL OR (priority IS NULL AND NOT ack_requested)",
            name="priority_top_level",
        ),
        Index(
            "messages_client_msg_id_uniq",
            "sender_id",
            "client_msg_id",
            unique=True,
            postgresql_where=text("client_msg_id IS NOT NULL"),
        ),
        Index("messages_channel_updated_seq_idx", "channel_id", "updated_seq"),
        Index(
            "messages_parent_idx",
            "parent_id",
            "seq",
            postgresql_where=text("parent_id IS NOT NULL"),
        ),
    )

    @property
    def is_deleted(self) -> bool:
        return self.deleted_at is not None


def timeline_filter() -> ColumnElement[bool]:
    """Rows of a channel timeline: top-level messages and replies also sent there (M15c)."""
    return or_(Message.parent_id.is_(None), Message.also_in_channel.is_(True))


class Reaction(Base):
    """One user's reaction with one emoji on a message (DATA_MODEL.md "reactions")."""

    __tablename__ = "reactions"

    message_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("messages.id"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    emoji: Mapped[str] = mapped_column(Text, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )


class PollVote(Base):
    """One user's vote for one option of a message's poll (M14b)."""

    __tablename__ = "poll_votes"

    message_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("messages.id"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    option_index: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )


class MessageAck(Base):
    """One member's "確認しました" on a message that asked for it (M15e)."""

    __tablename__ = "message_acks"

    message_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    acked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )


class MessageRevision(Base):
    """A body an edit replaced (M14c). Visible to the author only; purged with the message."""

    __tablename__ = "message_revisions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    message_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("messages.id"))
    body: Mapped[str] = mapped_column(Text)
    written_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))  # when it was posted
    replaced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))  # when the edit came

    __table_args__ = (Index("message_revisions_message_idx", "message_id", "replaced_at"),)
