from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.messages.schemas import strip_control_chars
from app.modules.recurring.models import MAX_BODY_LENGTH, MAX_NAME_LENGTH, RecurringPost
from app.modules.recurring.schedule import parse_time

# Targets named one by one at most (groups are expanded when posting).
MAX_TARGET_USERS = 200
MAX_TARGET_GROUPS = 20
MAX_AFTER_DAYS = 30


def _hhmm(value: str) -> str:
    parse_time(value)
    return value


class WeeklySchedule(BaseModel):
    """Every week on `weekdays` (0 = Monday … 6 = Sunday) at `time` (HH:MM)."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["weekly"]
    weekdays: list[int] = Field(min_length=1, max_length=7)
    time: str

    @field_validator("weekdays")
    @classmethod
    def _weekdays(cls, value: list[int]) -> list[int]:
        if any(day < 0 or day > 6 for day in value):
            raise ValueError("Weekdays are 0 (Monday) to 6 (Sunday)")
        return sorted(set(value))

    @field_validator("time")
    @classmethod
    def _time(cls, value: str) -> str:
        return _hhmm(value)


class MonthlySchedule(BaseModel):
    """Every month on `day` (1-31; a month without that day runs on its last day) at `time`."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["monthly"]
    day: int = Field(ge=1, le=31)
    time: str

    @field_validator("time")
    @classmethod
    def _time(cls, value: str) -> str:
        return _hhmm(value)


Schedule = Annotated[WeeklySchedule | MonthlySchedule, Field(discriminator="kind")]


class CollectTargets(BaseModel):
    """Whom to collect from: the union of the groups' members, the people and (all_members) the
    whole channel, limited to the channel's members (not bots) when each post goes out."""

    model_config = ConfigDict(extra="forbid")

    group_ids: list[UUID] = Field(default_factory=list, max_length=MAX_TARGET_GROUPS)
    user_ids: list[UUID] = Field(default_factory=list, max_length=MAX_TARGET_USERS)
    all_members: bool = False

    @field_validator("group_ids", "user_ids")
    @classmethod
    def _distinct(cls, value: list[UUID]) -> list[UUID]:
        return list(dict.fromkeys(value))

    @model_validator(mode="after")
    def _someone(self) -> "CollectTargets":
        if not self.all_members and not self.group_ids and not self.user_ids:
            raise ValueError("Choose whom to collect from")
        return self


class CollectDue(BaseModel):
    """Due `after_days` days after the posting day (0-30) at `time` (HH:MM), in the post's zone."""

    model_config = ConfigDict(extra="forbid")

    after_days: int = Field(ge=0, le=MAX_AFTER_DAYS)
    time: str

    @field_validator("time")
    @classmethod
    def _time(cls, value: str) -> str:
        return _hhmm(value)


class CollectSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    targets: CollectTargets
    due: CollectDue


def _clean_name(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = " ".join(strip_control_chars(value).split())
    if not cleaned:
        raise ValueError("A name cannot be blank")
    if len(cleaned) > MAX_NAME_LENGTH:
        raise ValueError(f"At most {MAX_NAME_LENGTH} characters")
    return cleaned


def _clean_body(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = strip_control_chars(value.replace("\r\n", "\n"))
    if not cleaned.strip():
        raise ValueError("The body cannot be blank")
    return cleaned


def _zone(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("Unknown time zone") from exc
    return value


class RecurringPostCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH * 2)
    body: str = Field(min_length=1, max_length=MAX_BODY_LENGTH)
    schedule: Schedule
    # The zone the schedule and the due time are read in (the creating device's).
    tz: str = Field(max_length=64)
    collect: CollectSpec | None = None
    enabled: bool = True

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str | None:
        return _clean_name(value)

    @field_validator("body")
    @classmethod
    def _body(cls, value: str | None) -> str | None:
        return _clean_body(value)

    @field_validator("tz")
    @classmethod
    def _tz(cls, value: str | None) -> str | None:
        return _zone(value)


class RecurringPostUpdate(BaseModel):
    """Fields left out stay; `collect: null` turns collecting off."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME_LENGTH * 2)
    body: str | None = Field(default=None, min_length=1, max_length=MAX_BODY_LENGTH)
    schedule: Schedule | None = None
    tz: str | None = Field(default=None, max_length=64)
    collect: CollectSpec | None = None
    enabled: bool | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str | None:
        return _clean_name(value)

    @field_validator("body")
    @classmethod
    def _body(cls, value: str | None) -> str | None:
        return _clean_body(value)

    @field_validator("tz")
    @classmethod
    def _tz(cls, value: str | None) -> str | None:
        return _zone(value)

    @model_validator(mode="after")
    def _no_nulls(self) -> "RecurringPostUpdate":
        for field in ("name", "body", "schedule", "tz", "enabled"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class RecurringPostOut(BaseModel):
    id: UUID
    channel_id: UUID
    # The bot that posts (its display name is `name`).
    bot_user_id: UUID
    created_by: UUID
    name: str
    body: str
    schedule: WeeklySchedule | MonthlySchedule
    tz: str
    collect: CollectSpec | None
    enabled: bool
    # The next scheduled post (also while paused: what resuming would keep).
    next_run_at: datetime
    last_run_at: datetime | None
    created_at: datetime
    updated_at: datetime


class RecurringRunOut(BaseModel):
    """POST /recurring-posts/{id}/run: the message just posted."""

    message_id: UUID


def schedule_dict(schedule: WeeklySchedule | MonthlySchedule) -> dict[str, Any]:
    return schedule.model_dump(mode="json")


def to_recurring_out(row: RecurringPost) -> RecurringPostOut:
    schedule: WeeklySchedule | MonthlySchedule
    if row.schedule.get("kind") == "weekly":
        schedule = WeeklySchedule.model_validate(row.schedule)
    else:
        schedule = MonthlySchedule.model_validate(row.schedule)
    return RecurringPostOut(
        id=row.id,
        channel_id=row.channel_id,
        bot_user_id=row.bot_user_id,
        created_by=row.created_by,
        name=row.name,
        body=row.body,
        schedule=schedule,
        tz=row.tz,
        collect=CollectSpec.model_validate(row.collect) if row.collect else None,
        enabled=row.enabled,
        next_run_at=row.next_run_at,
        last_run_at=row.last_run_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )
