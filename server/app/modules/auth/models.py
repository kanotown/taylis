import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, LargeBinary, String, Text, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class Device(Base):
    """An installed app instance logged in as a user. One row per login (see DATA_MODEL.md)."""

    __tablename__ = "devices"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    platform: Mapped[str] = mapped_column(String(16))
    device_name: Mapped[str | None] = mapped_column(String(80))
    app_version: Mapped[str | None] = mapped_column(String(40))
    # M115: the UI language this app last asked for (Accept-Language, as ja / en / zh-Hans);
    # pushes to it use it when the person chose none (docs/I18N.md).
    locale: Mapped[str | None] = mapped_column(String(16))
    push_provider: Mapped[str] = mapped_column(
        String(8), default="none", server_default="none"
    )  # apns | fcm | none
    push_token: Mapped[str | None] = mapped_column(Text)
    push_environment: Mapped[str | None] = mapped_column(String(16))  # apns: sandbox | production
    push_token_invalid_reason: Mapped[str | None] = mapped_column(String(32))
    # The address this device reaches the server by (PUSH_NOTIFICATIONS.md §16): the iOS message
    # push's signed avatar URL starts with it. Kept at PUT /devices/current.
    base_url: Mapped[str | None] = mapped_column(String(255))
    enabled: Mapped[bool] = mapped_column(default=True, server_default=text("true"))
    disabled_reason: Mapped[str | None] = mapped_column(String(32))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )

    __table_args__ = (
        Index("devices_user_enabled_idx", "user_id", postgresql_where=text("enabled")),
        Index(
            "devices_push_token_uniq",
            "push_provider",
            "push_token",
            unique=True,
            postgresql_where=text("push_token IS NOT NULL"),
        ),
    )

    @property
    def push_registered(self) -> bool:
        return self.push_token is not None and self.push_provider != "none"


class UserSession(Base):
    """A refresh-token session bound to a device. Rotation rules: SECURITY.md §2.3."""

    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    device_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("devices.id"))
    refresh_token_hash: Mapped[bytes] = mapped_column(LargeBinary(32), unique=True)
    prev_token_hash: Mapped[bytes | None] = mapped_column(LargeBinary(32), unique=True)
    rotated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_ip: Mapped[str | None] = mapped_column(String(45))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    last_used_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoke_reason: Mapped[str | None] = mapped_column(String(32))

    __table_args__ = (
        Index("sessions_user_active_idx", "user_id", postgresql_where=text("revoked_at IS NULL")),
    )

    def is_valid(self, now: datetime) -> bool:
        return self.revoked_at is None and self.expires_at > now
