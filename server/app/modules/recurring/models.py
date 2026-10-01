import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow

MAX_NAME_LENGTH = 40
MAX_BODY_LENGTH = 4000


class RecurringPost(Base):
    """A channel's recurring post (RECURRING.md §2, DATA_MODEL.md recurring_posts): its own bot
    posts the template on a weekly or monthly schedule, optionally collecting replies."""

    __tablename__ = "recurring_posts"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    bot_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    name: Mapped[str] = mapped_column(String(MAX_NAME_LENGTH))
    body: Mapped[str] = mapped_column(Text)
    # {"kind": "weekly", "weekdays": [0..6], "time": "HH:MM"} | {"kind": "monthly", "day": 1..31,
    # "time": "HH:MM"} (0 = Monday; a day past the month's end runs on its last day).
    schedule: Mapped[dict[str, Any]] = mapped_column(JSONB)
    tz: Mapped[str] = mapped_column(String(64))
    # NULL, or {"targets": {"group_ids": [...], "user_ids": [...], "all_members": bool},
    # "due": {"after_days": n, "time": "HH:MM"}}.
    collect: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    next_run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(f"char_length(name) BETWEEN 1 AND {MAX_NAME_LENGTH}", name="name_length"),
        CheckConstraint(f"char_length(body) BETWEEN 1 AND {MAX_BODY_LENGTH}", name="body_length"),
        Index(
            "recurring_posts_due_idx",
            "next_run_at",
            postgresql_where=text("enabled AND deleted_at IS NULL"),
        ),
        Index(
            "recurring_posts_channel_idx",
            "channel_id",
            postgresql_where=text("deleted_at IS NULL"),
        ),
    )


class Collection(Base):
    """One collecting post (RECURRING.md §2): who must reply in its thread, by when, and whether
    the nudge went out. Submissions are not stored: they are the targets among the authors of the
    thread's live replies."""

    __tablename__ = "collections"

    message_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("messages.id"), primary_key=True)
    recurring_post_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("recurring_posts.id"))
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"))
    # Fixed when posted (channel members then, by display name); never changes afterwards.
    target_user_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid()), default=list, server_default=text("'{}'::uuid[]")
    )
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    reminded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (
        Index("collections_due_idx", "due_at", postgresql_where=text("reminded_at IS NULL")),
    )
