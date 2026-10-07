"""在室状況 (attendance, M140, docs/PRESENCE.md §2): who is where, the states to choose from, the
append-only log, and the integrations with outside systems (outgoing webhooks, incoming API)."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class AttendanceSettings(Base):
    """The administrator's switches (one row; a missing row reads as the defaults: off)."""

    __tablename__ = "attendance_settings"

    singleton: Mapped[bool] = mapped_column(Boolean, primary_key=True, default=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    # Who may add personal states: nobody | everyone | admins | groups (personal_group_ids).
    personal_rule: Mapped[str] = mapped_column(Text, default="nobody", server_default="nobody")
    personal_group_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), default=list, server_default=text("'{}'")
    )
    # Days the log is kept; 0 = for good.
    log_retention_days: Mapped[int] = mapped_column(
        Integer, default=365, server_default=text("365")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    __table_args__ = (
        CheckConstraint("singleton", name="attendance_settings_singleton"),
        CheckConstraint(
            "personal_rule IN ('nobody', 'everyone', 'admins', 'groups')",
            name="attendance_settings_rule",
        ),
    )


class AttendanceState(Base):
    """A state to choose: the workspace's (owner_id NULL) or one person's own. Deleting archives
    it, so the people in it and the log keep a label."""

    __tablename__ = "attendance_states"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    label: Mapped[str] = mapped_column(String(40))
    # A key of apps/shared/attendance-icons.json (migration 0101); NULL = none (the emoji, if any).
    icon: Mapped[str | None] = mapped_column(String(32))
    emoji: Mapped[str | None] = mapped_column(String(32))
    color: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(Text)  # in_room | on_site | off_site | gone
    position: Mapped[int] = mapped_column(Integer)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "kind IN ('in_room', 'on_site', 'off_site', 'gone')", name="attendance_states_kind"
        ),
        Index("attendance_states_owner_idx", "owner_id"),
    )


class AttendanceCurrent(Base):
    """One person's state now (at most one row per person)."""

    __tablename__ = "attendance_current"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    state_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("attendance_states.id"))
    since: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    note: Mapped[str | None] = mapped_column(String(100))
    source: Mapped[str] = mapped_column(Text)  # app | admin | integration | auto
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    integration_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )


class AttendanceLog(Base):
    """Every change, appended (purged after the retention)."""

    __tablename__ = "attendance_log"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    from_state_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    to_state_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    note: Mapped[str | None] = mapped_column(String(100))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    source: Mapped[str] = mapped_column(Text)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    integration_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)

    __table_args__ = (
        Index("attendance_log_user_idx", "user_id", "id"),
        Index("attendance_log_at_idx", "at"),
    )


class AttendanceIntegration(Base):
    """An outside system: where changes are sent (url + the name of the signing key's file)
    and/or the token it sends changes with (stored hashed)."""

    __tablename__ = "attendance_integrations"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    name: Mapped[str] = mapped_column(String(80))
    url: Mapped[str | None] = mapped_column(Text)
    secret_name: Mapped[str | None] = mapped_column(Text)
    token_hash: Mapped[bytes | None] = mapped_column(LargeBinary, unique=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    last_inbound_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AttendanceDelivery(Base):
    """One webhook delivery (its id is the delivery_id the receiver dedupes by)."""

    __tablename__ = "attendance_deliveries"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    integration_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("attendance_integrations.id", ondelete="CASCADE")
    )
    outbox_event_id: Mapped[int | None] = mapped_column(BigInteger)
    log_id: Mapped[int | None] = mapped_column(BigInteger)
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    event: Mapped[str] = mapped_column(Text)  # attendance.changed | attendance.test
    body: Mapped[dict[str, Any]] = mapped_column(JSONB)
    # pending | delivered | failed | superseded
    status: Mapped[str] = mapped_column(Text, default="pending", server_default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    last_status_code: Mapped[int | None] = mapped_column(Integer)
    last_error: Mapped[str | None] = mapped_column(Text)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "outbox_event_id", "integration_id", name="attendance_deliveries_event_uq"
        ),
        Index(
            "attendance_deliveries_due_idx",
            "next_attempt_at",
            postgresql_where=text("status = 'pending'"),
        ),
        Index("attendance_deliveries_integration_idx", "integration_id", "created_at"),
    )
