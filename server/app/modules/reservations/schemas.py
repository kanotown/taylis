from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.messages.schemas import strip_control_chars
from app.modules.reservations.models import MAX_NAME_LENGTH
from app.modules.users.dnd import valid_zone

MAX_CAPACITY = 100
MAX_MIN_HOURS = 720  # 30 days
MAX_GRACE_MINUTES = 1440
MAX_OPERATORS = 20


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
        description="A holder keeps the seat at least this long from assignment",
    )
    grace_minutes: int = Field(
        default=15,
        ge=0,
        le=MAX_GRACE_MINUTES,
        description="Notice a holder past the guarantee gets before the operators may take the "
        "seat for a waiting member",
    )
    operator_ids: list[UUID] = Field(
        default_factory=list,
        max_length=MAX_OPERATORS,
        description="Members who hand the seats out (notified, see the requesters' email)",
    )
    tz: str = Field(
        default="Asia/Tokyo",
        max_length=64,
        description="The zone the bot's posts write times in",
    )
    enabled: bool = True

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
    """Changes apply from now on: a changed min_hours counts for the next assignments."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME_LENGTH)
    capacity: int | None = Field(default=None, ge=1, le=MAX_CAPACITY)
    min_hours: int | None = Field(default=None, ge=0, le=MAX_MIN_HOURS)
    grace_minutes: int | None = Field(default=None, ge=0, le=MAX_GRACE_MINUTES)
    operator_ids: list[UUID] | None = Field(default=None, max_length=MAX_OPERATORS)
    tz: str | None = Field(default=None, max_length=64)
    enabled: bool | None = None

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


class SwapIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    remove_id: UUID = Field(description="The holding (or returning) reservation taken out")
    assign_id: UUID = Field(description="The waiting reservation that gets the seat")


class ReservationOut(BaseModel):
    id: UUID
    user_id: UUID
    status: Literal["waiting", "holding", "returning"]
    requested_at: datetime
    assigned_at: datetime | None
    guarantee_until: datetime | None = Field(
        description="assigned_at + the pool's min_hours (fixed at assignment)"
    )
    returned_at: datetime | None
    evict_at: datetime | None = Field(
        description="A holder past the guarantee whom a waiting member needs: when the grace "
        "period ends (it was told)"
    )
    email: str | None = Field(
        description="The member's address, only for those who can operate the pool (to find "
        "the account in the resource's own console)"
    )
    position: int | None = Field(description="A waiting member's place in the queue, from 1")
    step: Literal["assign", "swap", "wait"] | None = Field(
        description="A waiting member: assign = a seat is free; swap = takes pair_id's seat; "
        "wait = no seat in sight yet"
    )
    pair_id: UUID | None = Field(
        description="The reservation on the other side of a swap (a waiter's holder, a "
        "holder's waiter)"
    )
    ready: bool = Field(
        description="An operator can act now: a waiter's seat is free (or its holder is ready); "
        "a holder is returning or past the grace period"
    )


class PoolOut(BaseModel):
    id: UUID
    channel_id: UUID
    name: str
    capacity: int
    min_hours: int
    grace_minutes: int
    tz: str
    enabled: bool
    operator_ids: list[UUID]
    bot_user_id: UUID | None
    holders: list[ReservationOut] = Field(description="Holding and returning, earliest first")
    waiting: list[ReservationOut] = Field(description="The queue, in order")
    next_evict_id: UUID | None = Field(
        description="The holder whose seat goes next while someone waits (「次に外す」)"
    )
    my_reservation_id: UUID | None = Field(description="The caller's active reservation")
    can_manage: bool = Field(description="May change the settings (channel owners, admins)")
    can_operate: bool = Field(
        description="May assign / remove / swap / cancel others (operators, channel owners, admins)"
    )
    created_at: datetime
    updated_at: datetime


class ReservationUpdatedData(BaseModel):
    """`reservation.updated` (channel): a pool of the channel changed (its settings, its queue or
    its holders, or it was deleted). Clients that show the channel's pools load them again
    (GET /channels/{id}/reservation-pools): what the card shows differs per person."""

    channel_id: UUID
    pool_id: UUID
    deleted: bool = False
