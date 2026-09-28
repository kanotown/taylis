import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, Text, func
from sqlalchemy.dialects.postgresql import CITEXT
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class UserGroup(Base):
    """A named set of members that `<@group:id>` mentions expand to (DATA_MODEL.md user_groups)."""

    __tablename__ = "user_groups"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    name: Mapped[str] = mapped_column(CITEXT, unique=True)
    description: Mapped[str | None] = mapped_column(String(200))
    # M23: kept from the lab roster (b4, m1, …); such a group cannot be changed by hand.
    managed_key: Mapped[str | None] = mapped_column(Text, unique=True)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )


class UserGroupMember(Base):
    __tablename__ = "user_group_members"

    group_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("user_groups.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (Index("user_group_members_user_idx", "user_id"),)
