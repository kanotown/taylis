"""M112 (docs/RESERVATIONS.md): the workspace's reservation pools — bookings, the walk-in queue,
operator to-dos as activity items, the optional log channel."""

import asyncio
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.settings import Settings
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.groups.models import UserGroup, UserGroupMember
from app.modules.messages.models import Message
from app.modules.reservations import service as reservations
from app.modules.reservations.models import Reservation, ReservationNotice
from app.modules.reservations.schemas import BookingIn
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_push_planner import add_device, deliveries, relay_with_planner

TOKYO = ZoneInfo("Asia/Tokyo")
INCLUDE = {"include": "reservation"}


def _hour(offset: int = 0) -> datetime:
    """The start of the current hour (Tokyo) plus `offset` hours."""
    now = utcnow().astimezone(TOKYO).replace(minute=0, second=0, microsecond=0)
    return now + timedelta(hours=offset)


async def _setup(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], **pool: Any
) -> dict[str, Any]:
    admin = await make_user(db, "boss", role="admin")
    op = await make_user(db, "op")
    op2 = await make_user(db, "op2")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    alice.email = "alice@example.jp"
    bob.email = "bob@example.jp"
    await db.commit()
    as_user(admin)
    made = await client.post(
        "/api/v1/reservation-pools",
        json={
            "name": "Claude Premium シート",
            "capacity": 2,
            "operator_ids": [str(op.id), str(op2.id)],
            **pool,
        },
    )
    assert made.status_code == 201, made.text
    return {
        "pool": made.json(),
        "pid": made.json()["id"],
        "admin": admin,
        "op": op,
        "op2": op2,
        "alice": alice,
        "bob": bob,
        "carol": carol,
    }


async def _book(client: AsyncClient, pid: str, start: datetime, hours: int) -> Any:
    return await client.post(
        f"/api/v1/reservation-pools/{pid}/bookings",
        json={"start_at": start.isoformat(), "hours": hours},
    )


async def _tick(app: FastAPI, now: datetime | None = None) -> int:
    async with app.state.db.session_factory() as session:
        return await reservations.tick(session, now=now)


async def _notices(db: AsyncSession, user: User) -> list[ReservationNotice]:
    rows = await db.execute(
        select(ReservationNotice)
        .where(ReservationNotice.user_id == user.id)
        .order_by(ReservationNotice.at, ReservationNotice.id)
        .execution_options(populate_existing=True)
    )
    return list(rows.scalars().all())


def _mine(pool: dict[str, Any], user: User) -> list[dict[str, Any]]:
    return [b for b in pool["bookings"] if b["user_id"] == str(user.id)]


# --- settings ---------------------------------------------------------------------------------


async def test_pool_settings_permissions_and_defaults(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user)
    pool = s["pool"]
    assert pool["max_hours"] == 6 and pool["min_hours"] == 6 and pool["grace_minutes"] == 15
    assert pool["visibility"] == "all" and pool["log_channel_id"] is None
    assert pool["horizon_days"] == 14 and pool["can_manage"] and pool["can_operate"]
    # Members see it but cannot change or create pools.
    as_user(s["alice"])
    listed = (await client.get("/api/v1/reservation-pools")).json()
    assert [p["id"] for p in listed] == [s["pid"]]
    assert listed[0]["can_manage"] is False and listed[0]["can_operate"] is False
    for call in (
        client.post("/api/v1/reservation-pools", json={"name": "x", "capacity": 1}),
        client.patch(f"/api/v1/reservation-pools/{s['pid']}", json={"capacity": 3}),
        client.delete(f"/api/v1/reservation-pools/{s['pid']}"),
    ):
        refused = await call
        assert refused.status_code == 403, refused.text
        assert refused.json()["error"]["code"] == "reservation_manage_restricted"
    # Guests see nothing; bad operators are refused.
    guest = await make_user(db, "visitor", role="guest")
    as_user(guest)
    assert (await client.get("/api/v1/reservation-pools")).json() == []
    as_user(s["admin"])
    bad = await client.patch(
        f"/api/v1/reservation-pools/{s['pid']}", json={"operator_ids": [str(guest.id)]}
    )
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "reservation_operator_invalid"
    changed = await client.patch(
        f"/api/v1/reservation-pools/{s['pid']}", json={"max_hours": 3, "capacity": 1}
    )
    assert changed.status_code == 200 and changed.json()["max_hours"] == 3
    # The channel endpoint of M99 answers nothing (the old clients show no chips).
    assert (await client.get(f"/api/v1/channels/{uuid.uuid4()}/reservation-pools")).json() == []


