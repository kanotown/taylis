import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Uuid, func, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow

MAX_NAME_LENGTH = 80
# A request that still takes part in the pool: in the queue, or holding a seat.
ACTIVE_STATUSES = ("waiting", "holding", "returning")


class ReservationPool(Base):
    """A shared, limited resource of a channel (docs/RESERVATIONS.md §2): `capacity` seats that
    members queue for; operators hand them out by hand (outside Taylis) and press the buttons
    here. A holder keeps a seat at least `min_hours` from assignment; past that, a waiting member
    takes it after `grace_minutes` of notice."""

    __tablename__ = "reservation_pools"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(MAX_NAME_LENGTH))
    capacity: Mapped[int] = mapped_column(Integer)
    min_hours: Mapped[int] = mapped_column(Integer)
    grace_minutes: Mapped[int] = mapped_column(Integer)
    # The zone the bot's posts and notes write times in (the creating device's).
    tz: Mapped[str] = mapped_column(String(64))
    operator_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), default=list, server_default=text("'{}'::uuid[]")
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )

    __table_args__ = (Index("reservation_pools_channel_idx", "channel_id"),)


class ReservationBot(Base):
    """The bot (role bot, users.bot_kind = "reservation") a channel's pools post as: one per
    channel, made with its first pool, kept afterwards."""

    __tablename__ = "reservation_bots"

    channel_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), primary_key=True
    )
    bot_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )


class Reservation(Base):
    """One member's request in a pool, from the queue to the end of the holding
    (docs/RESERVATIONS.md §2). status: waiting → holding → (returning →) done, or waiting →
    cancelled. Ended rows stay as the history."""

    __tablename__ = "reservations"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    pool_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("reservation_pools.id", ondelete="CASCADE")
    )
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(16))
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    assigned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    assigned_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    guarantee_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    returned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # A holder past the guarantee whom a waiting member needs: told at evict_notice_at that the
    # seat goes at evict_at (= notice + grace).
    evict_notice_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    evict_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # When the operators were told there is something to do with this row (assign it, or take
    # its seat for the next one).
    ready_notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    # cancelled / returned / removed
    end_reason: Mapped[str | None] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )

    __table_args__ = (
        # One request at a time per person and pool.
        Index(
            "reservations_active_uniq",
            "pool_id",
            "user_id",
            unique=True,
            postgresql_where=text("status IN ('waiting', 'holding', 'returning')"),
        ),
        Index(
            "reservations_pool_active_idx",
            "pool_id",
            "status",
            postgresql_where=text("status IN ('waiting', 'holding', 'returning')"),
        ),
        Index("reservations_user_idx", "user_id"),
    )
