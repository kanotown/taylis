import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, LargeBinary, String, Text, func
from sqlalchemy.dialects.postgresql import CITEXT
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class UserIdentity(Base):
    """An external account (Google's `sub`) that signs in as a user (M48, docs/SSO.md §5)."""

    __tablename__ = "user_identities"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    provider: Mapped[str] = mapped_column(String(16))  # google
    subject: Mapped[str] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(CITEXT)  # as the provider reported it at link time
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("user_identities_provider_subject_uniq", "provider", "subject", unique=True),
        Index("user_identities_user_idx", "user_id"),
    )


class SsoRequest(Base):
    """One started sign-in: what the callback needs, bound to the browser by the state cookie."""

    __tablename__ = "sso_requests"

    state: Mapped[str] = mapped_column(Text, primary_key=True)
    nonce: Mapped[str] = mapped_column(Text)
    code_verifier: Mapped[str] = mapped_column(Text)  # PKCE with Google
    challenge: Mapped[str] = mapped_column(Text)  # the app's, copied onto the ticket
    platform: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (Index("sso_requests_expires_idx", "expires_at"),)


class SsoTicket(Base):
    """A one-time ticket the app exchanges for tokens; only its SHA-256 is kept."""

    __tablename__ = "sso_tickets"

    ticket_hash: Mapped[bytes] = mapped_column(LargeBinary, primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    challenge: Mapped[str] = mapped_column(Text)
    platform: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (Index("sso_tickets_expires_idx", "expires_at"),)
