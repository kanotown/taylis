"""2026-10-24 (docs/RESERVATIONS.md §1): a pool's `walkins_enabled` — whether it takes 「今すぐ」
(walk-ins, the queue) besides bookings. New pools are booking-only; the pools from before
migration 0120 keep the queue. Turning it off cancels the queue (each person told once) and keeps
those on a seat until they return or an operator removes them."""

import os
import uuid
from collections.abc import Callable
from datetime import timedelta

from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.modules.audit.models import AuditLog
from app.modules.messages.models import Message
from app.modules.reservations import repository as reservations_repo
from app.modules.reservations import service as reservations
from app.modules.reservations.models import Reservation, ReservationPool
from app.modules.users.models import User
from tests.conftest import SERVER_DIR, _run_in_thread
from tests.helpers import make_user
from tests.test_reservations import _book, _hour, _notices, _setup, _tick, _walkin_holding

OFF_TEXT = (
    "↩️ 「Claude Premium シート」は「今すぐ」を受け付けなくなったため、順番待ちを取り消しました。"
)


async def _queue(client: AsyncClient, pid: str) -> str:
    out = await client.post(f"/api/v1/reservation-pools/{pid}/reserve")
    assert out.status_code == 200, out.text
    return str(out.json()["my_reservation_id"])


