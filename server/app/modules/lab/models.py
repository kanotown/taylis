import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, SmallInteger, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.time import utcnow


class LabProfile(Base):
    """One person's line in the lab roster (DATA_MODEL.md lab_profiles, M23). For display and the
    managed groups only: roles and permissions never read it."""

    __tablename__ = "lab_profiles"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    affiliation: Mapped[str] = mapped_column(Text)  # faculty | student | alumni | other
    rank: Mapped[str | None] = mapped_column(Text)  # faculty only
    grade: Mapped[str | None] = mapped_column(Text)  # students only
    supervisor_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    research_topic: Mapped[str | None] = mapped_column(String(200))
    reading: Mapped[str | None] = mapped_column(String(80))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )


class LabRollover(Base):
    """One academic year's rollover (L7, DATA_MODEL.md lab_rollovers): who moved up, stayed or
    graduated, and what each person was before, so it can be undone."""

    __tablename__ = "lab_rollovers"

    academic_year: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    applied_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    applied_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    before: Mapped[dict[str, Any]] = mapped_column(JSONB)
    undone_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
