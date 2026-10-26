"""備品 (equipment lending, M167, docs/LENDING.md §4): the settings, the categories, the items,
each item's history (0123), the loans (0124, M168), the notices and the watches (0125, M169)."""

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy import text as sql_text  # (LendingNotice has a column named text)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow

ITEM_STATUSES = ("available", "on_loan", "in_repair", "retired")
LOAN_STATUSES = ("active", "returned")

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
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default=sql_text("false"))
    keeper_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), default=list, server_default=sql_text("'{}'::uuid[]")
    )
    # The longest loan when neither the item nor its category says (days from today, 1-365).
    default_max_days: Mapped[int] = mapped_column(
        Integer, default=DEFAULT_MAX_DAYS, server_default=sql_text(str(DEFAULT_MAX_DAYS))
    )
    # How often a borrower may extend a loan themself (0-10; keepers are not limited).
    max_extensions: Mapped[int] = mapped_column(
        Integer,
        default=DEFAULT_MAX_EXTENSIONS,
        server_default=sql_text(str(DEFAULT_MAX_EXTENSIONS)),
    )
    # Days past the due date before the keepers are told (1-30).
    keeper_overdue_days: Mapped[int] = mapped_column(
        Integer,
        default=DEFAULT_KEEPER_OVERDUE_DAYS,
        server_default=sql_text(str(DEFAULT_KEEPER_OVERDUE_DAYS)),
    )
    # The morning notices' time (minutes from midnight in `tz`).
    notice_minute: Mapped[int] = mapped_column(
        Integer, default=DEFAULT_NOTICE_MINUTE, server_default=sql_text(str(DEFAULT_NOTICE_MINUTE))
    )
    # The zone of the due dates and of the notices' time (docs/LENDING.md §8.1).
    tz: Mapped[str] = mapped_column(
        String(64), default=DEFAULT_TZ, server_default=sql_text(f"'{DEFAULT_TZ}'")
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
        Boolean, default=False, server_default=sql_text("false")
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
        String(16), default="available", server_default=sql_text("'available'")
    )
    # Why it is in repair or retired (keepers).
    status_note: Mapped[str | None] = mapped_column(String(200))
    # NULL = the category's default.
    requires_permission: Mapped[bool | None] = mapped_column(Boolean)
    # NULL = the category's, then the settings' default (1-365).
    max_days: Mapped[int | None] = mapped_column(Integer)
    # The active loan while on_loan (DEFERRABLE INITIALLY DEFERRED; use_alter: the loans point back
    # here).
    current_loan_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey(
            "lending_loans.id",
            use_alter=True,
            name="lending_items_current_loan_id_fkey",
            deferrable=True,
            initially="DEFERRED",
        )
    )
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
            postgresql_where=sql_text("code_key IS NOT NULL AND status <> 'retired'"),
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
    # The loan concerned (borrowed, extended, returned, due_changed …).
    loan_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("lending_loans.id", name="lending_item_events_loan_id_fkey")
    )
    kind: Mapped[str] = mapped_column(String(24))
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    details: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=sql_text("'{}'::jsonb")
    )

    __table_args__ = (Index("lending_item_events_item_idx", "item_id", sql_text("id DESC")),)


class LendingLoan(Base):
    """One loan (docs/LENDING.md §4.1, 0124): someone has an item from `borrowed_at` until the end
    of `due_on` (a date in lending_settings.tz). At most one active loan per item (the partial
    unique index `lending_loans_active_uniq`, behind the item row's lock); a retry with the same
    `client_request_id` is the same row. Loans are never deleted (the item's history).

    `permission_required` is what the item asked for when it was borrowed (later changes of the
    item do not touch it); then `approver_id` is the teacher the borrower named and
    `permission_state` starts as claimed (L3 adds the teacher's confirmed / denied)."""

    __tablename__ = "lending_loans"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("lending_items.id", ondelete="RESTRICT"))
    borrower_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    client_request_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    status: Mapped[str] = mapped_column(String(16))
    borrowed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    due_on: Mapped[date] = mapped_column(Date)
    original_due_on: Mapped[date] = mapped_column(Date)
    # The borrower's own extensions (a keeper's date changes are not counted).
    extension_count: Mapped[int] = mapped_column(Integer, default=0, server_default=sql_text("0"))
    purpose: Mapped[str] = mapped_column(String(200))
    permission_required: Mapped[bool] = mapped_column(Boolean)
    approver_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    # NULL (not required) | claimed | confirmed | denied
    permission_state: Mapped[str | None] = mapped_column(String(16))
    permission_decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    permission_note: Mapped[str | None] = mapped_column(String(200))
    returned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    returned_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    return_condition: Mapped[str | None] = mapped_column(String(8))  # ok | issue
    return_note: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("status IN ('active', 'returned')", name="lending_loans_status"),
        CheckConstraint(
            "(status = 'returned') = (returned_at IS NOT NULL)", name="lending_loans_returned"
        ),
        CheckConstraint(
            "permission_required = (permission_state IS NOT NULL)",
            name="lending_loans_permission",
        ),
        CheckConstraint(
            "(permission_state IS NULL) = (approver_id IS NULL)", name="lending_loans_approver"
        ),
        CheckConstraint(
            "return_condition IS NULL OR return_condition IN ('ok', 'issue')",
            name="lending_loans_condition",
        ),
        Index(
            "lending_loans_active_uniq",
            "item_id",
            unique=True,
            postgresql_where=sql_text("status = 'active'"),
        ),
        Index("lending_loans_request_uniq", "borrower_id", "client_request_id", unique=True),
        Index("lending_loans_borrower_idx", "borrower_id", "status", "due_on"),
        Index("lending_loans_due_idx", "due_on", postgresql_where=sql_text("status = 'active'")),
        Index("lending_loans_item_idx", "item_id", sql_text("borrowed_at DESC")),
    )


NOTICE_ROLES = ("borrower", "approver", "keeper", "watcher")


class LendingNotice(Base):
    """An activity item of kind lending (docs/LENDING.md §8, 0125): a notice to one person, once
    per `key` (§8.2's table), written with a `lending.notice` event (the push) in the change's
    own transaction. `role` is why the person gets it: borrower (their own loan), approver (the
    teacher's to-do `permission:<loan>`, done once they decide or 14 days after the return),
    keeper (the 備品係, or the administrators when there is none) or watcher (「返却を知らせる」).
    `text` is written in the reader's language (M115). Only the teacher's to-do has a done state."""

    __tablename__ = "lending_notices"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("lending_items.id", ondelete="CASCADE")
    )
    loan_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("lending_loans.id", ondelete="CASCADE")
    )
    key: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(12))
    text: Mapped[str] = mapped_column(Text)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    done_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))

    __table_args__ = (
        UniqueConstraint("user_id", "key", name="lending_notices_user_key_uniq"),
        CheckConstraint(
            "role IN ('borrower', 'approver', 'keeper', 'watcher')", name="lending_notices_role"
        ),
        Index("lending_notices_user_idx", "user_id", sql_text("at DESC")),
    )


class LendingWatch(Base):
    """「返却されたら知らせる」 (§6.7): told once when the item comes back (returned, or out of
    repair), then removed; my own watch goes when I borrow the item."""

    __tablename__ = "lending_watches"

    item_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("lending_items.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
