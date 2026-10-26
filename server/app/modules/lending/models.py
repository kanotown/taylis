"""備品 (equipment lending, M167, docs/LENDING.md §4): the settings, the categories, the items and
each item's history. The loans (0124) and the notices and watches (0125) come in later stages."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow

ITEM_STATUSES = ("available", "on_loan", "in_repair", "retired")

DEFAULT_MAX_DAYS = 14
DEFAULT_MAX_EXTENSIONS = 2
DEFAULT_KEEPER_OVERDUE_DAYS = 3
DEFAULT_NOTICE_MINUTE = 9 * 60
DEFAULT_TZ = "Asia/Tokyo"


class LendingSettings(Base):
    """The workspace's switch and defaults (one row; a missing row reads as the defaults: off).
    `keeper_ids` (備品係, at most 20) has no foreign key: only the active people among them count
    (lending.access.can_keep)."""

    __tablename__ = "lending_settings"

    singleton: Mapped[bool] = mapped_column(Boolean, primary_key=True, default=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    keeper_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), default=list, server_default=text("'{}'::uuid[]")
    )
    # The longest loan when neither the item nor its category says (days from today, 1-365).
    default_max_days: Mapped[int] = mapped_column(
        Integer, default=DEFAULT_MAX_DAYS, server_default=text(str(DEFAULT_MAX_DAYS))
    )
    # How often a borrower may extend a loan themself (0-10; keepers are not limited).
    max_extensions: Mapped[int] = mapped_column(
        Integer, default=DEFAULT_MAX_EXTENSIONS, server_default=text(str(DEFAULT_MAX_EXTENSIONS))
    )
    # Days past the due date before the keepers are told (1-30).
    keeper_overdue_days: Mapped[int] = mapped_column(
        Integer,
        default=DEFAULT_KEEPER_OVERDUE_DAYS,
        server_default=text(str(DEFAULT_KEEPER_OVERDUE_DAYS)),
    )
    # The morning notices' time (minutes from midnight in `tz`).
    notice_minute: Mapped[int] = mapped_column(
        Integer, default=DEFAULT_NOTICE_MINUTE, server_default=text(str(DEFAULT_NOTICE_MINUTE))
    )
    # The zone of the due dates and of the notices' time (docs/LENDING.md §8.1).
    tz: Mapped[str] = mapped_column(
        String(64), default=DEFAULT_TZ, server_default=text(f"'{DEFAULT_TZ}'")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    __table_args__ = (CheckConstraint("singleton", name="lending_settings_singleton"),)


class LendingCategory(Base):
    """A category (PC, カメラ, 本 …; at most 50) with the defaults of its items."""

    __tablename__ = "lending_categories"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    name: Mapped[str] = mapped_column(String(40))
    # NFC + casefold: one name once.
    name_key: Mapped[str] = mapped_column(Text, unique=True)
    position: Mapped[int] = mapped_column(Integer)
    requires_permission: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    # NULL = lending_settings.default_max_days.
    max_days: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )


class LendingItem(Base):
    """One numbered thing that is lent (at most 2,000, the retired ones included).

    `status` is changed only by the service holding the row's lock: available, on_loan (with
    `current_loan_id`, from L2), in_repair or retired. The control number (`code`) is unique among
    the items that are not retired, so a retired 「PC-03」's number can be given again."""

    __tablename__ = "lending_items"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    name: Mapped[str] = mapped_column(String(80))
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("lending_categories.id", ondelete="RESTRICT")
    )
    code: Mapped[str | None] = mapped_column(String(40))
    # NFC + casefold + trimmed.
    code_key: Mapped[str | None] = mapped_column(Text)
    location: Mapped[str | None] = mapped_column(String(80))
    # Accessories and notes (at most 2,000 characters).
    notes: Mapped[str | None] = mapped_column(Text)
    photo_attachment_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("attachments.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(
        String(16), default="available", server_default=text("'available'")
    )
    # Why it is in repair or retired (keepers).
    status_note: Mapped[str | None] = mapped_column(String(200))
    # NULL = the category's default.
    requires_permission: Mapped[bool | None] = mapped_column(Boolean)
    # NULL = the category's, then the settings' default (1-365).
    max_days: Mapped[int | None] = mapped_column(Integer)
    # The active loan while on_loan (a foreign key from 0124).
    current_loan_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "status IN ('available', 'on_loan', 'in_repair', 'retired')",
            name="lending_items_status",
        ),
        CheckConstraint(
            "(status = 'on_loan') = (current_loan_id IS NOT NULL)", name="lending_items_loan"
        ),
        Index(
            "lending_items_code_uniq",
            "code_key",
            unique=True,
            postgresql_where=text("code_key IS NOT NULL AND status <> 'retired'"),
        ),
        Index("lending_items_category_idx", "category_id", "name"),
    )


class LendingItemEvent(Base):
    """An item's history (docs/LENDING.md §5.2 history), never deleted while the item exists.
    kind: created | updated | status (from L1); borrowed | extended | returned | due_changed (L2);
    permission_denied | permission_confirmed (L3). `details` holds what changed and the states
    before and after, never a loan's purpose or return note (those stay on the loan's row)."""

    __tablename__ = "lending_item_events"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("lending_items.id", ondelete="CASCADE"))
    # The loan concerned (a foreign key from 0124).
    loan_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    kind: Mapped[str] = mapped_column(String(24))
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    details: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )

    __table_args__ = (Index("lending_item_events_item_idx", "item_id", text("id DESC")),)
