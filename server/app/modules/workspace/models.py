import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, func
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