async def test_visibility_by_group_and_channel(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user)
    group = UserGroup(name="m1", created_by=s["admin"].id)
    db.add(group)
    await db.flush()
    db.add(UserGroupMember(group_id=group.id, user_id=s["alice"].id))
    await db.commit()
    as_user(s["admin"])
    narrowed = await client.patch(
        f"/api/v1/reservation-pools/{s['pid']}",
        json={"visibility": "group", "visibility_group_id": str(group.id)},
    )
    assert narrowed.status_code == 200, narrowed.text
    as_user(s["alice"])
    assert len((await client.get("/api/v1/reservation-pools")).json()) == 1
    as_user(s["bob"])
    assert (await client.get("/api/v1/reservation-pools")).json() == []
    hidden = await client.post(f"/api/v1/reservation-pools/{s['pid']}/reserve")
    assert hidden.status_code == 404
    as_user(s["op"])  # operators always see it
    assert len((await client.get("/api/v1/reservation-pools")).json()) == 1
    # A channel's members.
    as_user(s["admin"])
    created = await client.post("/api/v1/channels", json={"name": "lab", "type": "private"})
    cid = created.json()["id"]
    await client.post(f"/api/v1/channels/{cid}/members", json={"user_id": str(s["bob"].id)})
    by_channel = await client.patch(
        f"/api/v1/reservation-pools/{s['pid']}",
        json={"visibility": "channel", "visibility_channel_id": cid},
    )
    assert by_channel.json()["visibility_group_id"] is None
    as_user(s["bob"])
    assert len((await client.get("/api/v1/reservation-pools")).json()) == 1
    as_user(s["alice"])
    assert (await client.get("/api/v1/reservation-pools")).json() == []
    as_user(s["admin"])
    missing = await client.patch(
        f"/api/v1/reservation-pools/{s['pid']}", json={"visibility": "group"}
    )
    assert missing.status_code == 400


# --- bookings -----------------------------------------------------------------------------------


async def test_booking_rules_capacity_and_limits(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user)
    pid = s["pid"]
    as_user(s["alice"])
    made = await _book(client, pid, _hour(2), 3)
    assert made.status_code == 200, made.text
    mine = _mine(made.json(), s["alice"])
    assert len(mine) == 1 and mine[0]["status"] == "booked" and mine[0]["kind"] == "booking"
    assert mine[0]["email"] is None and mine[0]["can_extend"] is True
    # A retry of the same slot changes nothing; an overlapping one of mine is refused.
    again = await _book(client, pid, _hour(2), 3)
    assert again.status_code == 200 and len(_mine(again.json(), s["alice"])) == 1
    overlap = await _book(client, pid, _hour(4), 1)
    assert overlap.json()["error"]["code"] == "reservation_overlap"
    assert (await _book(client, pid, _hour(8), 1)).status_code == 200
    third = await _book(client, pid, _hour(10), 1)
    assert third.status_code == 409 and third.json()["error"]["code"] == "too_many_bookings"
    # The grid, the past, the horizon and the duration.
    for start, hours, reason in (
        (_hour(12) + timedelta(minutes=30), 1, "grid"),
        (_hour(-1), 1, "past"),
        (_hour(24 * 16), 1, "horizon"),
        (_hour(12), 7, "duration"),
    ):
        as_user(s["carol"])
        bad = await _book(client, pid, start, hours)
        assert bad.status_code == 400, (reason, bad.text)
        assert bad.json()["error"]["details"]["reason"] == reason
    # The current hour is fine; two seats: Bob fits next to Alice, Carol does not.
    as_user(s["bob"])
    assert (await _book(client, pid, _hour(0), 4)).status_code == 200
    as_user(s["carol"])
    full = await _book(client, pid, _hour(3), 2)
    assert full.status_code == 409 and full.json()["error"]["code"] == "reservation_slot_full"
    assert datetime.fromisoformat(full.json()["error"]["details"]["at"]) == _hour(3)
    assert (await _book(client, pid, _hour(5), 2)).status_code == 200
    # Bob cannot grow into 14:00 (Alice and Carol), Alice can grow by one (5 → max 6).
    as_user(s["bob"])
    pool = (await client.get(f"/api/v1/reservation-pools/{pid}")).json()
    bob_row = _mine(pool, s["bob"])[0]
    assert bob_row["can_extend"] is True  # 4h → 5h: 4:00-5:00 has Alice only
    as_user(s["alice"])
    first = next(
        b for b in _mine(pool, s["alice"]) if datetime.fromisoformat(b["start_at"]) == _hour(2)
    )
    grown = await client.post(f"/api/v1/reservations/{first['id']}/extend", json={})
    assert grown.status_code == 200, grown.text
    row = next(b for b in _mine(grown.json(), s["alice"]) if b["id"] == first["id"])
    assert datetime.fromisoformat(row["end_at"]) == _hour(6)
    as_user(s["bob"])
    blocked = await client.post(f"/api/v1/reservations/{bob_row['id']}/extend", json={"hours": 2})
    assert blocked.json()["error"]["code"] == "reservation_slot_full"
    # Cancel frees the hours.
    cancelled = await client.post(f"/api/v1/reservations/{bob_row['id']}/cancel")
    assert cancelled.status_code == 200 and _mine(cancelled.json(), s["bob"]) == []
    assert (await client.post(f"/api/v1/reservations/{bob_row['id']}/cancel")).status_code == 200
    # Nothing was posted anywhere (no log channel), no bot was made.
    bots = await db.execute(select(User).where(User.bot_kind == "reservation"))
    assert bots.scalars().all() == []


