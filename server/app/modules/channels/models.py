import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import CITEXT
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow

DM_TYPES = ("dm", "group_dm")


class Channel(Base):
    __tablename__ = "channels"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    type: Mapped[str] = mapped_column(String(16))
    name: Mapped[str | None] = mapped_column(CITEXT)
    topic: Mapped[str | None] = mapped_column(Text)
    purpose: Mapped[str | None] = mapped_column(Text)
    dm_key: Mapped[str | None] = mapped_column(String(64))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    last_seq: Mapped[int] = mapped_column(BigInteger, default=0, server_default=text("0"))
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # M15a: "owners" = only owners, administrators (and webhook bots) start top-level posts.
    posting_policy: Mapped[str] = mapped_column(
        String(16), default="everyone", server_default="everyone"
    )
    # M24: whose times this is (one per person); quiet unread for the others (SYNC_PROTOCOL §10.5).
    times_owner_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    __table_args__ = (
        CheckConstraint(
            "(type IN ('public', 'private')) = (name IS NOT NULL)", name="name_by_type"
        ),
        CheckConstraint(
            "(type IN ('dm', 'group_dm')) = (dm_key IS NOT NULL)", name="dm_key_by_type"
        ),
        CheckConstraint("posting_policy IN ('everyone', 'owners')", name="posting_policy_values"),
        Index("channels_name_uniq", "name", unique=True, postgresql_where=text("name IS NOT NULL")),
        Index(
            "channels_dm_key_uniq",
            "dm_key",
            unique=True,
            postgresql_where=text("dm_key IS NOT NULL"),
        ),
        Index(
            "channels_times_owner_uniq",
            "times_owner_id",
            unique=True,
            postgresql_where=text("times_owner_id IS NOT NULL"),
        ),
    )

    @property
    def is_dm(self) -> bool:
        return self.type in DM_TYPES

    @property
    def is_archived(self) -> bool:
        return self.archived_at is not None


class ChannelMember(Base):
    __tablename__ = "channel_members"

    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    role: Mapped[str] = mapped_column(String(16), default="member", server_default="member")
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (Index("channel_members_user_idx", "user_id"),)
