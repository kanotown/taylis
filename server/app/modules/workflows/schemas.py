from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.messages.schemas import EMOJI_MAX_LENGTH, EMOJI_PATTERN, strip_control_chars
from app.modules.workflows.models import (
    MAX_DESCRIPTION_LENGTH,
    MAX_NAME_LENGTH,
    MAX_TEMPLATE_LENGTH,
    Workflow,
)
from app.modules.workflows.render import (
    MAX_KEY_LENGTH,
    MAX_TEXT,
    MAX_TEXTAREA,
    normalize_key,
    parse_date,
    parse_datetime,
    valid_key,
    valid_time,
)

MAX_FIELDS = 20
MAX_OPTIONS = 30
MAX_OPTION_LENGTH = 80
MAX_LABEL_LENGTH = 40
MAX_HELP_LENGTH = 200
MAX_OFFERED = 10

FieldType = Literal["text", "textarea", "date", "time", "datetime", "select", "user", "checkbox"]
DefaultKind = Literal["literal", "today", "me", "next_weekday"]
RunBlocked = Literal["disabled", "archived", "not_a_member", "posting_restricted"]


def _one_line(value: str) -> str:
    return " ".join(strip_control_chars(value).split())


class FieldDefault(BaseModel):
    """What the form starts with, filled in by the device that opens it (WORKFLOWS.md §3.1):
    a literal value, today, me, or the first `weekday` (0 = Monday) from today on. `time` goes
    with today / next_weekday on a datetime field (09:00 when left out)."""

    model_config = ConfigDict(extra="forbid")

    kind: DefaultKind
    value: bool | str | None = None
    weekday: int | None = Field(default=None, ge=0, le=6)
    time: str | None = None


class WorkflowField(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # 1-30 letters, digits or `_`: the template's {{key}}.
    key: str = Field(min_length=1, max_length=MAX_KEY_LENGTH * 2)
    label: str = Field(min_length=1, max_length=MAX_LABEL_LENGTH * 2)
    type: FieldType
    required: bool = False
    help: str = Field(default="", max_length=MAX_HELP_LENGTH * 2)
    # select only: 1-30 distinct choices.
    options: list[str] = Field(default_factory=list, max_length=MAX_OPTIONS)
    # user only: several people.
    multiple: bool = False
    default: FieldDefault | None = None

    @field_validator("key")
    @classmethod
    def _key(cls, value: str) -> str:
        key = normalize_key(value)
        if not valid_key(key):
            raise ValueError("A key is 1-30 letters, digits or _")
        return key

    @field_validator("label")
    @classmethod
    def _label(cls, value: str) -> str:
        label = _one_line(value)
        if not label or len(label) > MAX_LABEL_LENGTH:
            raise ValueError(f"A label is 1-{MAX_LABEL_LENGTH} characters")
        return label

    @field_validator("help")
    @classmethod
    def _help(cls, value: str) -> str:
        text = _one_line(value)
        if len(text) > MAX_HELP_LENGTH:
            raise ValueError(f"At most {MAX_HELP_LENGTH} characters")
        return text

    @field_validator("options")
    @classmethod
    def _options(cls, value: list[str]) -> list[str]:
        return [_one_line(option) for option in value]

    @model_validator(mode="after")
    def _by_type(self) -> "WorkflowField":
        if self.type == "select":
            if not self.options:
                raise ValueError("A choice field needs options")
            if any(not o or len(o) > MAX_OPTION_LENGTH for o in self.options):
                raise ValueError(f"Each option is 1-{MAX_OPTION_LENGTH} characters")
            if len(set(self.options)) != len(self.options):
                raise ValueError("Options must be distinct")
        elif self.options:
            raise ValueError("Options are for choice fields")
        if self.multiple and self.type != "user":
            raise ValueError("multiple is for user fields")
        if self.default is not None:
            _check_default(self.type, self.default, self.options)
        return self


def _check_default(kind: str, default: FieldDefault, options: list[str]) -> None:
    if default.kind != "next_weekday" and default.weekday is not None:
        raise ValueError("weekday goes with next_weekday")
    if default.kind != "literal" and default.value is not None:
        raise ValueError("value goes with literal")
    if default.time is not None:
        if kind != "datetime" or default.kind not in ("today", "next_weekday"):
            raise ValueError("time goes with today / next_weekday on a datetime field")
        if not valid_time(default.time):
            raise ValueError("Use HH:MM")
    if default.kind == "me":
        if kind != "user":
            raise ValueError("me is for user fields")
        return
    if default.kind in ("today", "next_weekday"):
        if kind not in ("date", "datetime"):
            raise ValueError(f"{default.kind} is for date and datetime fields")
        if default.kind == "next_weekday" and default.weekday is None:
            raise ValueError("next_weekday needs a weekday (0 = Monday)")
        return
    value = default.value
    if kind == "user":
        raise ValueError("A user field's default is me")
    if kind == "checkbox":
        if not isinstance(value, bool):
            raise ValueError("A checkbox's default is true or false")
        return
    if not isinstance(value, str):
        raise ValueError("The default is a string")
    if kind == "text" and (len(value) > MAX_TEXT or "\n" in value):
        raise ValueError("Too long")
    if kind == "textarea" and len(value) > MAX_TEXTAREA:
        raise ValueError("Too long")
    if kind == "select" and value not in options:
        raise ValueError("The default is one of the options")
    if kind == "date" and parse_date(value) is None:
        raise ValueError("Use YYYY-MM-DD")
    if kind == "time" and not valid_time(value):
        raise ValueError("Use HH:MM")
    if kind == "datetime" and parse_datetime(value) is None:
        raise ValueError("Use YYYY-MM-DDTHH:MM")


def _check_fields(fields: list[WorkflowField]) -> list[WorkflowField]:
    keys = [field.key for field in fields]
    if len(set(keys)) != len(keys):
        raise ValueError("Field keys must be distinct")
    return fields


def clean_name(value: str) -> str:
    name = _one_line(value)
    if not name or len(name) > MAX_NAME_LENGTH:
        raise ValueError(f"A name is 1-{MAX_NAME_LENGTH} characters")
    return name


def _clean_template(value: str) -> str:
    template = strip_control_chars(value.replace("\r\n", "\n"))
    if not template.strip():
        raise ValueError("The template cannot be blank")
    return template


class WorkflowCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH * 2)
    # A unicode emoji or :shortcode: for the menu (⚡ when null).
    emoji: str | None = Field(default=None, max_length=EMOJI_MAX_LENGTH, pattern=EMOJI_PATTERN)
    description: str = Field(default="", max_length=MAX_DESCRIPTION_LENGTH)
    # Where the message is posted.
    channel_id: UUID
    # More channels whose menu offers it (the target always does).
    offered_channel_ids: list[UUID] = Field(default_factory=list, max_length=MAX_OFFERED)
    fields: list[WorkflowField] = Field(default_factory=list, max_length=MAX_FIELDS)
    template: str = Field(min_length=1, max_length=MAX_TEMPLATE_LENGTH)
    enabled: bool = True
    # Ask first (the form with its preview); false = a workflow without fields posts at once.
    confirm: bool = True

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        return clean_name(value)

    @field_validator("template")
    @classmethod
    def _template(cls, value: str) -> str:
        return _clean_template(value)

    @field_validator("fields")
    @classmethod
    def _fields(cls, value: list[WorkflowField]) -> list[WorkflowField]:
        return _check_fields(value)

    @field_validator("description")
    @classmethod
    def _description(cls, value: str) -> str:
        return strip_control_chars(value).strip()


