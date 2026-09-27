import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class Draft(Base):
    """What I was writing in a conversation or a thread (M15d), shared by my devices.

    Text only: attachments picked on one device stay on that device.
    """

    __tablename__ = "drafts"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"))
    # The thread's parent for a reply draft; NULL for the conversation's own composer.
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE")
    )
    body: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (
        # One draft per composer; NULL parents count as equal (PostgreSQL 15+).
        Index(
            "drafts_user_composer_uniq",
            "user_id",
            "channel_id",
            "parent_id",
            unique=True,
            postgresql_nulls_not_distinct=True,
        ),
    )
