"""Who gets which seat next (docs/RESERVATIONS.md §4): a pure function of the pool's active rows
and the time, used for the card, the notices and the worker alike.

The waiting members, oldest request first, are matched in order with:
1. free seats (fewer holders than the capacity): the operators can assign them now;
2. seats being returned (the holder pressed 「返却する」): once an operator took it out;
3. holders past their guarantee, the earliest guarantee end first: after the grace period.
Whoever is left waits until another holder's guarantee ends.
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

Step = Literal["assign", "swap", "wait"]


@dataclass(frozen=True)
class Seat:
    id: uuid.UUID
    status: str  # holding / returning
    guarantee_until: datetime | None
    returned_at: datetime | None = None


@dataclass(frozen=True)
class Waiter:
    id: uuid.UUID
    requested_at: datetime


@dataclass
class Plan:
    # waiter id → assign (a free seat) / swap (paired with a holder) / wait
    steps: dict[uuid.UUID, Step] = field(default_factory=dict)
    # waiter id → the holder whose seat it takes, and back
    waiter_pair: dict[uuid.UUID, uuid.UUID] = field(default_factory=dict)
    holder_pair: dict[uuid.UUID, uuid.UUID] = field(default_factory=dict)
    # Holders past their guarantee that a waiter needs (they get the grace notice).
    evict_ids: list[uuid.UUID] = field(default_factory=list)
    # The holder that goes next: the first one to evict, else (someone waits with no seat in
    # sight) the holding one whose guarantee ends first.
    next_evict_id: uuid.UUID | None = None


def _far(moment: datetime | None) -> tuple[int, datetime | None]:
    return (1, None) if moment is None else (0, moment)


def make_plan(capacity: int, seats: list[Seat], waiters: list[Waiter], now: datetime) -> Plan:
    plan = Plan()
    queue = sorted(waiters, key=lambda w: (w.requested_at, w.id))
    free = max(0, capacity - len(seats))
    returning = sorted(
        (s for s in seats if s.status == "returning"),
        key=lambda s: (s.returned_at or now, s.id),
    )
    past = sorted(
        (
            s
            for s in seats
            if s.status == "holding" and s.guarantee_until is not None and s.guarantee_until <= now
        ),
        key=lambda s: (s.guarantee_until, s.id),
    )
    sources = returning + past
    left_waiting = False
    for index, waiter in enumerate(queue):
        if index < free:
            plan.steps[waiter.id] = "assign"
            continue
        slot = index - free
        if slot < len(sources):
            seat = sources[slot]
            plan.steps[waiter.id] = "swap"
            plan.waiter_pair[waiter.id] = seat.id
            plan.holder_pair[seat.id] = waiter.id
            if seat.status == "holding":
                plan.evict_ids.append(seat.id)
        else:
            plan.steps[waiter.id] = "wait"
            left_waiting = True
    if plan.evict_ids:
        plan.next_evict_id = plan.evict_ids[0]
    elif left_waiting:
        holding = sorted(
            (s for s in seats if s.status == "holding"),
            key=lambda s: (_far(s.guarantee_until), s.id),
        )
        if holding:
            plan.next_evict_id = holding[0].id
    return plan
