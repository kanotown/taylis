import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Index, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.time import utcnow


class ThreadFollow(Base):
    """One user's relation to one thread parent (THREADS.md §2). Counts are derived from replies."""

    __tablename__ = "thread_follows"

    parent_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("messages.id"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    # false: the user unfollowed by hand; auto-follow never flips it back.
    following: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    # Channel seq of the last reply the user has read in this thread (0: none).
    last_read_seq: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (Index("thread_follows_user_idx", "user_id", "following"),)
