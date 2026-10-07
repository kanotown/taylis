"""操作ボタン (actions, M143, docs/ACTIONS.md §3): buttons that send one signed request to an
outside relay, the switch, and the record of every press."""

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
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class ActionSettings(Base):
    """The administrator's switches (one row; a missing row reads as the defaults: off)."""

    __tablename__ = "action_settings"

    singleton: Mapped[bool] = mapped_column(Boolean, primary_key=True, default=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    # Also on the 在室状況 page and its pill's menu (docs/ACTIONS.md D17).
    show_on_attendance: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    # Days the presses are kept; 0 = for good.
    log_retention_days: Mapped[int] = mapped_column(
        Integer, default=365, server_default=text("365")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    __table_args__ = (CheckConstraint("singleton", name="action_settings_singleton"),)


class Action(Base):
    """One button: where it sends (url + the name of the signing key's file, never the key) and
    who may press it (any of the roles, groups and people; never guests or bots)."""

    __tablename__ = "actions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    name: Mapped[str] = mapped_column(String(40))
    group_label: Mapped[str | None] = mapped_column(String(40))
    # A key of apps/shared/attendance-icons.json; NULL = none (the emoji, if any).
    icon: Mapped[str | None] = mapped_column(String(32))
    emoji: Mapped[str | None] = mapped_column(String(32))
    action_key: Mapped[str] = mapped_column(String(100))
    url: Mapped[str] = mapped_column(Text)
    secret_name: Mapped[str] = mapped_column(Text)
    confirm: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    confirm_text: Mapped[str | None] = mapped_column(String(200))
    allowed_roles: Mapped[list[str]] = mapped_column(
        ARRAY(Text), default=list, server_default=text("'{}'")
    )
    allowed_group_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), default=list, server_default=text("'{}'")
    )
    allowed_user_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), default=list, server_default=text("'{}'")
    )
    notice_channel_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("channels.id", ondelete="SET NULL")
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    position: Mapped[int] = mapped_column(Integer)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )


class ActionInvocation(Base):
    """One press (or an administrator's test). Its id is the invoke_id the relay dedupes by."""

    __tablename__ = "action_invocations"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    action_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("actions.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    # The client's idempotency key (NULL for a test).
    client_invoke_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    kind: Mapped[str] = mapped_column(Text)  # invoke | test
    status: Mapped[str] = mapped_column(Text)  # pending | succeeded | failed
    status_code: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)
    message: Mapped[str | None] = mapped_column(String(200))
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("user_id", "client_invoke_id", name="action_invocations_client_uq"),
        CheckConstraint("kind IN ('invoke', 'test')", name="action_invocations_kind"),
        CheckConstraint(
            "status IN ('pending', 'succeeded', 'failed')", name="action_invocations_status"
        ),
        Index("action_invocations_action_idx", "action_id", "created_at"),
        Index("action_invocations_created_idx", "created_at"),
    )