class WorkflowUpdate(BaseModel):
    """Fields left out stay; `emoji: null` goes back to ⚡."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME_LENGTH * 2)
    emoji: str | None = Field(default=None, max_length=EMOJI_MAX_LENGTH, pattern=EMOJI_PATTERN)
    description: str | None = Field(default=None, max_length=MAX_DESCRIPTION_LENGTH)
    channel_id: UUID | None = None
    offered_channel_ids: list[UUID] | None = Field(default=None, max_length=MAX_OFFERED)
    fields: list[WorkflowField] | None = Field(default=None, max_length=MAX_FIELDS)
    template: str | None = Field(default=None, min_length=1, max_length=MAX_TEMPLATE_LENGTH)
    enabled: bool | None = None
    confirm: bool | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str | None:
        return None if value is None else clean_name(value)

    @field_validator("template")
    @classmethod
    def _template(cls, value: str | None) -> str | None:
        return None if value is None else _clean_template(value)

    @field_validator("fields")
    @classmethod
    def _fields(cls, value: list[WorkflowField] | None) -> list[WorkflowField] | None:
        return None if value is None else _check_fields(value)

    @field_validator("description")
    @classmethod
    def _description(cls, value: str | None) -> str | None:
        return None if value is None else strip_control_chars(value).strip()

    @model_validator(mode="after")
    def _no_nulls(self) -> "WorkflowUpdate":
        for name in (
            "name",
            "description",
            "channel_id",
            "offered_channel_ids",
            "fields",
            "template",
            "enabled",
            "confirm",
        ):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        return self


class WorkflowSubmit(BaseModel):
    """POST /workflows/{id}/submit: the idempotency key and each field's value by key."""

    model_config = ConfigDict(extra="forbid")

    client_msg_id: UUID
    # text / textarea / date / time / datetime / select: a string; user: a list of user ids
    # (or one id); checkbox: true / false. Optional fields may be left out.
    values: dict[str, Any] = Field(default_factory=dict, max_length=40)


class WorkflowOut(BaseModel):
    id: UUID
    name: str
    emoji: str | None
    description: str
    channel_id: UUID
    offered_channel_ids: list[UUID]
    fields: list[WorkflowField]
    template: str
    enabled: bool
    # Whether running it asks first (WORKFLOWS.md §11). Clients that do not know it always ask.
    confirm: bool
    created_by: UUID
    created_at: datetime
    updated_at: datetime
    # For the viewer: whether they may change it, and whether (or why not) they may submit it.
    can_manage: bool
    can_run: bool
    run_blocked: RunBlocked | None


class WorkflowTemplateOut(BaseModel):
    """A starting point for the editor (「テンプレートから作成」); never a workflow by itself."""

    key: str
    name: str
    emoji: str | None
    description: str
    fields: list[WorkflowField]
    template: str


def to_workflow_out(
    row: Workflow, *, can_manage: bool, run_blocked: RunBlocked | None
) -> WorkflowOut:
    return WorkflowOut(
        id=row.id,
        name=row.name,
        emoji=row.emoji,
        description=row.description,
        channel_id=row.channel_id,
        offered_channel_ids=list(row.offered_channel_ids),
        fields=[WorkflowField.model_validate(field) for field in row.fields],
        template=row.template,
        enabled=row.enabled,
        confirm=row.confirm,
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
        can_manage=can_manage,
        can_run=run_blocked is None,
        run_blocked=run_blocked,
    )


def fields_json(fields: list[WorkflowField]) -> list[dict[str, Any]]:
    return [field.model_dump(mode="json") for field in fields]
