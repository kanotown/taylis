"""Who gets which seat, and when (docs/RESERVATIONS.md §4): pure functions of a pool's active rows
and the time, used for the page, the notices, the worker and the booking checks alike.

Claimants of a seat at a moment, in this order:
1. bookings whose slot has started (earliest start first) — a booking is a promise;
2. the walk-in queue (oldest request first).
They are matched in order with the seats that can be had:
1. free seats (fewer people on seats than the capacity): an operator can assign now;
2. released seats: a holder who pressed 「返却する」, or a booking whose time is over;
3. walk-ins past their guarantee (the earliest end first): for a booking at once (the walk-in's
   guarantee never runs past a booking that needs the seat, and they were told `LEAD` before),
   for the queue after the grace period they are told of.
Whoever is left waits.

Bookings are checked against every hour they cover: bookings on that hour plus walk-ins whose
guarantee reaches into it must stay below the capacity. A walk-in's guarantee, in turn, ends
where bookings would need its seat ("〜13:00 まで"). So no promise is ever broken: a booking
always finds a seat at its start, a walk-in is never taken out inside its guarantee.
"""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Literal

Step = Literal["assign", "swap", "wait"]
Kind = Literal["walkin", "booking"]
Action = Literal["assign", "swap", "remove"]
# remove/swap: why the seat can be taken.
Reason = Literal["free", "returned", "booking_ended", "guarantee_over"]

HOUR = timedelta(hours=1)
# Operators hear of a booking this long before it starts (and the walk-in it replaces is told).
LEAD = timedelta(minutes=10)
_EPOCH = datetime(2000, 1, 1, tzinfo=UTC)


@dataclass(frozen=True)
class Holder:
    """Someone on a seat (holding or returning)."""

    id: uuid.UUID
    kind: Kind
    status: str  # holding / returning
    guarantee_until: datetime | None
    start_at: datetime | None = None  # a booking's slot
    end_at: datetime | None = None
    returned_at: datetime | None = None
    evict_at: datetime | None = None  # a walk-in told it goes: when
    evict_notice_at: datetime | None = None  # ...and when it was first told


@dataclass(frozen=True)
class Booking:
    """A booking not on a seat yet (status booked)."""

    id: uuid.UUID
    start_at: datetime
    end_at: datetime


@dataclass(frozen=True)
class Waiter:
    id: uuid.UUID
    requested_at: datetime


@dataclass(frozen=True)
class Todo:
    """Something an operator can do (now, or for an upcoming booking soon)."""

    key: str
    action: Action
    reason: Reason
    assign_id: uuid.UUID | None
    remove_id: uuid.UUID | None
    due_at: datetime


@dataclass
class Plan:
    # Claimant (waiter or started booking) → assign / swap / wait.
    steps: dict[uuid.UUID, Step] = field(default_factory=dict)
    claimant_pair: dict[uuid.UUID, uuid.UUID] = field(default_factory=dict)
    holder_pair: dict[uuid.UUID, uuid.UUID] = field(default_factory=dict)
    # Walk-ins someone needs → when their seat goes. A new entry (the holder has no evict_at yet)
    # is a notice to send; a different time than the holder's evict_at a correction; a holder
    # with evict_at that is not here keeps the seat.
    evict: dict[uuid.UUID, datetime] = field(default_factory=dict)
    # Claimants and holders an operator can act on now.
    ready: set[uuid.UUID] = field(default_factory=set)
    todos: list[Todo] = field(default_factory=list)
    # Bookings starting within LEAD: what the operators will do then.
    upcoming: list[Todo] = field(default_factory=list)
    # Waiters with a free seat that is free for less than the guarantee: until when.
    until: dict[uuid.UUID, datetime] = field(default_factory=dict)
    # The holder that goes next while someone waits (「次に外す」).
    next_evict_id: uuid.UUID | None = None


def _released(holder: Holder, at: datetime) -> bool:
    return holder.status == "returning" or (
        holder.kind == "booking" and holder.end_at is not None and holder.end_at <= at
    )


def _released_since(holder: Holder) -> datetime:
    if holder.status == "returning" and holder.returned_at is not None:
        return holder.returned_at
    return holder.end_at or holder.returned_at or _EPOCH


def _evictable(holder: Holder, at: datetime) -> bool:
    return (
        holder.kind == "walkin"
        and holder.status == "holding"
        and holder.guarantee_until is not None
        and holder.guarantee_until <= at
    )