async def _row(db: AsyncSession, rid: str) -> Reservation:
    return (
        await db.execute(
            select(Reservation)
            .where(Reservation.id == uuid.UUID(rid))
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


async def test_a_new_pool_is_booking_only_by_default(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user)
    assert s["pool"]["walkins_enabled"] is True  # (_setup turns it on)
    as_user(s["admin"])
    made = await client.post("/api/v1/reservation-pools", json={"name": "GPU", "capacity": 1})
    assert made.status_code == 201 and made.json()["walkins_enabled"] is False
    pid = made.json()["id"]
    as_user(s["alice"])
    refused = await client.post(f"/api/v1/reservation-pools/{pid}/reserve")
    assert refused.status_code == 409, refused.text
    assert refused.json()["error"]["code"] == "reservation_walkins_disabled"
    # Booking works as ever.
    booked = await _book(client, pid, _hour(2), 1)
    assert booked.status_code == 200 and booked.json()["my_active_id"] is not None
    assert booked.json()["waiting"] == []


async def test_patch_round_trip_and_who_may_change_it(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user, walkins_enabled=False)
    pid = s["pid"]
    assert s["pool"]["walkins_enabled"] is False
    # Members and operators may not change it.
    for who in (s["alice"], s["op"]):
        as_user(who)
        refused = await client.patch(
            f"/api/v1/reservation-pools/{pid}", json={"walkins_enabled": True}
        )
        assert refused.status_code == 403, refused.text
        assert refused.json()["error"]["code"] == "reservation_manage_restricted"
    # An administrator turns it on; GET agrees; an unrelated PATCH keeps it.
    as_user(s["admin"])
    on = await client.patch(f"/api/v1/reservation-pools/{pid}", json={"walkins_enabled": True})
    assert on.status_code == 200 and on.json()["walkins_enabled"] is True
    assert (await client.get(f"/api/v1/reservation-pools/{pid}")).json()["walkins_enabled"]
    kept = await client.patch(f"/api/v1/reservation-pools/{pid}", json={"capacity": 3})
    assert kept.json()["walkins_enabled"] is True
    # The pool's creator (not an administrator) may change it too.
    await db.execute(
        update(ReservationPool)
        .where(ReservationPool.id == uuid.UUID(pid))
        .values(created_by=s["carol"].id)
    )
    await db.commit()
    as_user(s["carol"])
    off = await client.patch(f"/api/v1/reservation-pools/{pid}", json={"walkins_enabled": False})
    assert off.status_code == 200 and off.json()["walkins_enabled"] is False
    audits = (
        await db.execute(
            select(AuditLog).where(
                AuditLog.action == "reservation_pool.updated",
                AuditLog.target_id == pid,
            )
        )
    ).scalars()
    changes = [a.details for a in audits if "walkins_enabled" in (a.details or {})]
    assert [c["walkins_enabled"]["to"] for c in changes] == [True, False]


async def test_turning_it_off_cancels_the_queue_once_and_keeps_the_holders(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user, capacity=1)
    s["as_user"] = as_user
    pid = s["pid"]
    as_user(s["admin"])
    cid = (await client.post("/api/v1/channels", json={"name": "claude"})).json()["id"]
    await client.patch(f"/api/v1/reservation-pools/{pid}", json={"log_channel_id": cid})
    alice = await _walkin_holding(client, s, "alice")
    as_user(s["bob"])
    bob = await _queue(client, pid)
    as_user(s["carol"])
    carol = await _queue(client, pid)

    as_user(s["admin"])
    off = await client.patch(f"/api/v1/reservation-pools/{pid}", json={"walkins_enabled": False})
    assert off.status_code == 200, off.text
    out = off.json()
    assert out["walkins_enabled"] is False and out["waiting"] == []
    assert [h["id"] for h in out["holders"]] == [alice]  # Alice keeps her seat
    assert out["todos"] == []  # inside her guarantee: nothing to do
    for rid in (bob, carol):
        row = await _row(db, rid)
        assert (row.status, row.end_reason, row.ended_by) == (
            "cancelled",
            "cancelled",
            s["admin"].id,
        )
    for who, rid in ((s["bob"], bob), (s["carol"], carol)):
        told = [n for n in await _notices(db, who) if n.key == f"{rid}/walkins_off"]
        assert len(told) == 1 and told[0].text.startswith(OFF_TEXT), told
        assert told[0].text.endswith("予約を使ってください。")
    # Alice hears nothing about it.
    assert not any("walkins_off" in n.key for n in await _notices(db, s["alice"]))
    # One log line; the audit names the cancelled requests.
    bodies = list(
        (
            await db.execute(
                select(Message.body)
                .where(Message.channel_id == uuid.UUID(cid), Message.type == "user")
                .order_by(Message.seq)
            )
        ).scalars()
    )
    stopped = [b for b in bodies if b.startswith("⏸ ")]
    assert stopped == [
        "⏸ Boss さんが「Claude Premium シート」の「今すぐ」（順番待ち）を止めました"
        "（順番待ちの 2 人を取り消し）"
    ], bodies
    audit = (
        (
            await db.execute(
                select(AuditLog)
                .where(AuditLog.action == "reservation_pool.updated")
                .order_by(AuditLog.at.desc())
            )
        )
        .scalars()
        .first()
    )
    assert audit is not None and sorted(audit.details["cancelled_waiting"]) == sorted([bob, carol])
    # The operators' to-dos about the queue are done.
    for op in (s["op"], s["op2"]):
        assert all(n.done_at is not None for n in await _notices(db, op))

    # Nothing more on a tick or a second PATCH; the queue stays closed.
    counts = [len(await _notices(db, u)) for u in (s["bob"], s["carol"], s["op"], s["alice"])]
    assert await _tick(app) == 0
    again = await client.patch(f"/api/v1/reservation-pools/{pid}", json={"walkins_enabled": False})
    assert again.status_code == 200
    after = [len(await _notices(db, u)) for u in (s["bob"], s["carol"], s["op"], s["alice"])]
    assert after == counts
    as_user(s["bob"])
    refused = await client.post(f"/api/v1/reservation-pools/{pid}/reserve")
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "reservation_walkins_disabled"

    # Past her guarantee, Alice still gets the remove to-do (so the operators can reclaim it).
    now = utcnow()
    await db.execute(
        update(Reservation)
        .where(Reservation.id == uuid.UUID(alice))
        .values(guarantee_until=now - timedelta(minutes=1))
    )
    await db.commit()
    assert await _tick(app, now) == 1
    as_user(s["op"])
    pool = (await client.get(f"/api/v1/reservation-pools/{pid}")).json()
    assert [(t["action"], t["reason"], t["remove_id"]) for t in pool["todos"]] == [
        ("remove", "guarantee_over", alice)
    ]
    removed = await client.post(f"/api/v1/reservations/{alice}/remove")
    assert removed.status_code == 200 and removed.json()["holders"] == []

    # On again: the queue works as before (a line in the log channel too).
    as_user(s["admin"])
    on = await client.patch(f"/api/v1/reservation-pools/{pid}", json={"walkins_enabled": True})
    assert on.json()["walkins_enabled"] is True
    as_user(s["bob"])
    queued = await client.post(f"/api/v1/reservation-pools/{pid}/reserve")
    assert queued.status_code == 200 and len(queued.json()["waiting"]) == 1
    bodies = list(
        (
            await db.execute(
                select(Message.body).where(
                    Message.channel_id == uuid.UUID(cid), Message.type == "user"
                )
            )
        ).scalars()
    )
    assert any(b.startswith("▶️ Boss さんが「Claude Premium シート」の「今すぐ」") for b in bodies)


async def test_the_plan_ignores_a_queue_in_a_booking_only_pool(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """A waiting row that reached a booking-only pool anyway: no assignment for it, and the
    worker cancels it (telling the person once)."""
    s = await _setup(client, db, as_user, walkins_enabled=False)
    pid = uuid.UUID(s["pid"])
    stray = Reservation(
        pool_id=pid,
        user_id=s["alice"].id,
        kind="walkin",
        status="waiting",
        requested_at=utcnow(),
    )
    db.add(stray)
    await db.commit()
    pool = await reservations_repo.get_pool(db, pid)
    assert pool is not None
    plan = reservations._plan(pool, await reservations_repo.active_rows(db, [pid]), utcnow())
    assert plan.todos == [] and plan.steps == {}
    assert await _tick(app) == 1
    row = await _row(db, str(stray.id))
    assert (row.status, row.end_reason, row.ended_by) == ("cancelled", "cancelled", None)
    told = [n for n in await _notices(db, s["alice"]) if n.key == f"{stray.id}/walkins_off"]
    assert len(told) == 1
    assert await _tick(app) == 0
    for op in (s["op"], s["op2"]):
        assert not any(n.key.startswith("assign:") for n in await _notices(db, op))


async def test_migration_keeps_walkins_for_existing_pools(
    app: FastAPI, db: AsyncSession, migrated_database: str
) -> None:
    """0120: pools made before it keep the queue (true); a row inserted afterwards without the
    column is booking-only (false)."""
    boss = await make_user(db, "boss", role="admin")
    await db.commit()
    await db.close()
    cfg = Config(str(SERVER_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(SERVER_DIR / "migrations"))
    os.environ["DATABASE_URL"] = migrated_database
    old, new = uuid.uuid4(), uuid.uuid4()
    insert = text(
        "INSERT INTO reservation_pools (id, name, capacity, min_hours, grace_minutes, tz, "
        "created_by) VALUES (:id, 'Seat', 1, 6, 15, 'Asia/Tokyo', :by)"
    )
    try:
        _run_in_thread(lambda: command.downgrade(cfg, "0119"))
        async with app.state.db.engine.begin() as conn:
            await conn.execute(insert, {"id": old, "by": boss.id})
    finally:
        _run_in_thread(lambda: command.upgrade(cfg, "head"))
    await app.state.db.engine.dispose()  # (cached statements from before the column)
    async with app.state.db.engine.begin() as conn:
        await conn.execute(insert, {"id": new, "by": boss.id})
        rows = await conn.execute(
            text("SELECT id, walkins_enabled FROM reservation_pools WHERE id IN (:a, :b)"),
            {"a": old, "b": new},
        )
        found = {r.id: r.walkins_enabled for r in rows}
        await conn.execute(
            text("DELETE FROM reservation_pools WHERE id IN (:a, :b)"), {"a": old, "b": new}
        )
    assert found == {old: True, new: False}
