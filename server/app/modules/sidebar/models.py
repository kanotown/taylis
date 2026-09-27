import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, func
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
    position: Mapped[int] = mapped_column(Integer)
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
