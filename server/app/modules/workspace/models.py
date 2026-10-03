import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Uuid, func, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.time import utcnow


class WorkspaceIdentity(Base):
    """The one row naming this deployment (WORKSPACES.md §3): clients route pushes by its id."""

    __tablename__ = "workspace_identity"

    singleton: Mapped[bool] = mapped_column(Boolean, primary_key=True, default=True)
    id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (CheckConstraint("singleton", name="workspace_identity_singleton"),)


class WorkspaceSettings(Base):
    """Workspace-wide switches an administrator sets (M88, docs/MEMBERSHIP.md §3). One row; a
    missing row reads as the defaults (a database restored from before M88, the tests)."""

    __tablename__ = "workspace_settings"

    singleton: Mapped[bool] = mapped_column(Boolean, primary_key=True, default=True)
    # 「参加・退出の表示」: join / leave lines in public and private channels.
    show_membership_messages: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=text("true")
    )
    # 「参加前にチャンネルの中を見られる」: M27's preview of a public channel before joining.
    preview_before_join: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=text("true")
    )
    # 「既定のチャンネル」 (M90, MEMBERSHIP.md §6): public channels every new non-guest account
    # joins, in order. None = never set (SSO_DEFAULT_CHANNELS still applies to Google sign-in).
    default_channel_ids: Mapped[list[uuid.UUID] | None] = mapped_column(ARRAY(Uuid))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    __table_args__ = (CheckConstraint("singleton", name="workspace_settings_singleton"),)
