import uuid
from datetime import datetime

from sqlalchemy import DateTime, SmallInteger, String, Text, func, text
from sqlalchemy.dialects.postgresql import ARRAY, CITEXT
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    username: Mapped[str] = mapped_column(CITEXT, unique=True)
    display_name: Mapped[str] = mapped_column(String(80))
    email: Mapped[str | None] = mapped_column(CITEXT, unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    must_change_password: Mapped[bool] = mapped_column(default=True, server_default=text("true"))
    role: Mapped[str] = mapped_column(String(16), default="member", server_default="member")
    # Profile card (M11d): job title and a custom status that may expire.
    title: Mapped[str | None] = mapped_column(String(80))
    status_text: Mapped[str | None] = mapped_column(String(100))
    status_emoji: Mapped[str | None] = mapped_column(String(32))
    status_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Do not disturb (M12c): a manual pause and a daily quiet-hours window in the user's zone.
    dnd_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    quiet_hours_start: Mapped[int | None] = mapped_column(SmallInteger)  # minutes after midnight
    quiet_hours_end: Mapped[int | None] = mapped_column(SmallInteger)
    quiet_hours_days: Mapped[list[int] | None] = mapped_column(ARRAY(SmallInteger))  # 0 = Monday
    quiet_hours_tz: Mapped[str | None] = mapped_column(Text)
    # Keyword notifications (M12g): a message containing one counts as a mention of me.
    notify_keywords: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )
    deactivated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    @property
    def is_active(self) -> bool:
        return self.deactivated_at is None

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"
