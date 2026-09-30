from datetime import date, datetime
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator

AlarmStatus = Literal["pending", "fired", "cancelled"]

# CALENDAR.md §2.
MAX_TITLE_LENGTH = 200
MAX_LOCATION_LENGTH = 200
MAX_DESCRIPTION_LENGTH = 4000


def _clean_title(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = " ".join(value.split())
    if not cleaned:
        raise ValueError("A title cannot be blank")
    return cleaned


def _clean_text(value: str | None) -> str | None:
    """Blank becomes null (no location / no description)."""
    if value is None:
        return None
    cleaned = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    return cleaned or None


def _valid_zone(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("Unknown time zone") from exc
    return value


class CalendarAlarmOut(BaseModel):
    """My alarm on an event (CALENDAR.md §2, §6)."""

    # 0 / 5 / 10 / 15 / 30 / 60 / 1440 minutes before the start; an all-day event: 1440
    # (前日 8:00) or -480 (当日 8:00).
    minutes_before: int
    # When it goes out (worked out again when the event's time changes).
    fire_at: datetime
    # cancelled: the time it works out to had passed, or the event is gone.
    status: AlarmStatus


class CalendarEventData(BaseModel):
    """An event as everyone who sees it sees it: calendar.event.updated carries this (the fields
    that differ per person, can_edit and alarm, are in CalendarEventOut)."""

    id: UUID
    # null: the owner's own calendar. Else the channel's shared calendar.
    channel_id: UUID | None
    channel_name: str | None
    # Who made it (the only one who sees a personal event).
    owner_id: UUID
    title: str
    all_day: bool
    # A timed event: [starts_at, ends_at) in UTC.
    starts_at: datetime | None
    ends_at: datetime | None
    # An all-day event: start_date..end_date, the end included.
    start_date: date | None
    end_date: date | None
    location: str | None
    # Markdown (the messages' syntax).
    description: str | None
    created_at: datetime
    updated_at: datetime


class CalendarEventOut(CalendarEventData):
    # I may change and delete it: a personal event's owner; in a channel (not archived) its
    # creator, the channel's owners and administrators.
    can_edit: bool
    alarm: CalendarAlarmOut | None


class CalendarEventCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Left out: my own calendar. Else a public or private channel I can post in.
    channel_id: UUID | None = None
    title: str = Field(max_length=MAX_TITLE_LENGTH)
    all_day: bool = False
    # A timed event (ends_at after starts_at, at most 14 days).
    starts_at: AwareDatetime | None = None
    ends_at: AwareDatetime | None = None
    # An all-day event (end_date included, at most 60 days).
    start_date: date | None = None
    end_date: date | None = None
    location: str | None = Field(default=None, max_length=MAX_LOCATION_LENGTH)
    description: str | None = Field(default=None, max_length=MAX_DESCRIPTION_LENGTH)
    # My alarm on it (see CalendarAlarmOut.minutes_before).
    alarm_minutes: int | None = None
    # The device's IANA zone: 8:00 of an all-day alarm and the time in the notification.
    # Left out: my quiet-hours zone, else Asia/Tokyo.
    tz: str | None = Field(default=None, max_length=64)
    # Idempotency key: a retry returns the event made by the first request (200).
    client_event_id: UUID | None = None

    _title = field_validator("title")(_clean_title)
    _location = field_validator("location")(_clean_text)
    _description = field_validator("description")(_clean_text)
    _tz = field_validator("tz")(_valid_zone)


class CalendarEventUpdate(BaseModel):
    """Only the fields sent change. Turning all_day on or off needs the other pair of times."""

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=MAX_TITLE_LENGTH)
    all_day: bool | None = None
    starts_at: AwareDatetime | None = None
    ends_at: AwareDatetime | None = None
    start_date: date | None = None
    end_date: date | None = None
    # null (or blank) clears.
    location: str | None = Field(default=None, max_length=MAX_LOCATION_LENGTH)
    description: str | None = Field(default=None, max_length=MAX_DESCRIPTION_LENGTH)

    _title = field_validator("title")(_clean_title)
    _location = field_validator("location")(_clean_text)
    _description = field_validator("description")(_clean_text)


class CalendarAlarmIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    minutes_before: int
    tz: str | None = Field(default=None, max_length=64)

    _tz = field_validator("tz")(_valid_zone)


class CalendarEventUpdatedData(BaseModel):
    """calendar.event.updated: a new or changed event, to those who see it."""

    event: CalendarEventData
    # Who may change it now (can_edit is `my id in editor_ids`): the creator, the channel's owners
    # and the administrators among its members; nobody in an archived channel.
    editor_ids: list[UUID]


class CalendarEventDeletedData(BaseModel):
    id: UUID
    channel_id: UUID | None


class CalendarAlarmUpdatedData(BaseModel):
    """calendar.alarm.updated: my alarm on an event was set, recomputed, fired or removed."""

    event_id: UUID
    channel_id: UUID | None
    alarm: CalendarAlarmOut | None
