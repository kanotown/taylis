"""在室状況 (M140) API shapes (docs/PRESENCE.md §3, §4, §6)."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.attendance.models import (
    AttendanceCurrent,
    AttendanceDelivery,
    AttendanceIntegration,
    AttendanceLog,
    AttendanceState,
)

Kind = Literal["in_room", "on_site", "off_site", "gone"]
KINDS: tuple[Kind, ...] = ("in_room", "on_site", "off_site", "gone")
# The text emoji palette (apps/shared/text-emoji.json): the clients already draw these.
Color = Literal["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"]
Source = Literal["app", "admin", "integration", "auto"]
PersonalRule = Literal["nobody", "everyone", "admins", "groups"]

LABEL_MAX = 40
NOTE_MAX = 100


def _clean_label(value: str) -> str:
    cleaned = " ".join(value.split())
    if not cleaned:
        raise ValueError("The name must not be empty")
    if len(cleaned) > LABEL_MAX:
        raise ValueError(f"The name is at most {LABEL_MAX} characters")
    return cleaned


def _clean_emoji(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


# --- states ---------------------------------------------------------------------------------


class AttendanceStateOut(BaseModel):
    id: UUID
    # null = the workspace's state; else the person whose own state it is.
    owner_id: UUID | None
    label: str
    emoji: str | None
    color: Color
    kind: Kind
    position: int
    archived: bool


def to_state_out(row: AttendanceState) -> AttendanceStateOut:
    return AttendanceStateOut(
        id=row.id,
        owner_id=row.owner_id,
        label=row.label,
        emoji=row.emoji,
        color=row.color,  # type: ignore[arg-type]
        kind=row.kind,  # type: ignore[arg-type]
        position=row.position,
        archived=row.archived_at is not None,
    )


class AttendanceStateCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str = Field(max_length=200)
    emoji: str | None = Field(default=None, max_length=32)
    color: Color = "gray"
    kind: Kind

    @field_validator("label")
    @classmethod
    def label_clean(cls, value: str) -> str:
        return _clean_label(value)

    @field_validator("emoji")
    @classmethod
    def emoji_clean(cls, value: str | None) -> str | None:
        return _clean_emoji(value)


class AttendanceStateUpdate(BaseModel):
    """Only what is sent changes; `emoji: null` removes the emoji."""

    model_config = ConfigDict(extra="forbid")

    label: str | None = Field(default=None, max_length=200)
    emoji: str | None = Field(default=None, max_length=32)
    color: Color | None = None
    kind: Kind | None = None

    @field_validator("label")
    @classmethod
    def label_clean(cls, value: str | None) -> str | None:
        return None if value is None else _clean_label(value)

    @field_validator("emoji")
    @classmethod
    def emoji_clean(cls, value: str | None) -> str | None:
        return _clean_emoji(value)


class AttendanceStateOrder(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ids: list[UUID] = Field(max_length=100)


# --- the board -------------------------------------------------------------------------------


class AttendanceEntryOut(BaseModel):
    user_id: UUID
    state_id: UUID
    since: datetime
    note: str | None
    source: Source


def to_entry_out(row: AttendanceCurrent) -> AttendanceEntryOut:
    return AttendanceEntryOut(
        user_id=row.user_id,
        state_id=row.state_id,
        since=row.since,
        note=row.note,
        source=row.source,  # type: ignore[arg-type]
    )


class AttendanceBoardOut(BaseModel):
    """GET /attendance and the bootstrap's `attendance` (null for guests and while off)."""

    enabled: bool
    states: list[AttendanceStateOut] = []
    entries: list[AttendanceEntryOut] = []
    # Whether I may add personal states (POST /attendance/my-states).
    can_personalize: bool = False


class AttendanceSet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    state_id: UUID
    note: str | None = Field(default=None, max_length=NOTE_MAX)

    @field_validator("note")
    @classmethod
    def note_clean(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = " ".join(value.split())
        return cleaned or None


class AttendanceLogOut(BaseModel):
    id: int
    user_id: UUID
    from_state_id: UUID | None
    to_state_id: UUID
    note: str | None
    at: datetime
    source: Source
    actor_id: UUID | None
    integration_id: UUID | None


def to_log_out(row: AttendanceLog) -> AttendanceLogOut:
    return AttendanceLogOut(
        id=row.id,
        user_id=row.user_id,
        from_state_id=row.from_state_id,
        to_state_id=row.to_state_id,
        note=row.note,
        at=row.at,
        source=row.source,  # type: ignore[arg-type]
        actor_id=row.actor_id,
        integration_id=row.integration_id,
    )


class AttendanceLogPage(BaseModel):
    items: list[AttendanceLogOut]
    # Pass as before_id for the next (older) page; null = no more.
    next_before_id: int | None


# --- admin settings --------------------------------------------------------------------------


class AttendanceAdminSettingsOut(BaseModel):
    enabled: bool
    personal_rule: PersonalRule
    personal_group_ids: list[UUID]
    log_retention_days: int
    # The workspace's states (not archived), in order.
    states: list[AttendanceStateOut]


class AttendanceSettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool | None = None
    personal_rule: PersonalRule | None = None
    personal_group_ids: list[UUID] | None = Field(default=None, max_length=50)
    # 0 = keep for good; at most ten years.
    log_retention_days: int | None = Field(default=None, ge=0, le=3650)


# --- integrations ----------------------------------------------------------------------------

SECRET_NAME_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,63}$"


class AttendanceIntegrationOut(BaseModel):
    id: UUID
    name: str
    url: str | None
    secret_name: str | None
    enabled: bool
    # Whether an inbound token exists (the token itself is shown once only).
    inbound: bool
    created_at: datetime
    last_inbound_at: datetime | None


def to_integration_out(row: AttendanceIntegration) -> AttendanceIntegrationOut:
    return AttendanceIntegrationOut(
        id=row.id,
        name=row.name,
        url=row.url,
        secret_name=row.secret_name,
        enabled=row.enabled,
        inbound=row.token_hash is not None,
        created_at=row.created_at,
        last_inbound_at=row.last_inbound_at,
    )


class AttendanceIntegrationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)
    url: str | None = Field(default=None, max_length=2000)
    secret_name: str | None = Field(default=None, pattern=SECRET_NAME_PATTERN)
    # Make an inbound token now (shown once in the answer).
    inbound: bool = False

    @field_validator("name")
    @classmethod
    def name_clean(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if not cleaned:
            raise ValueError("The name must not be empty")
        return cleaned

    @field_validator("url")
    @classmethod
    def url_clean(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None

    @model_validator(mode="after")
    def url_needs_secret(self) -> "AttendanceIntegrationCreate":
        if self.url is not None and self.secret_name is None:
            raise ValueError("A webhook URL needs the name of its signing key file")
        return self


class AttendanceIntegrationUpdate(BaseModel):
    """Only what is sent changes; url null stops sending (secret_name is then kept)."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=80)
    url: str | None = Field(default=None, max_length=2000)
    secret_name: str | None = Field(default=None, pattern=SECRET_NAME_PATTERN)
    enabled: bool | None = None

    @field_validator("name")
    @classmethod
    def name_clean(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = " ".join(value.split())
        if not cleaned:
            raise ValueError("The name must not be empty")
        return cleaned

    @field_validator("url")
    @classmethod
    def url_clean(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None


class AttendanceIntegrationCreated(BaseModel):
    integration: AttendanceIntegrationOut
    # The inbound token: shown this once (null when none was asked for).
    token: str | None = None


class AttendanceTokenOut(BaseModel):
    integration: AttendanceIntegrationOut
    token: str


DeliveryStatus = Literal["pending", "delivered", "failed", "superseded"]


class AttendanceDeliveryOut(BaseModel):
    id: UUID
    event: str
    user_id: UUID | None
    status: DeliveryStatus
    attempts: int
    last_status_code: int | None
    last_error: str | None
    created_at: datetime
    delivered_at: datetime | None
    next_attempt_at: datetime | None
    # From the body: the state's label it moved to (for the log's line).
    to_label: str | None


def to_delivery_out(row: AttendanceDelivery) -> AttendanceDeliveryOut:
    to = row.body.get("to") if isinstance(row.body, dict) else None
    return AttendanceDeliveryOut(
        id=row.id,
        event=row.event,
        user_id=row.user_id,
        status=row.status,  # type: ignore[arg-type]
        attempts=row.attempts,
        last_status_code=row.last_status_code,
        last_error=row.last_error,
        created_at=row.created_at,
        delivered_at=row.delivered_at,
        next_attempt_at=row.next_attempt_at if row.status == "pending" else None,
        to_label=to.get("label") if isinstance(to, dict) else None,
    )


# --- inbound ---------------------------------------------------------------------------------


class AttendanceInbound(BaseModel):
    """POST /integrations/attendance (docs/PRESENCE.md §6): one of user_id / email / username."""

    model_config = ConfigDict(extra="forbid")

    user_id: UUID | None = None
    email: str | None = Field(default=None, max_length=320)
    username: str | None = Field(default=None, max_length=80)
    state: str = Field(min_length=1, max_length=200)
    at: AwareDatetime | None = None
    note: str | None = Field(default=None, max_length=NOTE_MAX)

    @model_validator(mode="after")
    def one_person(self) -> "AttendanceInbound":
        given = [v for v in (self.user_id, self.email, self.username) if v is not None]
        if len(given) != 1:
            raise ValueError("Give exactly one of user_id, email or username")
        return self

    @field_validator("note")
    @classmethod
    def note_clean(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = " ".join(value.split())
        return cleaned or None


class AttendanceInboundOut(BaseModel):
    applied: bool
    # Why nothing changed: unchanged | stale.
    reason: Literal["unchanged", "stale"] | None = None
    user_id: UUID
    state_id: UUID
    since: datetime


class AttendanceTestOut(BaseModel):
    delivery: AttendanceDeliveryOut


# --- events ----------------------------------------------------------------------------------


class AttendanceUpdatedData(BaseModel):
    user_id: UUID
    state_id: UUID
    since: datetime
    note: str | None
    source: Source
    # The log row (the webhook planner reads the change from it); clients ignore it.
    log_id: int | None = None


class AttendanceConfigUpdatedData(BaseModel):
    """No content: what changed differs per person (can_personalize). Re-read GET /attendance."""
