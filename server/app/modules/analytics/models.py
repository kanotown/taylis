import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base


class UserActivityHour(Base):
    """M116 (docs/ANALYTICS.md §2): someone used an app during this UTC hour. One row per person
    and hour, written by the activity tracker's flush; the daily active-member series counts them.
    Kept for ACTIVITY_RETENTION_DAYS."""

    __tablename__ = "user_activity_hours"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    hour: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)

    __table_args__ = (Index("user_activity_hours_hour_idx", "hour"),)