async def test_two_members_book_the_last_seat_at_once(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user)
    as_user(s["admin"])
    await client.patch(f"/api/v1/reservation-pools/{s['pid']}", json={"capacity": 1})

    async def press(user: User) -> str:
        async with app.state.db.session_factory() as session:
            actor = await session.get(User, user.id)
            assert actor is not None
            try:
                await reservations.book(
                    session, actor, uuid.UUID(s["pid"]), BookingIn(start_at=_hour(3), hours=2)
                )
                return "ok"
            except AppError as exc:
                return exc.code

    results = await asyncio.gather(press(s["alice"]), press(s["bob"]))
    assert sorted(results) == ["ok", "reservation_slot_full"]
    count = await db.execute(
        select(Reservation).where(
            Reservation.pool_id == uuid.UUID(s["pid"]), Reservation.status == "booked"
        )
    )
    assert len(count.scalars().all()) == 1


# --- operators: to-dos as activity items --------------------------------------------------------


async def test_walkin_queue_todo_is_shared_and_done_for_everyone(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user)
    pid = s["pid"]
    as_user(s["alice"])
    pool = (await client.post(f"/api/v1/reservation-pools/{pid}/reserve")).json()
    rid = pool["my_reservation_id"]
    assert pool["waiting"][0]["step"] == "assign" and pool["waiting"][0]["until"] is None
    # Both operators get one to-do (an activity item and a push event); Alice nothing yet.
    for op in (s["op"], s["op2"]):
        items = await _notices(db, op)
        assert len(items) == 1 and items[0].key == f"assign:{rid}" and items[0].done_at is None
        assert items[0].text.startswith("🙋 Alice さん (alice@example.jp) に「Claude Premium")
    assert await _notices(db, s["alice"]) == []
    pushes = await db.execute(
        select(OutboxEvent).where(OutboxEvent.event_type == "reservation.notice")
    )
    assert {e.audience_id for e in pushes.scalars().all()} == {s["op"].id, s["op2"].id}
    # The operator's page lists it as a to-do with the address.
    as_user(s["op"])
    pool = (await client.get(f"/api/v1/reservation-pools/{pid}")).json()
    assert [(t["action"], t["assign_id"]) for t in pool["todos"]] == [("assign", rid)]
    assert pool["waiting"][0]["email"] == "alice@example.jp"
    feed = (await client.get("/api/v1/activity", params=INCLUDE)).json()["items"]
    assert feed[0]["kind"] == "reservation" and feed[0]["reservation"]["operator"] is True
    assert feed[0]["reservation"]["pool_name"] == "Claude Premium シート"
    summary = (await client.get("/api/v1/activity/summary", params=INCLUDE)).json()
    assert summary["unread_count"] == 1 and summary["mention_unread"] is True
    # Old clients (no include) never see the kind.
    plain = (await client.get("/api/v1/activity")).json()["items"]
    assert all(i["kind"] != "reservation" for i in plain)
    # A member cannot assign; op assigns: op2's copy is done, the badge goes, Alice hears.
    as_user(s["bob"])
    refused = await client.post(f"/api/v1/reservations/{rid}/assign")
    assert refused.json()["error"]["code"] == "reservation_operator_required"
    as_user(s["op"])
    done = await client.post(f"/api/v1/reservations/{rid}/assign")
    assert done.status_code == 200 and done.json()["todos"] == []
    holder = done.json()["holders"][0]
    assert datetime.fromisoformat(holder["guarantee_until"]) - datetime.fromisoformat(
        holder["assigned_at"]
    ) == timedelta(hours=6)
    other = (await _notices(db, s["op2"]))[0]
    assert other.done_at is not None and other.done_by == s["op"].id
    updated = await db.execute(
        select(OutboxEvent).where(
            OutboxEvent.event_type == "activity.updated", OutboxEvent.audience_id == s["op2"].id
        )
    )
    assert updated.scalars().first() is not None
    as_user(s["op2"])
    summary = (await client.get("/api/v1/activity/summary", params=INCLUDE)).json()
    assert summary["unread_count"] == 0
    feed = (await client.get("/api/v1/activity", params=INCLUDE)).json()["items"]
    assert feed[0]["reservation"]["done"] is True
    assert feed[0]["reservation"]["done_by"] == str(s["op"].id)
    assigned = await _notices(db, s["alice"])
    assert [n.key for n in assigned] == [f"{rid}/assigned"]
    assert assigned[0].text.startswith("✅ 「Claude Premium シート」が割り当てられました。")
    # Twice is once.
    as_user(s["op"])
    assert (await client.post(f"/api/v1/reservations/{rid}/assign")).status_code == 200
    # Return → a remove to-do; 外した → done for all, Alice told it is over.
    as_user(s["alice"])
    back = await client.post(f"/api/v1/reservations/{rid}/return")
    assert back.json()["holders"][0]["status"] == "returning"
    assert [n.key for n in await _notices(db, s["op2"])][-1] == f"remove:{rid}"
    as_user(s["op2"])
    gone = await client.post(f"/api/v1/reservations/{rid}/remove")
    assert gone.json()["holders"] == [] and gone.json()["todos"] == []
    assert all(n.done_at is not None for n in await _notices(db, s["op"]))
    assert (await _notices(db, s["alice"]))[-1].text.startswith("⏹ 「Claude Premium シート」の返却")


