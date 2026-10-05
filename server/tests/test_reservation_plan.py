"""M112 (docs/RESERVATIONS.md §4): the reservation plan, a pure function."""

import uuid
from datetime import UTC, datetime, timedelta

from app.modules.reservations.plan import (
    HOUR,
    LEAD,
    Booking,
    Holder,
    Waiter,
    booking_conflict,
    free_until,
    make_plan,
    seats_needed,
)

T0 = datetime(2026, 10, 5, 9, 0, tzinfo=UTC)


def _id(n: int) -> uuid.UUID:
    return uuid.UUID(int=n)


def _walkin(n: int, guarantee: datetime | None, **extra: object) -> Holder:
    return Holder(_id(n), "walkin", str(extra.pop("status", "holding")), guarantee, **extra)  # type: ignore[arg-type]


def _seated(n: int, start: datetime, end: datetime, status: str = "holding") -> Holder:
    return Holder(_id(n), "booking", status, end, start_at=start, end_at=end)


# --- the walk-in queue (M99's rules) ----------------------------------------------------------


def test_queue_free_seats_then_returns_then_earliest_guarantee_end() -> None:
    holders = [
        _walkin(1, T0 + HOUR),  # not past yet
        _walkin(2, T0 - HOUR),  # past, ended later
        _walkin(3, T0 - 3 * HOUR),  # past, ended first
        _walkin(4, T0, status="returning", returned_at=T0 - timedelta(minutes=5)),
    ]
    waiters = [Waiter(_id(10 + i), T0 - timedelta(minutes=30 - i)) for i in range(5)]
    plan = make_plan(5, holders, [], waiters, T0, grace=timedelta(minutes=15))
    assert plan.steps == {
        _id(10): "assign",
        _id(11): "swap",
        _id(12): "swap",
        _id(13): "swap",
        _id(14): "wait",
    }
    assert plan.claimant_pair == {_id(11): _id(4), _id(12): _id(3), _id(13): _id(2)}
    # the past holders are told they go after the grace; the return is ready now
    assert plan.evict == {_id(3): T0 + timedelta(minutes=15), _id(2): T0 + timedelta(minutes=15)}
    assert plan.next_evict_id == _id(3)
    assert {t.key for t in plan.todos} == {f"assign:{_id(10)}", f"swap:{_id(4)}:{_id(11)}"}
    assert _id(12) not in plan.ready and _id(4) in plan.ready


def test_queue_grace_once_told_then_ready() -> None:
    told = _walkin(1, T0 - HOUR, evict_at=T0 + timedelta(minutes=5))
    plan = make_plan(1, [told], [], [Waiter(_id(9), T0)], T0, grace=timedelta(minutes=15))
    assert plan.evict == {_id(1): T0 + timedelta(minutes=5)} and plan.todos == []
    later = make_plan(
        1, [told], [], [Waiter(_id(9), T0)], T0 + timedelta(minutes=6), grace=timedelta(15)
    )
    assert [t.key for t in later.todos] == [f"swap:{_id(1)}:{_id(9)}"]
    assert later.todos[0].reason == "guarantee_over" and {_id(1), _id(9)} <= later.ready


def test_nobody_waits_nobody_goes_and_the_first_to_end_is_shown() -> None:
    holders = [_walkin(1, T0 + 5 * HOUR), _walkin(2, T0 + 2 * HOUR)]
    plan = make_plan(2, holders, [], [Waiter(_id(9), T0)], T0)
    assert plan.steps == {_id(9): "wait"} and plan.evict == {} and plan.next_evict_id == _id(2)
    assert make_plan(2, holders, [], [], T0 + timedelta(days=1)).next_evict_id is None


def test_returned_seat_nobody_claims_is_a_remove_todo() -> None:
    back = _walkin(1, T0 + HOUR, status="returning", returned_at=T0)
    plan = make_plan(2, [back], [], [], T0)
    assert [(t.action, t.reason, t.remove_id) for t in plan.todos] == [
        ("remove", "returned", _id(1))
    ]


# --- bookings -------------------------------------------------------------------------------------


def test_a_started_booking_comes_before_the_queue() -> None:
    booking = Booking(_id(20), T0, T0 + 2 * HOUR)
    plan = make_plan(1, [], [booking], [Waiter(_id(9), T0 - HOUR)], T0)
    assert plan.steps == {_id(20): "assign", _id(9): "wait"}
    assert [t.key for t in plan.todos] == [f"assign:{_id(20)}"]
    assert plan.todos[0].due_at == T0
    # a booking that has not started is no claimant
    later = Booking(_id(21), T0 + HOUR, T0 + 2 * HOUR)
    plan = make_plan(1, [], [later], [Waiter(_id(9), T0 - HOUR)], T0, min_hours=6)
    assert plan.steps == {_id(9): "assign"}
    # ...but the walk-in only has the seat until it starts
    assert plan.until == {_id(9): T0 + HOUR}


def test_booking_takes_the_seat_of_a_walkin_past_its_guarantee_at_once() -> None:
    walkin = _walkin(1, T0)  # its guarantee ended where the booking starts
    booking = Booking(_id(20), T0, T0 + 3 * HOUR)
    plan = make_plan(1, [walkin], [booking], [], T0, grace=timedelta(minutes=15))
    assert plan.steps == {_id(20): "swap"} and plan.claimant_pair == {_id(20): _id(1)}
    assert plan.evict == {_id(1): T0}  # no grace: they were told before
    assert [t.key for t in plan.todos] == [f"swap:{_id(1)}:{_id(20)}"]


