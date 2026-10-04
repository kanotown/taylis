import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow

MAX_URL_LENGTH = 2048


class ChannelFeed(Base):
    """An RSS / Atom feed a member registered in a channel (docs/FEEDS.md §2, DATA_MODEL.md
    channel_feeds). New entries are posted by the channel's feed bot (one per channel, shared by
    its feeds) in the owner's name."""

    __tablename__ = "channel_feeds"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"))
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    bot_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    url: Mapped[str] = mapped_column(String(MAX_URL_LENGTH))
    title: Mapped[str | None] = mapped_column(String(200))
    site_url: Mapped[str | None] = mapped_column(String(MAX_URL_LENGTH))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    # The next fetch only records what is there (resumed, or back from a pause the worker made
    # because the channel was archived or the owner gone): nothing published meanwhile is posted.
    needs_baseline: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    etag: Mapped[str | None] = mapped_column(String(512))
    last_modified: Mapped[str | None] = mapped_column(String(128))
    # Hashes of the entries already seen (the current document's first), at most MAX_SEEN.
    seen_keys: Mapped[list[str]] = mapped_column(
        ARRAY(String(32)), default=list, server_default=text("'{}'::varchar[]")
    )
    next_fetch_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error_code: Mapped[str | None] = mapped_column(String(32))
    last_error: Mapped[str | None] = mapped_column(String(300))
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    failure_notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    post_count: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    last_post_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("channel_id", "url", name="channel_feeds_channel_url_uniq"),
        Index("channel_feeds_due_idx", "next_fetch_at", postgresql_where=text("enabled")),
        Index("channel_feeds_owner_idx", "owner_id"),
    )


class ChannelFeedBot(Base):
    """M98 (docs/FEEDS.md §2): the bot a channel's feeds post as. Kept after the last feed goes,
    so the bot (and the name its owners gave it) comes back with the next feed. `adopted`: an
    administrator chose an existing bot (an imported one) for it; such a bot is never deactivated
    or taken out of the channel by the feeds."""

    __tablename__ = "channel_feed_bots"

    channel_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), primary_key=True
    )
    bot_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), unique=True)
    adopted: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )
