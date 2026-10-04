"""M99 (docs/RESERVATIONS.md): a channel's shared seats with a queue."""

import asyncio
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.channels.models import ChannelMember
from app.modules.messages.models import Message
from app.modules.reservations import service as reservations
from app.modules.reservations.models import Reservation
from app.modules.reservations.plan import Seat, Waiter, make_plan
from app.modules.users.models import User
from tests.helpers import make_user

T0 = datetime(2026, 10, 4, 9, 0, tzinfo=UTC)


def _id(n: int) -> uuid.UUID:
    return uuid.UUID(int=n)


# --- the plan (pure) ------------------------------------------------------------------------------


def test_plan_free_seats_then_returns_then_earliest_guarantee_end() -> None:
    seats = [
        Seat(_id(1), "holding", T0 + timedelta(hours=1)),  # not past yet
        Seat(_id(2), "holding", T0 - timedelta(hours=1)),  # past, ended later
        Seat(_id(3), "holding", T0 - timedelta(hours=3)),  # past, ended first
        Seat(_id(4), "returning", T0, T0 - timedelta(minutes=5)),
    ]
    waiters = [Waiter(_id(10 + i), T0 - timedelta(minutes=30 - i)) for i in range(5)]
    plan = make_plan(5, seats, waiters, T0)
    # one free seat, then the return, then the past holders, earliest guarantee end first
    assert plan.steps == {
        _id(10): "assign",
        _id(11): "swap",
        _id(12): "swap",
        _id(13): "swap",
        _id(14): "wait",
    }
    assert plan.waiter_pair == {_id(11): _id(4), _id(12): _id(3), _id(13): _id(2)}
    assert plan.evict_ids == [_id(3), _id(2)]
    assert plan.next_evict_id == _id(3)


def test_plan_nobody_past_shows_the_first_to_end_and_no_eviction() -> None:
    seats = [
        Seat(_id(1), "holding", T0 + timedelta(hours=5)),
        Seat(_id(2), "holding", T0 + timedelta(hours=2)),
    ]
    plan = make_plan(2, seats, [Waiter(_id(9), T0)], T0)
    assert plan.steps == {_id(9): "wait"} and plan.evict_ids == []
    assert plan.next_evict_id == _id(2)
    # nobody waits: nobody goes
    assert make_plan(2, seats, [], T0 + timedelta(days=1)).next_evict_id is None
    # one waiter, two past: only the earliest is needed
    later = make_plan(2, seats, [Waiter(_id(9), T0)], T0 + timedelta(days=1))
    assert later.evict_ids == [_id(2)] and later.holder_pair == {_id(2): _id(9)}


# --- helpers -------------------------------------------------------------------------------------


async def _channel(client: AsyncClient, name: str, members: list[User], **extra: Any) -> str:
    created = await client.post("/api/v1/channels", json={"name": name, **extra})
    assert created.status_code == 201, created.text
    cid = str(created.json()["id"])
    for user in members:
        added = await client.post(f"/api/v1/channels/{cid}/members", json={"user_id": str(user.id)})
        assert added.status_code == 200, added.text
    return cid


async def _posts(db: AsyncSession, cid: str, bot_id: str) -> list[str]:
    rows = await db.execute(
        select(Message.body)
        .where(Message.channel_id == uuid.UUID(cid), Message.sender_id == uuid.UUID(bot_id))
        .order_by(Message.seq)
    )
    return list(rows.scalars().all())


async def _dms(db: AsyncSession, bot_id: str, user: User, cid: str) -> list[str]:
    """What the bot sent the person in their DM."""
    mine = select(ChannelMember.channel_id).where(ChannelMember.user_id == user.id)
    rows = await db.execute(
        select(Message.body)
        .where(
            Message.sender_id == uuid.UUID(bot_id),
            Message.channel_id != uuid.UUID(cid),
            Message.channel_id.in_(mine),
        )
        .order_by(Message.created_at, Message.seq)
    )
    return list(rows.scalars().all())


async def _shift(db: AsyncSession, rid: str, **values: Any) -> None:
    await db.execute(update(Reservation).where(Reservation.id == uuid.UUID(rid)).values(**values))
    await db.commit()


async def _tick(app: FastAPI, now: datetime | None = None) -> int:
    async with app.state.db.session_factory() as session:
        return await reservations.tick(session, now=now)


async def _setup(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], *, capacity: int = 2
) -> dict[str, Any]:
    owner = await make_user(db, "owner")
    op = await make_user(db, "op")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    alice.email = "alice@example.jp"
    carol.email = "carol@example.jp"
    await db.commit()
    as_user(owner)
    cid = await _channel(client, "claude", [op, alice, bob, carol])
    made = await client.post(
        f"/api/v1/channels/{cid}/reservation-pools",
        json={
            "name": "Claude Premium シート",
            "capacity": capacity,
            "operator_ids": [str(op.id)],
            "tz": "Asia/Tokyo",
        },
    )
    assert made.status_code == 201, made.text
    pool = made.json()
    return {
        "cid": cid,
        "pool": pool,
        "pid": pool["id"],
        "bot": pool["bot_user_id"],
        "owner": owner,
        "op": op,
        "alice": alice,
        "bob": bob,
        "carol": carol,
    }


# --- the flow ------------------------------------------------------------------------------------


async def test_queue_assign_guarantee_grace_and_swap(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user)
    pid, cid, bot = s["pid"], s["cid"], s["bot"]
    assert s["pool"]["min_hours"] == 6 and s["pool"]["grace_minutes"] == 15
    assert s["pool"]["holders"] == [] and s["pool"]["can_manage"] and s["pool"]["can_operate"]
    bot_user = (await client.get(f"/api/v1/users/{bot}")).json()
    assert bot_user["display_name"] == "予約" and bot_user["bot_kind"] == "reservation"

    # Three members reserve: two seats free, the third waits.
    ids: dict[str, str] = {}
    for name in ("alice", "bob", "carol"):
        as_user(s[name])
        out = await client.post(f"/api/v1/reservation-pools/{pid}/reserve")
        assert out.status_code == 200, out.text
        ids[name] = out.json()["my_reservation_id"]
    pool = out.json()
    assert [w["step"] for w in pool["waiting"]] == ["assign", "assign", "wait"]
    assert [w["position"] for w in pool["waiting"]] == [1, 2, 3]
    assert all(w["email"] is None for w in pool["waiting"])  # a member sees no addresses
    assert pool["can_operate"] is False
    # Pressing again changes nothing.
    again = await client.post(f"/api/v1/reservation-pools/{pid}/reserve")
    assert again.status_code == 200 and len(again.json()["waiting"]) == 3

    posts = await _posts(db, cid, bot)
    assert posts == [
        "🙋 Alice さんが「Claude Premium シート」を予約しました",
        "🙋 Bob さんが「Claude Premium シート」を予約しました",
        "🙋 Carol さんが「Claude Premium シート」を予約しました (待ち 3 人目)",
    ]
    to_op = await _dms(db, bot, s["op"], cid)
    assert len(to_op) == 3
    assert to_op[0].startswith(
        "🙋 Alice さん (alice@example.jp) に「Claude Premium シート」(#claude)"
    )
    assert "割り当ててください" in to_op[0]
    assert to_op[2].startswith("🙋 Carol さん (carol@example.jp) が「Claude Premium シート」")
    assert "待ち 3 人目" in to_op[2]

    # A member cannot assign; the operator sees the addresses and assigns.
    as_user(s["bob"])
    refused = await client.post(f"/api/v1/reservations/{ids['alice']}/assign")
    assert refused.status_code == 403
    assert refused.json()["error"]["code"] == "reservation_operator_required"
    as_user(s["op"])
    listed = (await client.get(f"/api/v1/channels/{cid}/reservation-pools")).json()[0]
    assert listed["can_operate"] and listed["waiting"][0]["email"] == "alice@example.jp"
    for name in ("alice", "bob"):
        done = await client.post(f"/api/v1/reservations/{ids[name]}/assign")
        assert done.status_code == 200, done.text
    pool = done.json()
    assert [h["user_id"] for h in pool["holders"]] == [str(s["alice"].id), str(s["bob"].id)]
    holder = pool["holders"][0]
    assert holder["status"] == "holding"
    start = datetime.fromisoformat(holder["assigned_at"])
    assert datetime.fromisoformat(holder["guarantee_until"]) - start == timedelta(hours=6)
    assert pool["waiting"][0]["step"] == "wait"
    assert pool["next_evict_id"] == pool["holders"][0]["id"]  # the first guarantee to end
    # Twice is once; a full pool refuses another assignment.
    twice = await client.post(f"/api/v1/reservations/{ids['alice']}/assign")
    assert twice.status_code == 200 and len(twice.json()["holders"]) == 2
    full = await client.post(f"/api/v1/reservations/{ids['carol']}/assign")
    assert full.status_code == 409 and full.json()["error"]["code"] == "reservation_pool_full"
    assert (await _dms(db, bot, s["alice"], cid))[0].startswith(
        "✅ 「Claude Premium シート」(#claude) が割り当てられました。"
    )
    assert (await _posts(db, cid, bot))[-1].startswith(
        "✅ Bob さんに「Claude Premium シート」を割り当てました (保証 "
    )

    # Nothing happens before the guarantee ends.
    assert await _tick(app) == 0
    # Alice's guarantee ends first (both past): she gets the grace notice, once.
    now = utcnow()
    await _shift(db, ids["alice"], guarantee_until=now - timedelta(hours=2))
    await _shift(db, ids["bob"], guarantee_until=now - timedelta(hours=1))
    assert await _tick(app, now) == 1
    assert await _tick(app, now + timedelta(minutes=1)) == 0
    notice = (await _dms(db, bot, s["alice"], cid))[-1]
    assert notice.startswith("⏳ 「Claude Premium シート」(#claude) の保証時間")
    assert "以降に担当者が外します" in notice
    assert len(await _dms(db, bot, s["bob"], cid)) == 1  # (only the assignment)
    pool = (await client.get(f"/api/v1/channels/{cid}/reservation-pools")).json()[0]
    first = pool["holders"][0]
    assert first["evict_at"] is not None and first["ready"] is False
    assert first["pair_id"] == ids["carol"] and pool["next_evict_id"] == ids["alice"]
    assert pool["waiting"][0]["step"] == "swap" and pool["waiting"][0]["pair_id"] == ids["alice"]

    # After the grace: the operators are told they can swap (once).
    before = len(await _dms(db, bot, s["op"], cid))
    assert await _tick(app, now + timedelta(minutes=16)) == 1
    assert await _tick(app, now + timedelta(minutes=17)) == 0
    ready = await _dms(db, bot, s["op"], cid)
    assert len(ready) == before + 1
    assert ready[-1].startswith(
        "🔁 「Claude Premium シート」(#claude) を入れ替えできます: Alice さん (alice@example.jp)"
        " を外して Carol さん (carol@example.jp) に割り当て"
    )
    await _shift(db, ids["alice"], evict_at=now - timedelta(minutes=1))
    pool = (await client.get(f"/api/v1/channels/{cid}/reservation-pools")).json()[0]
    assert pool["holders"][0]["ready"] and pool["waiting"][0]["ready"]

    # 「入れ替えた」: Alice out, Carol in, one post; pressing again changes nothing.
    swapped = await client.post(
        f"/api/v1/reservation-pools/{pid}/swap",
        json={"remove_id": ids["alice"], "assign_id": ids["carol"]},
    )
    assert swapped.status_code == 200, swapped.text
    pool = swapped.json()
    assert {h["user_id"] for h in pool["holders"]} == {str(s["bob"].id), str(s["carol"].id)}
    assert pool["waiting"] == [] and pool["next_evict_id"] is None
    again = await client.post(
        f"/api/v1/reservation-pools/{pid}/swap",
        json={"remove_id": ids["alice"], "assign_id": ids["carol"]},
    )
    assert again.status_code == 200 and again.json()["holders"] == pool["holders"]
    assert (await _posts(db, cid, bot))[-1].startswith(
        "🔁 「Claude Premium シート」を Alice さんから Carol さんに入れ替えました (保証 "
    )
    assert (await _dms(db, bot, s["alice"], cid))[-1].startswith(
        "⏹ 「Claude Premium シート」(#claude) から外されました。"
    )
    assert "割り当てられました" in (await _dms(db, bot, s["carol"], cid))[-1]
    row = await db.get(Reservation, uuid.UUID(ids["alice"]), populate_existing=True)
    assert row is not None and row.status == "done" and row.end_reason == "removed"

    # Live updates: each change reached the channel as reservation.updated.
    events = (
        (
            await db.execute(
                select(OutboxEvent).where(OutboxEvent.event_type == "reservation.updated")
            )
        )
        .scalars()
        .all()
    )
    assert len(events) >= 9
    assert all(e.audience_type == "channel" and str(e.channel_id) == cid for e in events)
    assert events[-1].payload == {"channel_id": cid, "pool_id": pid, "deleted": False}


async def test_return_cancel_and_the_notice_withdrawn(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user, capacity=1)
    pid, cid, bot = s["pid"], s["cid"], s["bot"]
    ids: dict[str, str] = {}
    for name in ("alice", "bob"):
        as_user(s[name])
        ids[name] = (await client.post(f"/api/v1/reservation-pools/{pid}/reserve")).json()[
            "my_reservation_id"
        ]
    as_user(s["op"])
    assert (await client.post(f"/api/v1/reservations/{ids['alice']}/assign")).status_code == 200

    # Alice is past the guarantee and told; Bob gives up: Alice keeps the seat and is told so.
    now = utcnow()
    await _shift(db, ids["alice"], guarantee_until=now - timedelta(minutes=1))
    assert await _tick(app, now) == 1
    as_user(s["alice"])
    not_hers = await client.post(f"/api/v1/reservations/{ids['bob']}/cancel")
    assert not_hers.status_code == 403
    as_user(s["bob"])
    wrong = await client.post(f"/api/v1/reservations/{ids['alice']}/return")
    assert wrong.status_code == 403 and wrong.json()["error"]["code"] == "reservation_not_yours"
    cancelled = await client.post(f"/api/v1/reservations/{ids['bob']}/cancel")
    assert cancelled.status_code == 200 and cancelled.json()["waiting"] == []
    assert cancelled.json()["holders"][0]["evict_at"] is None
    assert (await client.post(f"/api/v1/reservations/{ids['bob']}/cancel")).status_code == 200
    kept = (await _dms(db, bot, s["alice"], cid))[-1]
    assert kept.startswith("👍 「Claude Premium シート」(#claude) を待つ人がいなくなったので")
    assert (await _posts(db, cid, bot))[-1] == (
        "↩️ Bob さんが「Claude Premium シート」の予約を取り消しました"
    )
    assert await _tick(app, now + timedelta(hours=1)) == 0  # nobody waits: nothing to do

    # A holding cannot be cancelled; Carol queues; Alice returns; the operator takes it out
    # (「外した」) and Carol can be assigned.
    as_user(s["alice"])
    no = await client.post(f"/api/v1/reservations/{ids['alice']}/cancel")
    assert no.status_code == 409 and no.json()["error"]["code"] == "reservation_state_conflict"
    as_user(s["carol"])
    carol_id = (await client.post(f"/api/v1/reservation-pools/{pid}/reserve")).json()[
        "my_reservation_id"
    ]
    as_user(s["alice"])
    back = await client.post(f"/api/v1/reservations/{ids['alice']}/return")
    assert back.status_code == 200
    pool = back.json()
    assert pool["holders"][0]["status"] == "returning" and pool["holders"][0]["ready"]
    assert pool["waiting"][0]["step"] == "swap" and pool["waiting"][0]["ready"]
    assert (await client.post(f"/api/v1/reservations/{ids['alice']}/return")).status_code == 200
    op_note = (await _dms(db, bot, s["op"], cid))[-1]
    assert op_note.startswith("🔙 Alice さん (alice@example.jp) が「Claude Premium シート」")
    assert "「外した」" in op_note and "次は Carol さん (carol@example.jp) です。" in op_note
    as_user(s["op"])
    removed = await client.post(f"/api/v1/reservations/{ids['alice']}/remove")
    assert removed.status_code == 200 and removed.json()["holders"] == []
    assert removed.json()["waiting"][0]["step"] == "assign"
    last = (await _posts(db, cid, bot))[-1]
    assert last == "⏹ Alice さんの「Claude Premium シート」の返却が済みました"
    assert "返却が済みました" in (await _dms(db, bot, s["alice"], cid))[-1]
    # (the operator who pressed 「外した」 is not told to assign: it shows on the card)
    assert not (await _dms(db, bot, s["op"], cid))[-1].startswith("🙋 Carol さん (carol@")
    # An operator drops a request; its member hears of it.
    dropped = await client.post(f"/api/v1/reservations/{carol_id}/cancel")
    assert dropped.status_code == 200 and dropped.json()["waiting"] == []
    assert "担当者 (Op さん) が取り消しました" in (await _dms(db, bot, s["carol"], cid))[-1]
    assert (await client.post(f"/api/v1/reservations/{carol_id}/assign")).status_code == 409


async def test_two_operators_at_once_assign_one_seat(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user, capacity=1)
    pid = s["pid"]
    ids = []
    for name in ("alice", "bob"):
        as_user(s[name])
        ids.append(
            (await client.post(f"/api/v1/reservation-pools/{pid}/reserve")).json()[
                "my_reservation_id"
            ]
        )
    op = s["op"]
    owner = s["owner"]

    async def press(user: User, rid: str) -> str:
        async with app.state.db.session_factory() as session:
            actor = await session.get(User, user.id)
            assert actor is not None
            try:
                await reservations.assign(session, actor, uuid.UUID(rid))
                return "ok"
            except Exception as exc:  # the loser of the race: the pool is full
                return getattr(exc, "code", type(exc).__name__)

    # The same request from two operators: one seat, one assignment.
    results = await asyncio.gather(press(op, ids[0]), press(owner, ids[0]))
    assert list(results) == ["ok", "ok"]
    # Two different requests for the last seat: one of them is refused.
    async with app.state.db.session_factory() as session:
        await session.execute(
            update(Reservation)
            .where(Reservation.id == uuid.UUID(ids[0]))
            .values(status="done", end_reason="removed")
        )
        await session.commit()
    as_user(s["carol"])
    third = (await client.post(f"/api/v1/reservation-pools/{pid}/reserve")).json()
    results = await asyncio.gather(press(op, ids[1]), press(owner, third["my_reservation_id"]))
    assert sorted(results) == ["ok", "reservation_pool_full"]
    rows = (
        (
            await db.execute(
                select(Reservation).where(
                    Reservation.pool_id == uuid.UUID(pid), Reservation.status == "holding"
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1


async def test_settings_permissions_and_limits(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user)
    pid, cid = s["pid"], s["cid"]
    guest = await make_user(db, "visitor", role="guest")
    stranger = await make_user(db, "stranger")
    admin = await make_user(db, "root", role="admin")
    as_user(s["owner"])
    await client.post(f"/api/v1/channels/{cid}/members", json={"user_id": str(guest.id)})

    # Members do not change the settings; the owner does; operators must be members.
    as_user(s["alice"])
    refused = await client.patch(f"/api/v1/reservation-pools/{pid}", json={"capacity": 3})
    assert refused.status_code == 403
    assert refused.json()["error"]["code"] == "reservation_manage_restricted"
    made = await client.post(
        f"/api/v1/channels/{cid}/reservation-pools", json={"name": "x", "capacity": 1}
    )
    assert made.status_code == 403
    as_user(s["owner"])
    bad = await client.patch(
        f"/api/v1/reservation-pools/{pid}", json={"operator_ids": [str(stranger.id)]}
    )
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "reservation_operator_invalid"
    bad = await client.patch(
        f"/api/v1/reservation-pools/{pid}", json={"operator_ids": [str(guest.id)]}
    )
    assert bad.status_code == 400
    changed = await client.patch(
        f"/api/v1/reservation-pools/{pid}",
        json={"capacity": 3, "min_hours": 12, "grace_minutes": 30, "name": " シート "},
    )
    assert changed.status_code == 200, changed.text
    out = changed.json()
    assert (out["capacity"], out["min_hours"], out["grace_minutes"], out["name"]) == (
        3,
        12,
        30,
        "シート",
    )
    assert (
        await client.patch(f"/api/v1/reservation-pools/{pid}", json={"tz": "Mars/Base"})
    ).status_code == 422

    # Guests and non-members do not reserve; a paused pool takes nobody.
    as_user(guest)
    no = await client.post(f"/api/v1/reservation-pools/{pid}/reserve")
    assert no.status_code == 403 and no.json()["error"]["code"] == "guest_restricted"
    as_user(stranger)
    assert (await client.post(f"/api/v1/reservation-pools/{pid}/reserve")).status_code == 403
    assert (await client.get(f"/api/v1/channels/{cid}/reservation-pools")).status_code == 200
    as_user(s["owner"])
    await client.patch(f"/api/v1/reservation-pools/{pid}", json={"enabled": False})
    as_user(s["alice"])
    paused = await client.post(f"/api/v1/reservation-pools/{pid}/reserve")
    assert paused.status_code == 409
    assert paused.json()["error"]["code"] == "reservation_pool_disabled"

    # A private channel's pools stay hidden from outsiders.
    as_user(s["owner"])
    secret = await _channel(client, "secret", [], type="private")
    hidden = (
        await client.post(
            f"/api/v1/channels/{secret}/reservation-pools", json={"name": "s", "capacity": 1}
        )
    ).json()
    as_user(stranger)
    gone = await client.post(f"/api/v1/reservation-pools/{hidden['id']}/reserve")
    assert gone.status_code == 404 and gone.json()["error"]["code"] == "reservation_pool_not_found"
    # An administrator (not a member) can operate and manage a public channel's pool.
    as_user(admin)
    listed = (await client.get(f"/api/v1/channels/{cid}/reservation-pools")).json()
    assert listed[0]["can_manage"] and listed[0]["can_operate"]

    # DMs take no pools; at most 5 per channel; deleting keeps the bot's posts.
    as_user(s["owner"])
    dm = await client.post("/api/v1/dms", json={"user_ids": [str(s["alice"].id)]})
    in_dm = await client.post(
        f"/api/v1/channels/{dm.json()['id']}/reservation-pools", json={"name": "d", "capacity": 1}
    )
    assert in_dm.status_code == 400
    assert in_dm.json()["error"]["code"] == "reservation_channel_unsupported"
    for n in range(4):
        made = await client.post(
            f"/api/v1/channels/{cid}/reservation-pools", json={"name": f"p{n}", "capacity": 1}
        )
        assert made.status_code == 201
        assert made.json()["bot_user_id"] == s["bot"]  # one bot per channel
    sixth = await client.post(
        f"/api/v1/channels/{cid}/reservation-pools", json={"name": "p6", "capacity": 1}
    )
    assert sixth.status_code == 409
    assert sixth.json()["error"]["code"] == "too_many_reservation_pools"
    assert (await client.delete(f"/api/v1/reservation-pools/{pid}")).status_code == 204
    pools = (await client.get(f"/api/v1/channels/{cid}/reservation-pools")).json()
    assert pid not in [p["id"] for p in pools] and len(pools) == 4
    deleted = (
        (
            await db.execute(
                select(OutboxEvent).where(OutboxEvent.event_type == "reservation.updated")
            )
        )
        .scalars()
        .all()
    )
    assert any(e.payload.get("deleted") and e.payload["pool_id"] == pid for e in deleted)


async def test_waiting_member_who_leaves_is_dropped_and_others_move_up(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    s = await _setup(client, db, as_user, capacity=1)
    pid, cid = s["pid"], s["cid"]
    ids = {}
    for name in ("alice", "bob", "carol"):
        as_user(s[name])
        ids[name] = (await client.post(f"/api/v1/reservation-pools/{pid}/reserve")).json()[
            "my_reservation_id"
        ]
    as_user(s["op"])
    await client.post(f"/api/v1/reservations/{ids['alice']}/assign")
    as_user(s["bob"])
    assert (await client.post(f"/api/v1/channels/{cid}/leave")).status_code in (200, 204)
    assert await _tick(app) == 1
    as_user(s["op"])
    pool = (await client.get(f"/api/v1/channels/{cid}/reservation-pools")).json()[0]
    assert [w["user_id"] for w in pool["waiting"]] == [str(s["carol"].id)]
    assert pool["waiting"][0]["position"] == 1