def test_upcoming_booking_warns_the_operators_and_the_walkin_lead_minutes_before() -> None:
    walkin = _walkin(1, T0 + HOUR)
    booking = Booking(_id(20), T0 + HOUR, T0 + 2 * HOUR)
    early = make_plan(1, [walkin], [booking], [], T0 + HOUR - LEAD - timedelta(minutes=1))
    assert early.upcoming == [] and early.evict == {}
    now = T0 + HOUR - LEAD
    plan = make_plan(1, [walkin], [booking], [], now)
    assert [(t.key, t.action, t.remove_id) for t in plan.upcoming] == [
        (f"booking:{_id(20)}", "swap", _id(1))
    ]
    assert plan.upcoming[0].due_at == T0 + HOUR
    assert plan.evict == {_id(1): T0 + HOUR} and plan.next_evict_id == _id(1)
    assert plan.todos == []  # nothing to do yet
    # a free seat: the operators only hear they will assign
    free = make_plan(2, [walkin], [booking], [], now)
    assert [(t.action, t.remove_id) for t in free.upcoming] == [("assign", None)]
    assert free.evict == {}


def test_a_booking_on_a_seat_past_its_end_is_removed_or_swapped() -> None:
    seated = _seated(1, T0 - 2 * HOUR, T0)
    plan = make_plan(1, [seated], [], [], T0)
    assert [(t.action, t.reason) for t in plan.todos] == [("remove", "booking_ended")]
    queue = make_plan(1, [seated], [], [Waiter(_id(9), T0)], T0)
    assert [(t.key, t.reason) for t in queue.todos] == [
        (f"swap:{_id(1)}:{_id(9)}", "booking_ended")
    ]
    # inside its time it stays, and nobody waiting is offered its seat
    inside = make_plan(1, [seated], [], [Waiter(_id(9), T0)], T0 - HOUR)
    assert inside.steps == {_id(9): "wait"} and inside.todos == []


def test_capacity_per_hour_window() -> None:
    books = [Booking(_id(20), T0, T0 + 3 * HOUR), Booking(_id(21), T0 + 2 * HOUR, T0 + 4 * HOUR)]
    # two seats: 11:00-12:00 has both bookings
    assert booking_conflict(2, [], books, T0, T0 + HOUR, T0) is None
    assert booking_conflict(2, [], books, T0 + HOUR, T0 + 3 * HOUR, T0) == T0 + 2 * HOUR
    assert booking_conflict(2, [], books, T0 + 3 * HOUR, T0 + 5 * HOUR, T0) is None
    assert booking_conflict(3, [], books, T0, T0 + 6 * HOUR, T0) is None
    # a booking on a seat counts too
    seated = [_seated(1, T0 - HOUR, T0 + HOUR)]
    assert booking_conflict(1, seated, [], T0, T0 + HOUR, T0) == T0
    assert booking_conflict(1, seated, [], T0 + HOUR, T0 + 2 * HOUR, T0) is None


def test_walkin_guarantees_block_bookings_but_past_ones_do_not() -> None:
    walkin = _walkin(1, T0 + 2 * HOUR + timedelta(minutes=30))
    assert booking_conflict(1, [walkin], [], T0 + 2 * HOUR, T0 + 3 * HOUR, T0) == T0 + 2 * HOUR
    assert booking_conflict(1, [walkin], [], T0 + 3 * HOUR, T0 + 4 * HOUR, T0) is None
    past = _walkin(2, T0 - timedelta(minutes=1))
    assert booking_conflict(1, [past], [], T0, T0 + HOUR, T0) is None
    returning = _walkin(3, T0 + 5 * HOUR, status="returning", returned_at=T0)
    assert booking_conflict(1, [returning], [], T0, T0 + HOUR, T0) is None


def test_free_until_is_the_first_moment_every_seat_is_promised() -> None:
    books = [Booking(_id(20), T0 + 4 * HOUR, T0 + 6 * HOUR)]
    cap = T0 + 6 * HOUR
    assert free_until(1, [], books, T0, cap) == T0 + 4 * HOUR
    assert free_until(2, [], books, T0, cap) == cap
    # another walk-in's guarantee and a booking together fill two seats from 13:00
    other = _walkin(1, T0 + 5 * HOUR)
    assert free_until(2, [other], books, T0, cap) == T0 + 4 * HOUR
    # a seat promised right now: no time at all
    now_booked = [Booking(_id(21), T0, T0 + HOUR)]
    assert free_until(1, [], now_booked, T0, cap) == T0
    assert seats_needed([other], books, T0 + 4 * HOUR) == 2


def test_two_free_seats_two_waiters_the_second_counts_the_first() -> None:
    books = [Booking(_id(20), T0 + 2 * HOUR, T0 + 4 * HOUR)]
    waiters = [Waiter(_id(9), T0 - HOUR), Waiter(_id(10), T0)]
    plan = make_plan(2, [], books, waiters, T0, min_hours=6)
    assert plan.steps == {_id(9): "assign", _id(10): "assign"}
    assert plan.until == {_id(10): T0 + 2 * HOUR}  # the first keeps 6 h, the second until 11:00


def test_returned_seat_goes_to_a_started_booking_first() -> None:
    back = _walkin(1, T0 + HOUR, status="returning", returned_at=T0 - HOUR)
    booking = Booking(_id(20), T0, T0 + HOUR)
    plan = make_plan(1, [back], [booking], [Waiter(_id(9), T0 - 2 * HOUR)], T0)
    assert plan.claimant_pair == {_id(20): _id(1)} and plan.steps[_id(9)] == "wait"
    assert [t.reason for t in plan.todos] == ["returned"]
