import uuid
from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow

# CALENDAR.md §2: a timed event lasts at most 14 days, an all-day one at most 60 days.
MAX_TIMED_DAYS = 14
MAX_ALL_DAY_DAYS = 60
# minutes_before: before the start of a timed event; for an all-day one 1440 = 前日 8:00 and
# -480 = 当日 8:00 (8:00 in the alarm's zone).
TIMED_ALARMS = (0, 5, 10, 15, 30, 60, 1440)
ALL_DAY_ALARMS = (1440, -480)


class CalendarEvent(Base):
    """A one-off event in someone's own calendar (channel_id NULL) or a channel's shared one
    (DATA_MODEL.md calendar_events, CALENDAR.md §2). Who sees it follows the channel's
    membership; it does not use the channel's seq."""

    __tablename__ = "calendar_events"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    channel_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("channels.id"))
    # Who made it; the only one who sees a personal event.
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    title: Mapped[str] = mapped_column(Text)
    all_day: Mapped[bool] = mapped_column(Boolean)
    # A timed event: [starts_at, ends_at). An all-day one: start_date..end_date (end included).
    starts_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    start_date: Mapped[date | None] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    location: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    # Idempotency key of the POST that made it (a retry returns this event).
    client_event_id: Mapped[uuid.UUID | None] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("char_length(title) BETWEEN 1 AND 200", name="title_length"),
        CheckConstraint("location IS NULL OR char_length(location) <= 200", name="location_length"),
        CheckConstraint(
            "description IS NULL OR char_length(description) <= 4000", name="description_length"
        ),
        CheckConstraint(
            "(all_day AND starts_at IS NULL AND ends_at IS NULL"
            " AND start_date IS NOT NULL AND end_date IS NOT NULL"
            f" AND end_date >= start_date AND end_date - start_date < {MAX_ALL_DAY_DAYS})"
            " OR (NOT all_day AND start_date IS NULL AND end_date IS NULL"
            " AND starts_at IS NOT NULL AND ends_at IS NOT NULL"
            " AND ends_at > starts_at"
            f" AND ends_at - starts_at <= interval '{MAX_TIMED_DAYS} days')",
            name="time_shape",
        ),
        Index(
            "calendar_events_channel_idx",
            "channel_id",
            "starts_at",
            postgresql_where=text("channel_id IS NOT NULL AND NOT all_day AND deleted_at IS NULL"),
        ),
        Index(
            "calendar_events_personal_idx",
            "owner_id",
            "starts_at",
            postgresql_where=text("channel_id IS NULL AND NOT all_day AND deleted_at IS NULL"),
        ),
        Index(
            "calendar_events_channel_day_idx",
            "channel_id",
            "start_date",
            postgresql_where=text("channel_id IS NOT NULL AND all_day AND deleted_at IS NULL"),
        ),
        Index(
            "calendar_events_personal_day_idx",
            "owner_id",
            "start_date",
            postgresql_where=text("channel_id IS NULL AND all_day AND deleted_at IS NULL"),
        ),
        Index(
            "calendar_events_client_uniq",
            "owner_id",
            "client_event_id",
            unique=True,
            postgresql_where=text("client_event_id IS NOT NULL"),
        ),
    )

    @property
    def is_deleted(self) -> bool:
        return self.deleted_at is not None


class CalendarEventAlarm(Base):
    """One person's alarm on an event (CALENDAR.md §2, §6): only they are notified.

    pending → fired, or cancelled (the event was deleted, they left the channel, or the time
    it works out to has passed). `tz` is the zone of the device that set it: 8:00 of an all-day
    event and the time in the notification are read in it."""

    __tablename__ = "calendar_event_alarms"

    event_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("calendar_events.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    minutes_before: Mapped[int] = mapped_column(Integer)
    tz: Mapped[str] = mapped_column(String(64))
    fire_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "minutes_before IN (0, 5, 10, 15, 30, 60, 1440, -480)", name="minutes_before_values"
        ),
        CheckConstraint("status IN ('pending', 'fired', 'cancelled')", name="status_values"),
        Index(
            "calendar_event_alarms_due_idx",
            "fire_at",
            postgresql_where=text("status = 'pending'"),
        ),
        Index(
            "calendar_event_alarms_user_idx",
            "user_id",
            postgresql_where=text("status = 'pending'"),
        ),
    )
