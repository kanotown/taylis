import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    false,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class SidebarSection(Base):
    """A section of one user's sidebar (M14f), e.g. 「プロジェクト」. Personal: no channel seq."""

    __tablename__ = "sidebar_sections"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    name: Mapped[str] = mapped_column(String(40))
    # M26: an emoji (or a custom emoji `:name:`) before the name, and whether it is folded up.
    emoji: Mapped[str | None] = mapped_column(String(64))
    collapsed: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    position: Mapped[int] = mapped_column(Integer)
    # 2026-10-07 (DATA_MODEL.md 「並べ替え」): "name" / "recent" / "manual", and the hand-made order
    # as the conversation ids in order (ids no longer here are skipped by the clients).
    sort: Mapped[str] = mapped_column(String(10), default="name", server_default="name")
    manual_order: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(PG_UUID(as_uuid=True)), default=list, server_default=text("'{}'")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (Index("sidebar_sections_user_idx", "user_id", "position"),)


class SidebarSectionChannel(Base):
    """A conversation placed in one of my sections; at most one section per conversation."""

    __tablename__ = "sidebar_section_channels"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"), primary_key=True)
    section_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sidebar_sections.id", ondelete="CASCADE")
    )
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (Index("sidebar_section_channels_section_idx", "section_id"),)


class SidebarDefaultSection(Base):
    """The sort of one of my default sections (お気に入り / チャンネル / ダイレクトメッセージ),
    which have no sidebar_sections row; no row = the default (name, for the DMs recent)."""

    __tablename__ = "sidebar_default_sections"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    key: Mapped[str] = mapped_column(String(16), primary_key=True)
    sort: Mapped[str] = mapped_column(String(10))
    manual_order: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(PG_UUID(as_uuid=True)), default=list, server_default=text("'{}'")
    )

    __table_args__ = (
        CheckConstraint(
            "key IN ('favorites', 'channels', 'dms')", name="sidebar_default_sections_key"
        ),
    )
