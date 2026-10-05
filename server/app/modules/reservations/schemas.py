from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.messages.schemas import strip_control_chars
from app.modules.reservations.models import MAX_NAME_LENGTH
from app.modules.users.dnd import valid_zone

MAX_CAPACITY = 100
MAX_MIN_HOURS = 720  # 30 days
MAX_BOOKING_HOURS = 24
MAX_GRACE_MINUTES = 1440
MAX_OPERATORS = 20

Visibility = Literal["all", "channel", "group"]


def _name(value: str) -> str:
    value = strip_control_chars(value).strip()
    if not value:
        raise ValueError("The name must not be blank")
    return value


def _zone(value: str) -> str:
    if not valid_zone(value):
        raise ValueError("Unknown time zone")
    return value


def _operators(value: list[UUID]) -> list[UUID]:
    return list(dict.fromkeys(value))


class PoolCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH, examples=["Claude Premium シート"])
    capacity: int = Field(ge=1, le=MAX_CAPACITY, description="Seats in the pool")
    min_hours: int = Field(
        default=6,
        ge=0,
        le=MAX_MIN_HOURS,
        description="Walk-ins (「今すぐ」): a holder keeps the seat at least this long from "
        "assignment, or until a booking needs it if that comes first",
    )
    max_hours: int = Field(
        default=6, ge=1, le=MAX_BOOKING_HOURS, description="The longest booking (hours)"
    )
    grace_minutes: int = Field(
        default=15,
        ge=0,
        le=MAX_GRACE_MINUTES,
        description="Notice a walk-in past the guarantee gets before the operators may take the "
        "seat for someone in the queue",
    )
    operator_ids: list[UUID] = Field(
        default_factory=list,
        max_length=MAX_OPERATORS,
        description="Members who hand the seats out (get the to-dos, see the members' email)",
    )
    tz: str = Field(
        default="Asia/Tokyo",
        max_length=64,
        description="The zone of the booking grid (whole hours) and of the notices' times",
    )
    enabled: bool = True
    log_channel_id: UUID | None = Field(
        default=None,
        description="A channel the 「予約」 bot writes a line in for each change (none: no posts)",
    )
    visibility: Visibility = Field(
        default="all",
        description="all = every member (not guests); channel / group = that channel's or "
        "group's members (the operators and administrators always see it)",
    )
    visibility_channel_id: UUID | None = None
    visibility_group_id: UUID | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        return _name(value)

    @field_validator("tz")
    @classmethod
    def _check_zone(cls, value: str) -> str:
        return _zone(value)

    @field_validator("operator_ids")
    @classmethod
    def _dedupe(cls, value: list[UUID]) -> list[UUID]:
        return _operators(value)


class PoolUpdate(BaseModel):
    """Changes apply from now on: a changed min_hours counts for the next assignments, a lower
    max_hours for the next bookings. `log_channel_id`, `visibility_*`: null clears them."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME_LENGTH)
    capacity: int | None = Field(default=None, ge=1, le=MAX_CAPACITY)
    min_hours: int | None = Field(default=None, ge=0, le=MAX_MIN_HOURS)
    max_hours: int | None = Field(default=None, ge=1, le=MAX_BOOKING_HOURS)
    grace_minutes: int | None = Field(default=None, ge=0, le=MAX_GRACE_MINUTES)
    operator_ids: list[UUID] | None = Field(default=None, max_length=MAX_OPERATORS)
    tz: str | None = Field(default=None, max_length=64)
    enabled: bool | None = None
    log_channel_id: UUID | None = None
    visibility: Visibility | None = None
    visibility_channel_id: UUID | None = None
    visibility_group_id: UUID | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str | None) -> str | None:
        return None if value is None else _name(value)

    @field_validator("tz")
    @classmethod
    def _check_zone(cls, value: str | None) -> str | None:
        return None if value is None else _zone(value)

    @field_validator("operator_ids")
    @classmethod
    def _dedupe(cls, value: list[UUID] | None) -> list[UUID] | None:
        return None if value is None else _operators(value)


class BookingIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_at: datetime = Field(
        description="On the hour in the pool's zone, from the current hour up to 14 days ahead"
    )
    hours: int = Field(ge=1, le=MAX_BOOKING_HOURS, description="1 to the pool's max_hours")


class ExtendIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    hours: int = Field(default=1, ge=1, le=MAX_BOOKING_HOURS)


class SwapIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    remove_id: UUID = Field(description="The reservation on a seat taken out")
    assign_id: UUID = Field(description="The waiting walk-in or the started booking that gets it")


class ReservationOut(BaseModel):
    id: UUID
    user_id: UUID
    kind: Literal["walkin", "booking"]
    status: Literal["waiting", "booked", "holding", "returning", "done"]
    requested_at: datetime
    start_at: datetime | None = Field(description="A booking's slot")
    end_at: datetime | None
    assigned_at: datetime | None
    guarantee_until: datetime | None = Field(
        description="A walk-in: assignment + min_hours, or when a booking needs the seat if "
        "sooner; a booking: end_at"
    )
    returned_at: datetime | None
    evict_at: datetime | None = Field(
        description="A walk-in someone needs: when the seat goes (it was told)"
    )
    email: str | None = Field(
        description="The member's address, only for those who can operate the pool (to find "
        "the account in the resource's own console)"
    )
    position: int | None = Field(description="A waiting walk-in's place in the queue, from 1")
    step: Literal["assign", "swap", "wait"] | None = Field(
        description="A waiting walk-in or a started booking: assign = a seat is free; swap = "
        "takes pair_id's seat; wait = no seat in sight yet"
    )
    pair_id: UUID | None = Field(
        description="The reservation on the other side of a swap (a claimant's holder, a "
        "holder's claimant)"
    )
    ready: bool = Field(description="An operator can act on it now")
    until: datetime | None = Field(
        description="A waiting walk-in with a free seat: a booking needs that seat from then "
        "(「〜13:00 まで」); null = the full guarantee"
    )
    can_extend: bool = Field(
        description="The caller's booking can grow by an hour (the next hour has a seat, within "
        "max_hours and the 14 days)"
    )


class TodoOut(BaseModel):
    """Something an operator does in the resource's console, then presses here."""

    key: str
    action: Literal["assign", "swap", "remove"]
    reason: Literal["free", "returned", "booking_ended", "guarantee_over"]
    assign_id: UUID | None = Field(description="The reservation to give a seat (assign, swap)")
    remove_id: UUID | None = Field(description="The reservation to take out (remove, swap)")
    due_at: datetime = Field(description="When it is (or was) due")
    upcoming: bool = Field(description="A booking that starts within 10 minutes: not yet")


class PoolOut(BaseModel):
    id: UUID
    name: str
    capacity: int
    min_hours: int
    max_hours: int
    grace_minutes: int
    tz: str
    enabled: bool
    operator_ids: list[UUID]
    log_channel_id: UUID | None
    visibility: Visibility
    visibility_channel_id: UUID | None
    visibility_group_id: UUID | None
    holders: list[ReservationOut] = Field(description="On a seat (holding, returning)")
    waiting: list[ReservationOut] = Field(description="The walk-in queue, in order")
    bookings: list[ReservationOut] = Field(
        description="Bookings from the start of today (the pool's zone) on, not cancelled: "
        "booked, on a seat, or done today"
    )
    todos: list[TodoOut] = Field(description="The operators' to-do (empty for the others)")
    next_evict_id: UUID | None = Field(
        description="The walk-in whose seat goes next while someone waits (「次に外す」)"
    )
    my_reservation_id: UUID | None = Field(description="The caller's active walk-in request")
    my_active_id: UUID | None = Field(
        default=None,
        description="The caller's one active reservation in the pool (waiting, booked, on a "
        "seat or returned but not yet removed); while it is set, 「今すぐ」 and 「予約する」 "
        "answer 409 reservation_already_active",
    )
    can_manage: bool = Field(description="May change the settings (its creator, administrators)")
    can_operate: bool = Field(
        description="May assign / remove / swap / cancel others (operators, its creator, "
        "administrators)"
    )
    horizon_days: int = Field(description="Bookings reach this many days past today")
    created_at: datetime
    updated_at: datetime


class ReservationUpdatedData(BaseModel):
    """`reservation.updated` (all): a pool changed (its settings, bookings, queue or holders, or
    it was deleted). Clients showing the reservations page load the pools again (GET
    /reservation-pools): what a pool shows differs per person."""

    pool_id: UUID
    deleted: bool = False


class ReservationNoticeData(BaseModel):
    """`reservation.notice` (user): a new activity item of kind reservation for me (a to-do as an
    operator, or news about my own reservation). The push; clients refresh the activity badge."""

    item_id: UUID
    pool_id: UUID
    reservation_id: UUID | None
    text: str
    operator: bool
    at: datetime
