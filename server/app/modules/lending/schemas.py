"""備品 (equipment lending) API shapes (docs/LENDING.md §5.1-§5.3, §9)."""

import unicodedata
from datetime import date, datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.attachments.schemas import AttachmentOut
from app.modules.messages.schemas import strip_control_chars
from app.modules.users.dnd import valid_zone

MAX_KEEPERS = 20
MAX_CATEGORIES = 50
MAX_ITEMS = 2000
MAX_DAYS_LIMIT = 365
MAX_EXTENSIONS_LIMIT = 10
MAX_KEEPER_OVERDUE_DAYS = 30
CATEGORY_NAME_MAX = 40
ITEM_NAME_MAX = 80
CODE_MAX = 40
LOCATION_MAX = 80
NOTES_MAX = 2000
STATUS_NOTE_MAX = 200
HISTORY_LIMIT_MAX = 100
PURPOSE_MAX = 200
RETURN_NOTE_MAX = 500
# A keeper may set a due date up to this many days from today (§5.3).
KEEPER_MAX_DAYS = 365
# The teacher's decision and the scope=approved list stay open this long after the return (§5.3).
APPROVER_DAYS_AFTER_RETURN = 14
# scope=mine: the returned loans after the active ones.
MINE_RETURNED_LIMIT = 50

ItemStatus = Literal["available", "on_loan", "in_repair", "retired"]
# What a keeper may set by hand (on_loan comes from borrowing, L2).
SettableStatus = Literal["available", "in_repair", "retired"]
Source = Literal["item", "category", "default"]
PermissionState = Literal["claimed", "confirmed", "denied"]
LoanStatus = Literal["active", "returned"]
ReturnCondition = Literal["ok", "issue"]
LoanScope = Literal["mine", "active", "overdue", "approved"]


def clean_line(value: str) -> str:
    """NFC, no control characters, spaces trimmed (names, control numbers, places)."""
    return unicodedata.normalize("NFC", strip_control_chars(value)).strip()


def name_key(value: str) -> str:
    """The key two names or control numbers are the same by: NFC + casefold, trimmed."""
    return unicodedata.normalize("NFC", clean_line(value).casefold())


def _required(value: str, limit: int) -> str:
    cleaned = clean_line(value)
    if not cleaned:
        raise ValueError("Must not be blank")
    if len(cleaned) > limit:
        raise ValueError(f"At most {limit} characters")
    return cleaned


def _optional(value: str | None, limit: int) -> str | None:
    if value is None:
        return None
    cleaned = clean_line(value)
    if len(cleaned) > limit:
        raise ValueError(f"At most {limit} characters")
    return cleaned or None


def _notes(value: str | None, limit: int = NOTES_MAX) -> str | None:
    """Several lines: NFC, trimmed; blank = none."""
    if value is None:
        return None
    cleaned = unicodedata.normalize("NFC", value.replace("\r\n", "\n")).strip()
    cleaned = "".join(ch for ch in cleaned if ch in "\n\t" or unicodedata.category(ch) != "Cc")
    if len(cleaned) > limit:
        raise ValueError(f"At most {limit} characters")
    return cleaned or None


# --- settings (§5.1) ---------------------------------------------------------------------------


class LendingSettingsOut(BaseModel):
    """The workspace's 備品 settings (readable by every person, also while off)."""

    enabled: bool
    keeper_ids: list[UUID] = Field(
        description="The 備品係 the administrators chose (as saved; only the active people among "
        "them act as keepers)"
    )
    default_max_days: int = Field(
        description="The longest loan when the item and its category do not say (days from today)"
    )
    max_extensions: int = Field(description="How often a borrower may extend a loan themself")
    keeper_overdue_days: int = Field(
        description="Days past the due date before the keepers are told"
    )
    notice_minute: int = Field(
        description="The morning notices' time (minutes from midnight in `tz`)"
    )
    tz: str = Field(description="The zone of the due dates and the notices' time")
    is_keeper: bool = Field(description="Whether I am a keeper (or have lending.manage)")
    updated_at: datetime | None = None