@dataclass
class _Match:
    claimant: uuid.UUID
    booking: Booking | None  # None: a waiter
    step: Step
    holder: Holder | None = None


def _match(
    capacity: int,
    holders: list[Holder],
    bookings: list[Booking],
    waiters: list[Waiter],
    at: datetime,
) -> list[_Match]:
    started = sorted(
        (b for b in bookings if b.start_at <= at < b.end_at), key=lambda b: (b.start_at, b.id)
    )
    queue = sorted(waiters, key=lambda w: (w.requested_at, w.id))
    free = max(0, capacity - len(holders))
    released = sorted(
        (h for h in holders if _released(h, at)), key=lambda h: (_released_since(h), h.id)
    )
    evictable = sorted(
        (h for h in holders if not _released(h, at) and _evictable(h, at)),
        key=lambda h: (h.guarantee_until, h.id),
    )
    sources = released + evictable
    out: list[_Match] = []
    claimants: list[tuple[uuid.UUID, Booking | None]] = [(b.id, b) for b in started]
    claimants += [(w.id, None) for w in queue]
    for index, (cid, booking) in enumerate(claimants):
        if index < free:
            out.append(_Match(cid, booking, "assign"))
        elif index - free < len(sources):
            out.append(_Match(cid, booking, "swap", sources[index - free]))
        else:
            out.append(_Match(cid, booking, "wait"))
    return out


def promises(holders: list[Holder], bookings: list[Booking]) -> list[Booking]:
    """Every booking on the books: those waiting for their start and those on a seat."""
    seated = [
        Booking(h.id, h.start_at or h.end_at - HOUR, h.end_at)
        for h in holders
        if h.kind == "booking" and h.end_at is not None
    ]
    return [*bookings, *seated]


def seats_needed(holders: list[Holder], bookings: list[Booking], at: datetime) -> int:
    """Seats promised at `at`: bookings covering it (booked or on a seat) and walk-ins whose
    guarantee reaches past it."""
    count = sum(1 for b in promises(holders, bookings) if b.start_at <= at < b.end_at)
    count += sum(
        1
        for h in holders
        if h.kind == "walkin"
        and h.status == "holding"
        and h.guarantee_until is not None
        and h.guarantee_until > at
    )
    return count


def free_until(
    capacity: int,
    holders: list[Holder],
    bookings: list[Booking],
    now: datetime,
    cap: datetime,
) -> datetime:
    """How long a seat given to a walk-in now stays free of promises (at most `cap`): the first
    moment the bookings and the other walk-ins' guarantees would need every seat."""
    starts = sorted({b.start_at for b in promises(holders, bookings) if now < b.start_at < cap})
    for moment in [now, *starts]:
        if seats_needed(holders, bookings, moment) + 1 > capacity:
            return moment
    return cap


def booking_conflict(
    capacity: int,
    holders: list[Holder],
    bookings: list[Booking],
    start: datetime,
    end: datetime,
    now: datetime,
) -> datetime | None:
    """The first hour of [start, end) that has no seat left for one more booking, else None.
    `bookings`: the other bookings waiting for their start (those on a seat come from
    `holders`); leave the one being extended out of both."""
    books = promises(holders, bookings)
    hour = start
    while hour < end:
        window_end = hour + HOUR
        count = sum(1 for b in books if b.start_at < window_end and b.end_at > hour)
        moment = max(hour, now)
        count += sum(
            1
            for h in holders
            if h.kind == "walkin"
            and h.status == "holding"
            and h.guarantee_until is not None
            and h.guarantee_until > moment
            and moment < window_end
        )
        if count + 1 > capacity:
            return hour
        hour = window_end
    return None


def _goes(holder: Holder, booking: Booking | None, now: datetime, grace: timedelta) -> datetime:
    """When a walk-in past its guarantee leaves for this claimant. For a booking: at its start
    (they were told `LEAD` before). For the queue: the grace after they were first told, and
    never before a time they were told (review v0.1.37 #5: computed afresh each time, so a
    booking that needs the seat earlier than the queue's deadline moves it forward, and a
    booking cancelled gives the queue's deadline back)."""
    if booking is not None:
        return max(holder.guarantee_until or booking.start_at, booking.start_at)
    if holder.evict_at is None:
        return now + grace
    if holder.evict_notice_at is None:
        return holder.evict_at
    return max(holder.evict_at, holder.evict_notice_at + grace)