async def test_booking_start_end_and_the_walkin_it_replaces(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user, capacity=1)
    pid = s["pid"]
    # Alice books 2 hours from the hour after next (well past the 10 minutes); Bob walks in now.
    as_user(s["alice"])
    pool = (await _book(client, pid, _hour(2), 2)).json()
    bid = _mine(pool, s["alice"])[0]["id"]
    as_user(s["bob"])
    pool = (await client.post(f"/api/v1/reservation-pools/{pid}/reserve")).json()
    walk = pool["my_reservation_id"]
    waiting = pool["waiting"][0]
    assert waiting["step"] == "assign"
    assert datetime.fromisoformat(waiting["until"]) == _hour(2)  # 「〜HH:00 まで」
    as_user(s["op"])
    pool = (await client.post(f"/api/v1/reservations/{walk}/assign")).json()
    assert datetime.fromisoformat(pool["holders"][0]["guarantee_until"]) == _hour(2)
    # Another booking cannot take the walk-in's guaranteed time... but after it, it can.
    as_user(s["carol"])
    taken = await _book(client, pid, _hour(0), 1)
    assert taken.json()["error"]["code"] == "reservation_slot_full"
    # Ten minutes before the booking: the operators hear once, Bob is told when he goes.
    start = _hour(2)
    assert await _tick(app, start - timedelta(minutes=11)) == 0
    assert await _tick(app, start - timedelta(minutes=10)) == 1
    assert await _tick(app, start - timedelta(minutes=9)) == 0
    keys = [n.key for n in await _notices(db, s["op"])]
    assert f"booking:{bid}" in keys
    told = next(n for n in await _notices(db, s["op"]) if n.key == f"booking:{bid}")
    assert "Bob さん (bob@example.jp) を外して割り当ててください" in told.text
    bob_notice = (await _notices(db, s["bob"]))[-1]
    assert "予約の人が使います" in bob_notice.text
    # At the start: no second notice (the page shows the swap to-do).
    before = len(await _notices(db, s["op"]))
    await _tick(app, start + timedelta(minutes=1))
    assert len(await _notices(db, s["op"])) == before
    # Make it now: the booking started half an hour ago; the operator swaps.
    now = utcnow()
    await db.execute(
        update(Reservation)
        .where(Reservation.id == uuid.UUID(bid))
        .values(start_at=now - timedelta(minutes=30), end_at=now + timedelta(minutes=90))
    )
    await db.execute(
        update(Reservation)
        .where(Reservation.id == uuid.UUID(walk))
        .values(guarantee_until=now - timedelta(minutes=30), evict_at=now - timedelta(minutes=30))
    )
    await db.commit()
    as_user(s["op2"])
    pool = (await client.get(f"/api/v1/reservation-pools/{pid}")).json()
    assert [(t["action"], t["remove_id"], t["assign_id"]) for t in pool["todos"]] == [
        ("swap", walk, bid)
    ]
    swapped = await client.post(
        f"/api/v1/reservation-pools/{pid}/swap", json={"remove_id": walk, "assign_id": bid}
    )
    assert swapped.status_code == 200, swapped.text
    holder = swapped.json()["holders"][0]
    assert holder["id"] == bid and holder["guarantee_until"] == holder["end_at"]
    assert all(n.done_at is not None for n in await _notices(db, s["op"]) if n.operator)
    # At the booking's end: a remove to-do for the operators (once).
    await db.execute(
        update(Reservation)
        .where(Reservation.id == uuid.UUID(bid))
        .values(end_at=utcnow() - timedelta(minutes=1))
    )
    await db.commit()
    assert await _tick(app) == 1
    ended = [n for n in await _notices(db, s["op"]) if n.key == f"remove:{bid}"]
    assert len(ended) == 1 and "予約時間" in ended[0].text
    assert await _tick(app) == 0


