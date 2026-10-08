"""操作ボタン (M143) API shapes (docs/ACTIONS.md §4, §7, §8)."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.actions.models import Action, ActionInvocation
from app.modules.attendance.schemas import ICON_KEYS

# Roles that can be given the right to press (guests and bots never can).
PressRole = Literal["admin", "manager", "member"]
InvokeStatus = Literal["pending", "succeeded", "failed"]
InvocationKind = Literal["invoke", "test"]

NAME_MAX = 40
SECRET_NAME_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,63}$"
ACTION_KEY_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$"
MAX_ALLOWED = 200


def _clean_name(value: str, what: str = "name") -> str:
    cleaned = " ".join(value.split())
    if not cleaned:
        raise ValueError(f"The {what} must not be empty")
    if len(cleaned) > NAME_MAX:
        raise ValueError(f"The {what} is at most {NAME_MAX} characters")
    return cleaned


def _clean_optional(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = " ".join(value.split())
    return cleaned or None


def _clean_icon(value: str | None) -> str | None:
    if value is None:
        return None
    if value not in ICON_KEYS:
        raise ValueError("Unknown icon (apps/shared/attendance-icons.json)")
    return value


# --- what a person sees ----------------------------------------------------------------------


class ActionOut(BaseModel):
    """A button I may press (no URL, key or rights)."""

    id: UUID
    name: str
    # Buttons with the same group_label are drawn together under it (null: no group).
    group_label: str | None
    # A key of apps/shared/attendance-icons.json (null: the emoji, if any).
    icon: str | None
    emoji: str | None
    # Ask before sending; confirm_text null = the client's own sentence.
    confirm: bool
    confirm_text: str | None
    # This button's relay is asked for the state of its group (docs/ACTIONS.md §12).
    provides_status: bool = False
    position: int


class ActionListOut(BaseModel):
    enabled: bool
    # Also on the 在室状況 page and its pill's menu (docs/ACTIONS.md D17).
    show_on_attendance: bool = False
    # Only the ones I may press, in the administrator's order.
    actions: list[ActionOut] = []


def to_action_out(row: Action) -> ActionOut:
    return ActionOut(
        id=row.id,
        name=row.name,
        group_label=row.group_label,
        icon=row.icon,
        emoji=row.emoji,
        confirm=row.confirm,
        confirm_text=row.confirm_text,
        provides_status=row.provides_status,
        position=row.position,
    )


class ActionInvoke(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # A new id per press; the same id only when the same request is sent again (a retry after a
    # network error): the earlier result comes back and the relay is not called again.
    client_invoke_id: UUID


class ActionInvokeOut(BaseModel):
    invoke_id: UUID
    action_id: UUID
    ok: bool
    status: InvokeStatus
    # The relay's HTTP status (null when nothing came back).
    status_code: int | None
    # Why it failed: timeout | network | relay_error | url_not_allowed | secret_missing |
    # interrupted | action_changed (not sent: the button, the switch or the right changed after
    # the press was allowed, docs/ACTIONS.md §4.1) (null when it succeeded or is still pending).
    error: str | None
    # The relay's own `message` (plain text, at most 200 characters), on success or failure.
    message: str | None
    at: datetime
    # True when this answers a repeat of an earlier client_invoke_id (the relay was not called).
    repeated: bool = False


def to_invoke_out(row: ActionInvocation, *, repeated: bool = False) -> ActionInvokeOut:
    return ActionInvokeOut(
        invoke_id=row.id,
        action_id=row.action_id,
        ok=row.status == "succeeded",
        status=row.status,  # type: ignore[arg-type]
        status_code=row.status_code,
        error=row.error,
        message=row.message,
        at=row.created_at,
        repeated=repeated,
    )


# --- administration ------------------------------------------------------------------------


class ActionSettingsOut(BaseModel):
    enabled: bool
    show_on_attendance: bool
    log_retention_days: int


class ActionSettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool | None = None
    show_on_attendance: bool | None = None
    log_retention_days: int | None = Field(default=None, ge=0, le=3650)


class ActionAdminOut(ActionOut):
    action_key: str
    url: str
    secret_name: str
    # Whether the signing key's file exists and is long enough (the key itself is never shown).
    secret_present: bool
    allowed_roles: list[PressRole]
    allowed_group_ids: list[UUID]
    allowed_user_ids: list[UUID]
    notice_channel_id: UUID | None
    enabled: bool
    created_at: datetime
    updated_at: datetime
    last_invoked_at: datetime | None = None


class _ActionFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @field_validator("icon", check_fields=False)
    @classmethod
    def icon_known(cls, value: str | None) -> str | None:
        return _clean_icon(value)

    @field_validator("group_label", "emoji", "confirm_text", check_fields=False)
    @classmethod
    def optional_text(cls, value: str | None) -> str | None:
        return _clean_optional(value)

    @field_validator("allowed_roles", check_fields=False)
    @classmethod
    def unique_roles(cls, value: list[PressRole] | None) -> list[PressRole] | None:
        return list(dict.fromkeys(value)) if value is not None else None

    @field_validator("allowed_group_ids", "allowed_user_ids", check_fields=False)
    @classmethod
    def unique_ids(cls, value: list[UUID] | None) -> list[UUID] | None:
        return list(dict.fromkeys(value)) if value is not None else None


class ActionCreate(_ActionFields):
    name: str = Field(max_length=200)
    group_label: str | None = Field(default=None, max_length=200)
    icon: str | None = Field(default=None, max_length=32)
    emoji: str | None = Field(default=None, max_length=32)
    action_key: str = Field(pattern=ACTION_KEY_PATTERN)
    url: str = Field(min_length=1, max_length=2000)
    secret_name: str = Field(pattern=SECRET_NAME_PATTERN)
    confirm: bool = True
    confirm_text: str | None = Field(default=None, max_length=200)
    allowed_roles: list[PressRole] = Field(default_factory=list, max_length=3)
    allowed_group_ids: list[UUID] = Field(default_factory=list, max_length=MAX_ALLOWED)
    allowed_user_ids: list[UUID] = Field(default_factory=list, max_length=MAX_ALLOWED)
    notice_channel_id: UUID | None = None
    enabled: bool = True
    # Ask this button's relay for the state of its group (at most one per group).
    provides_status: bool = False

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return _clean_name(value)

    @field_validator("group_label")
    @classmethod
    def clean_group(cls, value: str | None) -> str | None:
        cleaned = _clean_optional(value)
        return _clean_name(cleaned, "group label") if cleaned is not None else None


class ActionUpdate(_ActionFields):
    """Only what is sent changes; group_label, icon, emoji, confirm_text and notice_channel_id
    can be cleared with null."""

    name: str | None = Field(default=None, max_length=200)
    group_label: str | None = Field(default=None, max_length=200)
    icon: str | None = Field(default=None, max_length=32)
    emoji: str | None = Field(default=None, max_length=32)
    action_key: str | None = Field(default=None, pattern=ACTION_KEY_PATTERN)
    url: str | None = Field(default=None, min_length=1, max_length=2000)
    secret_name: str | None = Field(default=None, pattern=SECRET_NAME_PATTERN)
    confirm: bool | None = None
    confirm_text: str | None = Field(default=None, max_length=200)
    allowed_roles: list[PressRole] | None = Field(default=None, max_length=3)
    allowed_group_ids: list[UUID] | None = Field(default=None, max_length=MAX_ALLOWED)
    allowed_user_ids: list[UUID] | None = Field(default=None, max_length=MAX_ALLOWED)
    notice_channel_id: UUID | None = None
    enabled: bool | None = None
    provides_status: bool | None = None

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        return _clean_name(value) if value is not None else None

    @field_validator("group_label")
    @classmethod
    def clean_group(cls, value: str | None) -> str | None:
        cleaned = _clean_optional(value)
        return _clean_name(cleaned, "group label") if cleaned is not None else None


class ActionOrder(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ids: list[UUID] = Field(max_length=200)


class ActionInvocationOut(BaseModel):
    id: UUID
    action_id: UUID
    user_id: UUID
    kind: InvocationKind
    status: InvokeStatus
    status_code: int | None
    error: str | None
    message: str | None
    latency_ms: int | None
    created_at: datetime
    finished_at: datetime | None


def to_invocation_out(row: ActionInvocation) -> ActionInvocationOut:
    return ActionInvocationOut(
        id=row.id,
        action_id=row.action_id,
        user_id=row.user_id,
        kind=row.kind,  # type: ignore[arg-type]
        status=row.status,  # type: ignore[arg-type]
        status_code=row.status_code,
        error=row.error,
        message=row.message,
        latency_ms=row.latency_ms,
        created_at=row.created_at,
        finished_at=row.finished_at,
    )


class ActionsUpdatedData(BaseModel):
    """`actions.updated` (audience all but guests): the settings or a button changed. What I may
    press differs per person, so nothing is carried: GET /actions again."""


# --- the state of what the buttons operate (docs/ACTIONS.md §12) -------------------------------

StatusTone = Literal["ok", "warn", "alert", "neutral"]
STATUS_TEXT_MAX = 80
STATUS_STATE_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,31}$"
STATUS_DETAILS_MAX = 6
STATUS_DETAIL_LABEL_MAX = 40
STATUS_DETAIL_VALUE_MAX = 80


class ActionStatusDetail(BaseModel):
    label: str
    value: str


class ActionStatusValue(BaseModel):
    """The relay's answer, cleaned: plain text only."""

    # 「施錠中・ドア閉・電池 85%」 (at most 80 characters).
    text: str
    # How to colour it: ok (as it should be), warn, alert, neutral (unknown / nothing to say).
    tone: StatusTone
    # A short machine word for the state (`locked`, `unlocked`, `jammed`, `unknown`…), or null.
    state: str | None = None
    # At most 6 label / value pairs (「電池」「85%」).
    details: list[ActionStatusDetail] = []


class ActionStatusOut(BaseModel):
    """The state of one group, as its status button's relay last told it."""

    # The button that provides the state (it may be one I cannot press myself).
    action_id: UUID
    # The group it is the state of (null: the button has no group and is its own).
    group_label: str | None
    ok: bool
    # Null when the relay could not be asked or gave no usable answer.
    status: ActionStatusValue | None
    # Why it failed: timeout | network | relay_error | invalid_answer | url_not_allowed |
    # secret_missing (null when ok).
    error: str | None
    # The relay's own `message` on a failure (plain text, at most 200 characters).
    message: str | None
    # When the relay answered (or failed); the answer may come from the server's short cache.
    fetched_at: datetime


class ActionStatusListOut(BaseModel):
    enabled: bool
    # One per group I may press something in whose state is provided, in the buttons' order.
    statuses: list[ActionStatusOut] = []


class ActionStatusUpdatedData(ActionStatusOut):
    """`actions.status_updated` (audience: who may press something in the group): a group's
    state, fetched again a few seconds after a press or found changed."""