def _set_evict(plan: Plan, holder: Holder, claimant: uuid.UUID, goes: datetime) -> None:
    """The earliest claimant's time wins (and is who the holder is shown to go for)."""
    kept = plan.evict.get(holder.id)
    if kept is None or goes < kept:
        plan.evict[holder.id] = goes
        plan.holder_pair[holder.id] = claimant


def _todo(match: _Match, at: datetime) -> Todo:
    cid = match.claimant
    due = match.booking.start_at if match.booking is not None else at
    if match.holder is None:
        return Todo(f"assign:{cid}", "assign", "free", cid, None, due)
    holder = match.holder
    reason: Reason
    if holder.status == "returning":
        reason = "returned"
    elif holder.kind == "booking":
        reason = "booking_ended"
    else:
        reason = "guarantee_over"
    return Todo(f"swap:{holder.id}:{cid}", "swap", reason, cid, holder.id, due)


def make_plan(
    capacity: int,
    holders: list[Holder],
    bookings: list[Booking],
    waiters: list[Waiter],
    now: datetime,
    *,
    grace: timedelta = timedelta(0),
    min_hours: int = 0,
) -> Plan:
    plan = Plan()
    matches = _match(capacity, holders, bookings, waiters, now)
    paired: set[uuid.UUID] = set()
    left_waiting = False
    # The walk-ins given a free seat now hold it, in the free-until reckoning of those after them.
    virtual: list[Holder] = list(holders)
    for match in matches:
        plan.steps[match.claimant] = match.step
        if match.step == "wait":
            left_waiting = True
            continue
        if match.step == "assign":
            plan.ready.add(match.claimant)
            plan.todos.append(_todo(match, now))
            if match.booking is None:
                cap = now + timedelta(hours=min_hours)
                until = free_until(capacity, virtual, bookings, now, cap)
                if until < cap:
                    plan.until[match.claimant] = until
                virtual.append(Holder(match.claimant, "walkin", "holding", until))
            continue
        holder = match.holder
        assert holder is not None
        paired.add(holder.id)
        plan.claimant_pair[match.claimant] = holder.id
        plan.holder_pair[holder.id] = match.claimant
        ready = True
        if not _released(holder, now):  # a walk-in past its guarantee
            _set_evict(plan, holder, match.claimant, _goes(holder, match.booking, now, grace))
            ready = plan.evict[holder.id] <= now
        if ready:
            plan.ready.update({match.claimant, holder.id})
            plan.todos.append(_todo(match, now))
    # Released seats nobody claims: the operators take them out.
    for holder in sorted(holders, key=lambda h: (_released_since(h), h.id)):
        if holder.id not in paired and _released(holder, now):
            plan.ready.add(holder.id)
            reason: Reason = "returned" if holder.status == "returning" else "booking_ended"
            due = holder.returned_at if holder.status == "returning" else holder.end_at
            plan.todos.append(
                Todo(f"remove:{holder.id}", "remove", reason, None, holder.id, due or now)
            )

    # Bookings starting within LEAD: who gets which seat then (the walk-in it replaces is told
    # now, and goes at the booking's start).
    soon = now + LEAD
    coming = {b.id: b for b in bookings if now < b.start_at <= soon}
    if coming:
        for match in _match(capacity, holders, bookings, waiters, soon):
            booking = coming.get(match.claimant)
            if booking is None or match.step == "wait":
                continue
            todo = _todo(match, soon)
            plan.upcoming.append(
                Todo(
                    f"booking:{booking.id}",
                    todo.action,
                    todo.reason,
                    booking.id,
                    todo.remove_id,
                    booking.start_at,
                )
            )
            holder = match.holder
            if holder is not None and not _released(holder, soon):
                # Also when the queue has a later time for them already (review v0.1.37 #5).
                _set_evict(plan, holder, booking.id, _goes(holder, booking, now, grace))

    evicting = [h for h in holders if h.id in plan.evict]
    if evicting:
        plan.next_evict_id = min(
            evicting, key=lambda h: (plan.evict[h.id], h.guarantee_until or now, h.id)
        ).id
    elif left_waiting:
        walkins = [h for h in holders if h.kind == "walkin" and h.status == "holding"]
        if walkins:
            plan.next_evict_id = min(
                walkins, key=lambda h: (h.guarantee_until is None, h.guarantee_until or now, h.id)
            ).id
    return plan