async def test_unassigned_booking_expires_and_too_early_assign(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user)
    as_user(s["alice"])
    pool = (await _book(client, s["pid"], _hour(3), 1)).json()
    bid = _mine(pool, s["alice"])[0]["id"]
    as_user(s["op"])
    early = await client.post(f"/api/v1/reservations/{bid}/assign")
    assert early.json()["error"]["code"] == "reservation_too_early"
    assert await _tick(app, _hour(4) + timedelta(minutes=1)) == 1
    row = await db.get(Reservation, uuid.UUID(bid))
    await db.refresh(row)
    assert row is not None and row.status == "done" and row.end_reason == "expired"
    assert (await _notices(db, s["alice"]))[-1].key == f"{bid}/expired"
    assert all(n.done_at is not None for n in await _notices(db, s["op"]))


async def test_waiting_walkin_grace_then_swap(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user, capacity=1)
    pid = s["pid"]
    as_user(s["alice"])
    first = (await client.post(f"/api/v1/reservation-pools/{pid}/reserve")).json()
    rid = first["my_reservation_id"]
    as_user(s["op"])
    await client.post(f"/api/v1/reservations/{rid}/assign")
    as_user(s["bob"])
    second = (await client.post(f"/api/v1/reservation-pools/{pid}/reserve")).json()
    wid = second["my_reservation_id"]
    assert second["waiting"][0]["step"] == "wait" and second["next_evict_id"] == rid
    assert await _tick(app) == 0
    now = utcnow()
    await db.execute(
        update(Reservation)
        .where(Reservation.id == uuid.UUID(rid))
        .values(guarantee_until=now - timedelta(hours=1))
    )
    await db.commit()
    assert await _tick(app, now) == 1
    assert "以降に担当者が外します" in (await _notices(db, s["alice"]))[-1].text
    assert not any(n.key.startswith("swap:") for n in await _notices(db, s["op"]))
    assert await _tick(app, now + timedelta(minutes=16)) == 1
    swap_items = [n for n in await _notices(db, s["op"]) if n.key == f"swap:{rid}:{wid}"]
    assert len(swap_items) == 1 and "保証時間が終了" in swap_items[0].text
    # Bob gives up: the swap to-do is done and Alice keeps the seat (told so).
    as_user(s["bob"])
    await client.post(f"/api/v1/reservations/{wid}/cancel")
    assert all(n.done_at is not None for n in await _notices(db, s["op"]) if n.operator)
    assert "そのまま使えます" in (await _notices(db, s["alice"]))[-1].text