class LendingSettingsUpdate(BaseModel):
    """Any of the settings (null or absent: unchanged)."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool | None = None
    keeper_ids: list[UUID] | None = Field(default=None, max_length=MAX_KEEPERS)
    default_max_days: int | None = Field(default=None, ge=1, le=MAX_DAYS_LIMIT)
    max_extensions: int | None = Field(default=None, ge=0, le=MAX_EXTENSIONS_LIMIT)
    keeper_overdue_days: int | None = Field(default=None, ge=1, le=MAX_KEEPER_OVERDUE_DAYS)
    notice_minute: int | None = Field(default=None, ge=0, le=24 * 60 - 1)
    tz: str | None = Field(default=None, max_length=64)

    @field_validator("keeper_ids")
    @classmethod
    def _unique(cls, value: list[UUID] | None) -> list[UUID] | None:
        return None if value is None else list(dict.fromkeys(value))

    @field_validator("tz")
    @classmethod
    def _zone(cls, value: str | None) -> str | None:
        if value is not None and not valid_zone(value):
            raise ValueError("Unknown time zone")
        return value


class LendingSummaryOut(BaseModel):
    """The bootstrap's `lending` (null for guests and bots and while the feature is off): the
    numbers of the 「備品」 tile and navigation item (§12.1)."""

    enabled: bool
    is_keeper: bool
    my_active_count: int = Field(description="My loans not returned yet")
    my_overdue_count: int = Field(description="Those of them past their due date")
    keeper_attention_count: int = Field(
        description="For keepers: loans at least keeper_overdue_days past due, and loans of "
        "deactivated people (0 for others)"
    )
    settings_updated_at: datetime | None


# --- categories (§5.2) ------------------------------------------------------------------------


class LendingCategoryOut(BaseModel):
    id: UUID
    name: str
    position: int
    requires_permission: bool = Field(description="The default of the category's items")
    max_days: int | None = Field(description="null: the settings' default_max_days")
    item_count: int = Field(
        description="Items in the category, the retired ones included (they keep it from being "
        "deleted)"
    )


class LendingCategoryCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=CATEGORY_NAME_MAX, examples=["カメラ"])
    requires_permission: bool = False
    max_days: int | None = Field(default=None, ge=1, le=MAX_DAYS_LIMIT)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        return _required(value, CATEGORY_NAME_MAX)


class LendingCategoryUpdate(BaseModel):
    """Any of the fields. `max_days: null` falls back to the settings' default; `name` and
    `requires_permission` null are unchanged. `position`: the place in the order, from 0 (the
    others move along)."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=CATEGORY_NAME_MAX)
    requires_permission: bool | None = None
    max_days: int | None = Field(default=None, ge=1, le=MAX_DAYS_LIMIT)
    position: int | None = Field(default=None, ge=0)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str | None:
        return None if value is None else _required(value, CATEGORY_NAME_MAX)


# --- items (§5.2) -----------------------------------------------------------------------------


class LendingLoanBriefOut(BaseModel):
    """Who has (had) an item and until when: the item's `loan` and `recent_loans`. No purpose or
    notes; `permission_state` only for those who see a loan's details (else null)."""

    id: UUID
    borrower_id: UUID
    borrowed_at: datetime
    due_on: date
    overdue_days: int = Field(description="Days past due_on in the workspace's zone (0 if not)")
    permission_state: PermissionState | None
    status: LoanStatus
    returned_at: datetime | None
    return_condition: ReturnCondition | None = Field(
        description="How it came back (the 🔧 mark for issue is shown to everyone)"
    )


class LendingItemOut(BaseModel):
    id: UUID
    name: str
    category_id: UUID | None
    code: str | None
    location: str | None
    notes: str | None
    photo: AttachmentOut | None
    status: ItemStatus
    status_note: str | None
    requires_permission: bool = Field(description="In effect (item → category → false)")
    requires_permission_source: Source
    max_days: int = Field(description="In effect (item → category → settings)")
    max_days_source: Source
    loan: LendingLoanBriefOut | None = Field(description="The active loan (null unless on_loan)")
    watching: bool = Field(description="Whether I asked to be told when it is returned (L3)")
    created_at: datetime
    updated_at: datetime


class LendingItemDetailOut(LendingItemOut):
    recent_loans: list[LendingLoanBriefOut] = Field(
        default_factory=list, description="The last 5 loans (the active one too), newest first"
    )


class LendingItemCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=ITEM_NAME_MAX, examples=["カメラ A"])
    category_id: UUID | None = None
    code: str | None = Field(default=None, max_length=CODE_MAX, examples=["CAM-02"])
    location: str | None = Field(default=None, max_length=LOCATION_MAX, examples=["301 棚 2"])
    notes: str | None = Field(default=None, max_length=NOTES_MAX * 2)
    requires_permission: bool | None = Field(
        default=None, description="null: the category's default"
    )
    max_days: int | None = Field(
        default=None,
        ge=1,
        le=MAX_DAYS_LIMIT,
        description="null: the category's, then the settings' default",
    )
    photo_attachment_id: UUID | None = Field(
        default=None, description="My own pending upload (POST /attachments) of an image"
    )

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        return _required(value, ITEM_NAME_MAX)

    @field_validator("code")
    @classmethod
    def _code(cls, value: str | None) -> str | None:
        return _optional(value, CODE_MAX)

    @field_validator("location")
    @classmethod
    def _location(cls, value: str | None) -> str | None:
        return _optional(value, LOCATION_MAX)

    @field_validator("notes")
    @classmethod
    def _clean_notes(cls, value: str | None) -> str | None:
        return _notes(value)


