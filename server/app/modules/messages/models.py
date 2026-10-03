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

# C3 (MOBILE_POLISH.md): how many repliers a thread parent names (clients show 3).
REPLY_USERS_MAX = 5


def with_replier(current: list[uuid.UUID], sender_id: uuid.UUID) -> list[uuid.UUID]:
    """C3: reply_user_ids after `sender_id` replied: they move to the front, the rest keep their
    order (the new reply is the newest), the list stays at REPLY_USERS_MAX."""
    return [sender_id, *(uid for uid in current if uid != sender_id)][:REPLY_USERS_MAX]


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
    # M12g keyword hits: members whose private notification keywords the body contains. Never sent
    # to clients (it would show one member's keywords to the others); counts and pushes read it.
    keyword_user_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid()), default=list, server_default=text("'{}'::uuid[]")
    )
    # Thread parent bookkeeping (DATA_MODEL.md "各操作と seq").
    reply_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_reply_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # C3: who replied, most recent first, at most REPLY_USERS_MAX (the live replies, as
    # reply_count counts them); kept with the counters so every MessageOut carries it for free.
    reply_user_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid()), default=list, server_default=text("'{}'::uuid[]")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Pinned in its channel (M11c): any member pins / unpins; the change consumes a seq.
    pinned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    pinned_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    # Poll (M14b): {question, options, multiple, anonymous, closed_at}; the votes live in
    # poll_votes. M53 scheduling polls add kind = "schedule", slots, tz and decided (and their
    # comments live in poll_comments).
    poll: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # M15e: "important" / "urgent" on a top-level post, and whether readers are asked to
    # acknowledge it (the acknowledgements live in message_acks).
    priority: Mapped[str | None] = mapped_column(String(16))
    ack_requested: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    # M88 (docs/MEMBERSHIP.md §1): what a system message says, as data —
    # {kind, actor_id, user_ids}; NULL on people's posts. The body is its plain-text fallback.
    system_event: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # M94 (docs/WORKFLOWS.md D4): posted through a workflow's form — which one, and its name
    # then (the label stays when the workflow is renamed or deleted). NULL on other posts.
    workflow_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("workflows.id"))
    workflow_name: Mapped[str | None] = mapped_column(String(40))

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
        # M61 (L8): the Times feed walks each channel's timeline newest first (migration 0055).
        Index(
            "messages_timeline_created_idx",
            "channel_id",
            text("created_at DESC"),
            text("id DESC"),
            postgresql_where=text("deleted_at IS NULL AND (parent_id IS NULL OR also_in_channel)"),
        ),
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
    """One user's vote for one option of a message's poll (M14b); in a scheduling poll (M53) their
    answer for one slot: 'yes' / 'maybe' / 'no'. A choice poll's votes are all 'yes'."""

    __tablename__ = "poll_votes"

    message_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("messages.id"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    option_index: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    answer: Mapped[str] = mapped_column(String(8), default="yes", server_default="yes")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (CheckConstraint("answer IN ('yes', 'maybe', 'no')", name="answer_values"),)


class PollComment(Base):
    """One person's short comment on a scheduling poll (M53, SCHEDULING.md §2)."""

    __tablename__ = "poll_comments"

    message_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    text: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (CheckConstraint("char_length(text) BETWEEN 1 AND 100", name="text_length"),)


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


def mentions_of(message: Any, user_id: uuid.UUID) -> ColumnElement[bool]:
    """The message (or an alias of it) mentions the user: by name, group, keyword or @channel."""
    return or_(
        message.mentioned_user_ids.contains([user_id]),
        message.keyword_user_ids.contains([user_id]),
        message.mention_all.is_(True),
    )