async def test_log_channel_lines_only_when_set(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user)
    as_user(s["admin"])
    cid = (await client.post("/api/v1/channels", json={"name": "claude"})).json()["id"]
    pool = await client.patch(f"/api/v1/reservation-pools/{s['pid']}", json={"log_channel_id": cid})
    assert pool.status_code == 200 and pool.json()["log_channel_id"] == cid
    as_user(s["alice"])
    await _book(client, s["pid"], _hour(2), 2)
    lines = await db.execute(
        select(Message.body).where(Message.channel_id == uuid.UUID(cid), Message.type == "user")
    )
    bodies = list(lines.scalars().all())
    assert len(bodies) == 1 and bodies[0].startswith("🗓 Alice さんが「Claude Premium シート」")
    as_user(s["admin"])
    await client.patch(f"/api/v1/reservation-pools/{s['pid']}", json={"log_channel_id": None})
    as_user(s["bob"])
    await client.post(f"/api/v1/reservation-pools/{s['pid']}/reserve")
    lines = await db.execute(
        select(Message.body).where(Message.channel_id == uuid.UUID(cid), Message.type == "user")
    )
    assert len(lines.scalars().all()) == 1


async def test_deleting_a_pool_takes_its_notices(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user)
    as_user(s["alice"])
    await client.post(f"/api/v1/reservation-pools/{s['pid']}/reserve")
    assert len(await _notices(db, s["op"])) == 1
    as_user(s["admin"])
    assert (await client.delete(f"/api/v1/reservation-pools/{s['pid']}")).status_code == 204
    assert await _notices(db, s["op"]) == []
    as_user(s["op"])
    assert (await client.get("/api/v1/activity", params=INCLUDE)).json()["items"] == []


async def test_push_for_notices_skips_done_and_active(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    s = await _setup(client, db, as_user)
    await add_device(db, s["op"])
    await add_device(db, s["op2"], "tok2")
    await add_device(db, s["bob"], "tok3")
    as_user(s["alice"])
    await client.post(f"/api/v1/reservation-pools/{s['pid']}/reserve")
    # op2 is at the desktop (the open app shows it); op gets the push.
    relay = relay_with_planner(app, test_settings, active={s["op2"].id})
    while await relay.process_batch():
        pass
    pushes = [d for d in await deliveries(db) if d.payload.get("kind") == "reservation"]
    assert len(pushes) == 1 and pushes[0].payload["pool_id"] == s["pid"]
    assert pushes[0].payload["title"] == "予約"
    assert pushes[0].payload["body"].startswith("🙋 Alice さん")
    # A to-do another operator handled before its push was planned is not pushed.
    as_user(s["bob"])
    await client.post(f"/api/v1/reservation-pools/{s['pid']}/reserve")
    as_user(s["op2"])
    pool = (await client.get(f"/api/v1/reservation-pools/{s['pid']}")).json()
    bob_row = next(w for w in pool["waiting"] if w["user_id"] == str(s["bob"].id))
    await client.post(f"/api/v1/reservations/{bob_row['id']}/assign")
    relay = relay_with_planner(app, test_settings)
    while await relay.process_batch():
        pass
    later = [d for d in await deliveries(db) if d.payload.get("kind") == "reservation"][1:]
    # only Bob's 「割り当てられました」 (op's Bob to-do was done before the relay ran)
    assert [d.payload["body"][:3] for d in later] == ["✅ 「"]
