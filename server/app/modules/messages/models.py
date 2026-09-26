import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

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

    __table_args__ = (
        UniqueConstraint("channel_id", "seq", name="uq_messages_channel_seq"),
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


class Reaction(Base):
    """One user's reaction with one emoji on a message (DATA_MODEL.md "reactions")."""

    __tablename__ = "reactions"

    message_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("messages.id"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    emoji: Mapped[str] = mapped_column(Text, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
