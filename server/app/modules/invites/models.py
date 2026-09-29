import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Index, Integer, LargeBinary, String, Uuid, func, text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class Invite(Base):
    """An admin-issued invitation link (DATA_MODEL.md invites). Only the token's hash is kept."""

    __tablename__ = "invites"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    token_hash: Mapped[bytes] = mapped_column(LargeBinary, unique=True)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    role: Mapped[str] = mapped_column(String(16), default="member", server_default="member")
    # Channels the new account joins on acceptance (public, or private ones the issuer is in).
    channel_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(Uuid), default=list)
    note: Mapped[str | None] = mapped_column(String(80))
    # L7: the roster line (and times) the new account gets, as LabPreset JSON; NULL = none.
    lab_preset: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    max_uses: Mapped[int | None] = mapped_column(Integer)  # NULL = unlimited until it expires
    use_count: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    used_by: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(Uuid), default=list)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (Index("invites_created_idx", "created_at"),)
