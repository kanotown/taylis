import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class EmojiPack(Base):
    """A named set of custom emoji with its own picker tab (docs/EMOJI.md, M100)."""

    __tablename__ = "emoji_packs"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # The tab icon in the object store (emoji-packs/<id>/tab-<uuid>); NULL = the first emoji.
    tab_content_type: Mapped[str | None] = mapped_column(Text)
    tab_storage_key: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )


class CustomEmoji(Base):
    """A workspace emoji (DATA_MODEL.md custom_emoji): an image in the object store (kind
    "image") or a short label drawn as a pill (kind "text", M100)."""

    __tablename__ = "custom_emoji"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    name: Mapped[str] = mapped_column(String(32), unique=True)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    kind: Mapped[str] = mapped_column(String(8), default="image", server_default="image")
    # Text emoji: "" / 0 / 0x0 / "" (no image).
    content_type: Mapped[str] = mapped_column(Text)
    size_bytes: Mapped[int] = mapped_column(Integer)
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    storage_key: Mapped[str] = mapped_column(Text)
    label: Mapped[str | None] = mapped_column(String(32))
    color: Mapped[str | None] = mapped_column(String(16))
    keywords: Mapped[list[str]] = mapped_column(
        ARRAY(Text), default=list, server_default=text("'{}'::text[]")
    )
    pack_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("emoji_packs.id", ondelete="SET NULL")
    )
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