class LendingItemUpdate(BaseModel):
    """Any of the fields; null clears one (`name` null: unchanged). The status changes through
    POST /lending/items/{id}/status."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=ITEM_NAME_MAX)
    category_id: UUID | None = None
    code: str | None = Field(default=None, max_length=CODE_MAX)
    location: str | None = Field(default=None, max_length=LOCATION_MAX)
    notes: str | None = Field(default=None, max_length=NOTES_MAX * 2)
    requires_permission: bool | None = None
    max_days: int | None = Field(default=None, ge=1, le=MAX_DAYS_LIMIT)
    photo_attachment_id: UUID | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str | None:
        return None if value is None else _required(value, ITEM_NAME_MAX)

    @field_validator("code")
    @classmethod
    def _code(cls, value: str | None) -> str | None:
        return _optional(value, CODE_MAX)

    @field_validator("location")
    @classmethod
    def _location(cls, value: str | None) -> str | None:
        return _optional(value, LOCATION_MAX)

    @field_validator("notes")
    @classmethod
    def _clean_notes(cls, value: str | None) -> str | None:
        return _notes(value)


class LendingItemStatusIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: SettableStatus
    note: str | None = Field(
        default=None,
        max_length=STATUS_NOTE_MAX,
        description="Why (in repair, retired); cleared when the item becomes available",
    )

    @field_validator("note")
    @classmethod
    def _note(cls, value: str | None) -> str | None:
        return _optional(value, STATUS_NOTE_MAX)


class LendingItemEventOut(BaseModel):
    id: UUID
    kind: str = Field(
        description="created | updated | status (L1); borrowed | extended | returned | "
        "due_changed (L2); permission_denied | permission_confirmed (L3). Unknown kinds may come"
    )
    loan_id: UUID | None
    actor_id: UUID | None
    at: datetime
    details: dict[str, Any]


class LendingItemHistoryOut(BaseModel):
    events: list[LendingItemEventOut] = Field(description="Newest first")
    next_before: UUID | None = Field(description="Pass as `before` for older ones (null: no more)")


# --- loans (§5.3) -----------------------------------------------------------------------------


class LendingBorrowIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_request_id: UUID = Field(
        description="Made by the client once per borrow; a retry sends the same one (§7.2)"
    )
    due_on: date = Field(
        description="The return date in the workspace's zone (today … today + the item's max_days)"
    )
    purpose: str = Field(min_length=1, max_length=PURPOSE_MAX, examples=["学会発表の撮影"])
    permission_confirmed: bool = Field(
        default=False, description="「教員の許可を得た」 (needed when the item requires permission)"
    )
    approver_id: UUID | None = Field(
        default=None, description="The teacher who gave it (one of GET /lending/approvers)"
    )

    @field_validator("purpose")
    @classmethod
    def _purpose(cls, value: str) -> str:
        return _required(value, PURPOSE_MAX)


class LendingReturnIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    condition: ReturnCondition
    note: str | None = Field(
        default=None, max_length=RETURN_NOTE_MAX * 2, description="Required with `issue`"
    )

    @field_validator("note")
    @classmethod
    def _note(cls, value: str | None) -> str | None:
        return _notes(value, RETURN_NOTE_MAX)

    @model_validator(mode="after")
    def _issue_needs_note(self) -> "LendingReturnIn":
        if self.condition == "issue" and not self.note:
            raise ValueError("Describe the issue in `note`")
        return self


class LendingExtendIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    due_on: date = Field(description="The new return date in the workspace's zone")


class LendingLoanOut(BaseModel):
    """A loan. The fields marked "hidden" are null for anyone but the borrower, the teacher named
    (approver_id), the keepers and the administrators (`details_hidden: true`, §3.2)."""

    id: UUID
    item_id: UUID
    item_name: str
    item_code: str | None
    borrower_id: UUID
    status: LoanStatus
    borrowed_at: datetime
    due_on: date
    original_due_on: date
    overdue_days: int = Field(description="Days past due_on in the workspace's zone (0 if not)")
    extension_count: int = Field(description="The borrower's own extensions so far")
    can_extend: bool = Field(
        description="Whether I may extend it now (the borrower within the limits, or a keeper)"
    )
    latest_due_on: date = Field(
        description="The latest date the borrower may extend to (today + the item's max_days)"
    )
    purpose: str | None = Field(description="Hidden")
    permission_required: bool
    approver_id: UUID | None = Field(description="Hidden")
    permission_state: PermissionState | None = Field(description="Hidden")
    permission_decided_at: datetime | None = Field(description="Hidden")
    permission_note: str | None = Field(description="Hidden")
    returned_at: datetime | None
    returned_by: UUID | None
    return_condition: ReturnCondition | None
    return_note: str | None = Field(description="Hidden")
    details_hidden: bool


class LendingApproversOut(BaseModel):
    """Who may be named as the teacher who gave permission (§6.4)."""

    user_ids: list[UUID] = Field(
        description="The active members of @faculty (everyone active when the roster's group "
        "is missing or empty), never me"
    )
    suggested_ids: list[UUID] = Field(description="My supervisor (lab roster) when a candidate")
    self_approved: bool = Field(
        description="I am on @faculty: borrowing needs no permission for me"
    )


# --- events (§9) ------------------------------------------------------------------------------


class LendingUpdatedData(BaseModel):
    """`lending.updated` (all): the ledger changed. Carries no content (what a person may see
    differs): re-read GET /lending/items (GET /lending/categories when `categories`, GET
    /lending/settings and the bootstrap's `lending` when `settings`)."""

    item_ids: list[UUID] = Field(default_factory=list)
    categories: bool = False
    settings: bool = False
