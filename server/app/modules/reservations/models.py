import uuid
from datetime import datetime

from sqlalchemy import (
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
from sqlalchemy import text as sql_text  # (ReservationNotice has a column named text)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow

MAX_NAME_LENGTH = 80
# A request that still takes part in the pool: in the queue, booked for later, or on a seat.
ACTIVE_STATUSES = ("waiting", "booked", "holding", "returning")
SEATED_STATUSES = ("holding", "returning")


class ReservationPool(Base):
    """A shared, limited resource of the workspace (docs/RESERVATIONS.md §2, M112): `capacity`
    seats that members book by the hour (up to `max_hours` at a time, two weeks ahead) or queue
    for right now; operators hand them out by hand (outside Taylis) and press the buttons here.
    A walk-in keeps a seat at least `min_hours` from assignment (less when a booking needs the seat
    sooner); past that, a waiting member takes it after `grace_minutes` of notice.

    Visible to every member (not guests) unless `visibility` narrows it to a channel's or a group's
    members (the operators, the creator and the administrators always see it). `log_channel_id`:
    the optional channel the 「予約」 bot writes a line in for each change (none by default)."""

    __tablename__ = "reservation_pools"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    name: Mapped[str] = mapped_column(String(MAX_NAME_LENGTH))
    capacity: Mapped[int] = mapped_column(Integer)
    # Walk-ins: the guarantee from assignment (hours).
    min_hours: Mapped[int] = mapped_column(Integer)
    # Bookings: the longest one (hours).
    max_hours: Mapped[int] = mapped_column(Integer, default=6, server_default=text("6"))
    grace_minutes: Mapped[int] = mapped_column(Integer)
    # The zone of the booking grid (whole hours) and of the times the notices write.
    tz: Mapped[str] = mapped_column(String(64))
    operator_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), default=list, server_default=text("'{}'::uuid[]")
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    log_channel_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("channels.id", ondelete="SET NULL")
    )
    # all / channel / group. A narrowed pool whose channel or group is gone shows to the
    # operators, the creator and the administrators only (fails closed).
    visibility: Mapped[str] = mapped_column(String(16), default="all", server_default=text("'all'"))
    visibility_channel_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("channels.id", ondelete="SET NULL")
    )
    visibility_group_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("user_groups.id", ondelete="SET NULL")
    )
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )


class ReservationBot(Base):
    """The bot (role bot, users.bot_kind = "reservation") that writes the pools' log lines in a
    channel: one per log channel, made the first time a pool logs there, kept afterwards."""

    __tablename__ = "reservation_bots"

    channel_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), primary_key=True
    )
    bot_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )


class Reservation(Base):
    """One member's request in a pool (docs/RESERVATIONS.md §2).

    kind walkin: waiting → holding → (returning →) done, or waiting → cancelled.
    kind booking: booked (start_at..end_at, whole hours) → holding → (returning →) done, or
    booked → cancelled, or booked → done (end_reason expired: nobody assigned it in time).
    Ended rows stay as the history."""

    __tablename__ = "reservations"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    pool_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("reservation_pools.id", ondelete="CASCADE")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    kind: Mapped[str] = mapped_column(String(8), default="walkin", server_default=text("'walkin'"))
    status: Mapped[str] = mapped_column(String(16))
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # A booking's slot.
    start_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    end_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    assigned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    assigned_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    # A walk-in: min(assignment + min_hours, when a booking needs the seat); a booking: end_at.
    guarantee_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    returned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # A walk-in past the guarantee whom someone needs: told at evict_notice_at that the seat goes
    # at evict_at.
    evict_notice_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    evict_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    # cancelled / returned / removed / expired
    end_reason: Mapped[str | None] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )

    __table_args__ = (
        # One walk-in request at a time per person and pool.
        Index(
            "reservations_walkin_uniq",
            "pool_id",
            "user_id",
            unique=True,
            postgresql_where=text(
                "kind = 'walkin' AND status IN ('waiting', 'holding', 'returning')"
            ),
        ),
        Index(
            "reservations_pool_active_idx",
            "pool_id",
            "status",
            postgresql_where=text("status IN ('waiting', 'booked', 'holding', 'returning')"),
        ),
        Index("reservations_pool_end_idx", "pool_id", "end_at"),
        Index("reservations_user_idx", "user_id"),
    )


class ReservationNotice(Base):
    """An activity item of kind reservation (docs/RESERVATIONS.md §5): a notice to one person,
    written with a `reservation.notice` event (the push) in the change's transaction.

    `operator`: a to-do sent to every operator under one `key` (assign:<id>, swap:<id>:<id>,
    remove:<id>, booking:<id>); once the to-do is gone (one of them pressed the button, or it is
    no longer needed), every copy is marked done. A member's own notices have no done state."""

    __tablename__ = "reservation_notices"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    pool_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("reservation_pools.id", ondelete="CASCADE")
    )
    reservation_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("reservations.id", ondelete="CASCADE")
    )
    key: Mapped[str] = mapped_column(String(200))
    operator: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    text: Mapped[str] = mapped_column(Text)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    done_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))

    __table_args__ = (
        UniqueConstraint("user_id", "key", name="reservation_notices_user_key_uniq"),
        Index("reservation_notices_user_idx", "user_id", sql_text("at DESC")),
        Index(
            "reservation_notices_open_idx",
            "pool_id",
            postgresql_where=sql_text("operator AND done_at IS NULL"),
        ),
    )
