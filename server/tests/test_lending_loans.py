"""備品 L2 (M168, docs/LENDING.md §5.3, §6.3-§6.6, §7, §14): borrowing (the item's lock, the partial
unique index, client_request_id), the due date's bounds in the workspace's zone, extending (the
borrower's limits, the keeper's date change), returning (also on someone's behalf, and two at
once), the loan lists and their hidden fields, the item views and the bootstrap's counts."""

import asyncio
import uuid
from collections.abc import Callable
from datetime import timedelta

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.events.models import OutboxEvent
from app.modules.audit.models import AuditLog
from app.modules.lending import loans
from app.modules.lending.models import LendingItem, LendingItemEvent, LendingLoan
from app.modules.lending.schemas import LendingBorrowIn, LendingReturnIn
from app.modules.users.models import User
from tests.lending_helpers import API, TODAY, _code, _ok, day, freeze, make_lab


async def _events(db: AsyncSession, item_id: str) -> list[LendingItemEvent]:
    rows = await db.execute(
        select(LendingItemEvent)
        .where(LendingItemEvent.item_id == uuid.UUID(item_id))
        .order_by(LendingItemEvent.id)
        .execution_options(populate_existing=True)
    )
    return list(rows.scalars().all())


async def test_borrow_retry_and_return(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    freeze(monkeypatch)
    lab = await make_lab(db, client, as_user)
    item = await lab.item(code="CAM-02")
    other = await lab.item(name="カメラ B")
    request_id = str(uuid.uuid4())
    loan = await lab.borrow(lab.member, item["id"], client_request_id=request_id, due=5)
    assert loan["status"] == "active" and loan["borrower_id"] == str(lab.member.id)
    assert (loan["due_on"], loan["original_due_on"]) == (day(5), day(5))
    assert loan["item_name"] == "カメラ A" and loan["item_code"] == "CAM-02"
    assert loan["purpose"] == "学会発表の撮影" and loan["details_hidden"] is False
    assert loan["permission_required"] is False and loan["permission_state"] is None
    assert loan["latest_due_on"] == day(14) and loan["can_extend"] is True
    assert loan["overdue_days"] == 0 and loan["extension_count"] == 0

    # A retry: the same loan, 200.
    again = await lab.borrow_response(lab.member, item["id"], client_request_id=request_id, due=5)
    assert again.status_code == 200 and again.json()["id"] == loan["id"]
    # The same id for another item.
    reused = await lab.borrow_response(lab.member, other["id"], client_request_id=request_id)
    assert reused.status_code == 409 and _code(reused) == "idempotency_conflict"

    detail = await _ok(await client.get(f"{API}/lending/items/{item['id']}"))
    assert detail["status"] == "on_loan" and detail["loan"]["id"] == loan["id"]
    assert detail["loan"]["permission_state"] is None and detail["loan"]["status"] == "active"
    assert [r["id"] for r in detail["recent_loans"]] == [loan["id"]]
    listed = await _ok(await client.get(f"{API}/lending/items"))
    assert {i["id"]: i["loan"] and i["loan"]["id"] for i in listed} == {
        item["id"]: loan["id"],
        other["id"]: None,
    }

    # Someone else, and I again with a new request id: unavailable.
    taken = await lab.borrow_response(lab.bob, item["id"])
    assert taken.status_code == 409 and _code(taken) == "lending_item_unavailable"
    assert taken.json()["error"]["details"] == {
        "status": "on_loan",
        "loan_id": loan["id"],
        "borrower_id": str(lab.member.id),
        "due_on": day(5),
    }
    mine = await lab.borrow_response(lab.member, item["id"])
    assert mine.status_code == 409
    assert mine.json()["error"]["details"]["borrower_id"] == str(lab.member.id)

    as_user(lab.member)
    boot = (await _ok(await client.get(f"{API}/sync/bootstrap")))["lending"]
    assert (boot["my_active_count"], boot["my_overdue_count"]) == (1, 0)

    returned = await _ok(await lab.give_back(lab.member, loan["id"], note="充電器は棚の箱へ"))
    assert returned["status"] == "returned" and returned["returned_by"] == str(lab.member.id)
    assert returned["return_condition"] == "ok" and returned["return_note"] == "充電器は棚の箱へ"
    assert returned["can_extend"] is False
    # Pressed again: no change.
    twice = await _ok(await lab.give_back(lab.member, loan["id"], "issue", "壊れた"))
    assert twice["return_condition"] == "ok" and twice["returned_at"] == returned["returned_at"]
    # The first request id still answers with the same (returned) loan.
    late = await lab.borrow_response(lab.member, item["id"], client_request_id=request_id)
    assert late.status_code == 200 and late.json()["status"] == "returned"

    detail = await _ok(await client.get(f"{API}/lending/items/{item['id']}"))
    assert detail["status"] == "available" and detail["loan"] is None
    assert detail["recent_loans"][0]["return_condition"] == "ok"
    assert [(e.kind, str(e.loan_id) if e.loan_id else None) for e in await _events(db, item["id"])][
        1:
    ] == [("borrowed", loan["id"]), ("returned", loan["id"])]
    history = await _ok(await client.get(f"{API}/lending/items/{item['id']}/history"))
    assert history["events"][0]["details"] == {"condition": "ok", "by_keeper": False}
    assert history["events"][1]["details"] == {"due_on": day(5)}
    # The borrower's own acts are not audited (§10).
    actions = (await db.execute(select(AuditLog.action))).scalars().all()
    assert not any(a.startswith("lending_loan.") for a in actions)
    outbox = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "lending.updated")))
        .scalars()
        .all()
    )
    assert outbox[-1].payload == {"item_ids": [item["id"]], "categories": False, "settings": False}

    # Lent once: retire it, never delete it.
    as_user(lab.keeper)
    refused = await client.delete(f"{API}/lending/items/{item['id']}")
    assert refused.status_code == 409 and _code(refused) == "lending_item_has_history"
    # Not available: in repair.
    await _ok(
        await client.post(f"{API}/lending/items/{other['id']}/status", json={"status": "in_repair"})
    )
    repair = await lab.borrow_response(lab.bob, other["id"])
    assert repair.status_code == 409 and repair.json()["error"]["details"] == {
        "status": "in_repair"
    }


async def test_due_date_bounds_and_zone(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = freeze(monkeypatch)
    lab = await make_lab(db, client, as_user)
    items = [(await lab.item(name=f"本 {i}", max_days=3))["id"] for i in range(4)]
    # 23:59 in Tokyo on the 26th.
    clock.now = clock.now.replace(hour=14, minute=59)
    past = await lab.borrow_response(lab.member, items[0], due=-1)
    assert past.status_code == 400 and _code(past) == "lending_due_invalid"
    assert past.json()["error"]["details"] == {"reason": "past", "latest": day(3)}
    long = await lab.borrow_response(lab.member, items[0], due=4)
    assert long.status_code == 400
    assert long.json()["error"]["details"] == {"reason": "too_long", "latest": day(3)}
    same_day = await lab.borrow(lab.member, items[0], due=0)
    assert same_day["latest_due_on"] == day(3)
    await lab.borrow(lab.member, items[1], due=3)
    # A minute later it is the 27th in Tokyo: the 26th is past, the 30th is allowed.
    clock.advance(minutes=1)
    gone = await lab.borrow_response(lab.member, items[2], due=0)
    assert gone.status_code == 400 and gone.json()["error"]["details"]["reason"] == "past"
    await lab.borrow(lab.member, items[2], due=4)
    # The same-day loan is now overdue by one day.
    as_user(lab.member)
    mine = await _ok(await client.get(f"{API}/lending/loans", params={"scope": "mine"}))
    assert [(m["due_on"], m["overdue_days"]) for m in mine] == [
        (day(0), 1),
        (day(3), 0),
        (day(4), 0),
    ]
    # In UTC it is still the 26th.
    await lab.enable(tz="UTC")
    await lab.borrow(lab.member, items[3], due=0)


async def test_extend_limits_and_keeper_date_change(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    freeze(monkeypatch)
    lab = await make_lab(db, client, as_user)
    item = await lab.item(max_days=5)
    loan = await lab.borrow(lab.member, item["id"], due=1)
    lid = loan["id"]

    same = await _ok(await lab.extend(lab.member, lid, 1))
    assert same["extension_count"] == 0
    earlier = await lab.extend(lab.member, lid, 0)
    assert earlier.status_code == 400
    assert earlier.json()["error"]["details"] == {"reason": "not_later", "latest": day(5)}
    long = await lab.extend(lab.member, lid, 6)
    assert long.status_code == 400 and long.json()["error"]["details"]["reason"] == "too_long"
    assert (await _ok(await lab.extend(lab.member, lid, 3)))["extension_count"] == 1
    second = await _ok(await lab.extend(lab.member, lid, 5))
    assert second["extension_count"] == 2 and second["can_extend"] is False
    third = await lab.extend(lab.member, lid, 4)
    assert third.status_code == 409 and _code(third) == "lending_extend_limit"
    assert third.json()["error"]["details"] == {"max_extensions": 2}
    stranger = await lab.extend(lab.bob, lid, 4)
    assert stranger.status_code == 403 and _code(stranger) == "lending_not_yours"

    # A keeper: beyond the limits, not counted, earlier too; audited as due_changed.
    as_user(lab.keeper)
    seen = await _ok(await client.get(f"{API}/lending/loans/{lid}"))
    assert seen["can_extend"] is True
    changed = await _ok(await lab.extend(lab.keeper, lid, 30))
    assert changed["due_on"] == day(30) and changed["extension_count"] == 2
    too_far = await lab.extend(lab.keeper, lid, 366)
    assert too_far.status_code == 400
    assert too_far.json()["error"]["details"] == {"reason": "too_long", "latest": day(365)}
    past = await lab.extend(lab.keeper, lid, -1)
    assert past.status_code == 400 and past.json()["error"]["details"]["reason"] == "past"
    back = await _ok(await lab.extend(lab.keeper, lid, 2))
    assert back["due_on"] == day(2) and back["original_due_on"] == day(1)
    kinds = [(e.kind, e.details) for e in await _events(db, item["id"])][2:]
    assert kinds == [
        ("extended", {"from": day(1), "to": day(3)}),
        ("extended", {"from": day(3), "to": day(5)}),
        ("due_changed", {"from": day(5), "to": day(30)}),
        ("due_changed", {"from": day(30), "to": day(2)}),
    ]
    audits = (
        (
            await db.execute(
                select(AuditLog).where(AuditLog.action == "lending_loan.due_changed_by_keeper")
            )
        )
        .scalars()
        .all()
    )
    assert [a.details["to"] for a in audits] == [day(30), day(2)]
    assert audits[0].details["borrower_id"] == str(lab.member.id)

    # The teacher said no: the borrower may not extend, a keeper still may.
    denied = await lab.item(name="PC-03")
    other = await lab.borrow(lab.bob, denied["id"], due=1)
    await db.execute(
        update(LendingLoan)
        .where(LendingLoan.id == uuid.UUID(other["id"]))
        .values(permission_required=True, approver_id=lab.manager.id, permission_state="denied")
    )
    await db.commit()
    refused = await lab.extend(lab.bob, other["id"], 2)
    assert refused.status_code == 409 and _code(refused) == "lending_permission_denied"
    await _ok(await lab.extend(lab.keeper, other["id"], 2))

    # Returned: closed.
    await _ok(await lab.give_back(lab.member, lid))
    closed = await lab.extend(lab.member, lid, 3)
    assert closed.status_code == 409 and _code(closed) == "lending_loan_closed"


async def test_keeper_returns_on_behalf(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    freeze(monkeypatch)
    lab = await make_lab(db, client, as_user)
    item = await lab.item()
    loan = await lab.borrow(lab.member, item["id"])
    as_user(lab.member)
    no_note = await client.post(
        f"{API}/lending/loans/{loan['id']}/return", json={"condition": "issue"}
    )
    assert no_note.status_code == 422
    stranger = await lab.give_back(lab.bob, loan["id"])
    assert stranger.status_code == 403 and _code(stranger) == "lending_not_yours"
    guest = await lab.give_back(lab.guest, loan["id"])
    assert guest.status_code == 403 and _code(guest) == "guest_restricted"
    unknown = await lab.give_back(lab.member, str(uuid.uuid4()))
    assert unknown.status_code == 404 and _code(unknown) == "lending_loan_not_found"

    out = await _ok(await lab.give_back(lab.keeper, loan["id"], "issue", "レンズキャップが無い"))
    assert out["returned_by"] == str(lab.keeper.id) and out["return_condition"] == "issue"
    (row,) = (
        (
            await db.execute(
                select(AuditLog).where(AuditLog.action == "lending_loan.returned_by_keeper")
            )
        )
        .scalars()
        .all()
    )
    assert row.details == {
        "item_id": item["id"],
        "borrower_id": str(lab.member.id),
        "condition": "issue",
    }
    last = (await _events(db, item["id"]))[-1]
    assert (last.kind, last.details) == ("returned", {"condition": "issue", "by_keeper": True})
    # Everyone sees the 🔧 mark; only the borrower, the keepers and the admins the note.
    as_user(lab.bob)
    seen = await _ok(await client.get(f"{API}/lending/loans/{loan['id']}"))
    assert seen["return_condition"] == "issue" and seen["return_note"] is None
    assert seen["details_hidden"] is True and seen["purpose"] is None
    as_user(lab.admin)
    assert (await _ok(await client.get(f"{API}/lending/loans/{loan['id']}")))[
        "return_note"
    ] == "レンズキャップが無い"


async def test_loan_scopes_hiding_and_counts(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = freeze(monkeypatch)
    lab = await make_lab(db, client, as_user)
    a = await lab.item(name="A")
    b = await lab.item(name="B")
    c = await lab.item(name="C")
    d = await lab.item(name="D")
    # Ten days ago bob borrowed B until five days ago, and C until two days ago.
    clock.advance(days=-10)
    late = await lab.borrow(lab.bob, b["id"], due=-5)
    later = await lab.borrow(lab.bob, c["id"], due=-2)
    clock.advance(days=10)
    mine_a = await lab.borrow(lab.member, a["id"], due=2)
    done = await lab.borrow(lab.member, d["id"], due=1)
    await _ok(await lab.give_back(lab.member, done["id"]))

    as_user(lab.member)
    mine = await _ok(await client.get(f"{API}/lending/loans", params={"scope": "mine"}))
    assert [m["id"] for m in mine] == [mine_a["id"], done["id"]]
    default = await _ok(await client.get(f"{API}/lending/loans"))
    assert [m["id"] for m in default] == [mine_a["id"], done["id"]]
    active = await _ok(await client.get(f"{API}/lending/loans", params={"scope": "active"}))
    assert [(x["id"], x["overdue_days"]) for x in active] == [
        (late["id"], 5),
        (later["id"], 2),
        (mine_a["id"], 0),
    ]
    theirs = active[0]
    assert theirs["details_hidden"] is True and theirs["purpose"] is None
    assert theirs["borrower_id"] == str(lab.bob.id) and theirs["can_extend"] is False
    assert active[2]["purpose"] == "学会発表の撮影"
    refused = await client.get(f"{API}/lending/loans", params={"scope": "overdue"})
    assert refused.status_code == 403 and _code(refused) == "lending_keeper_required"
    bad = await client.get(f"{API}/lending/loans", params={"scope": "everything"})
    assert bad.status_code == 422
    boot = (await _ok(await client.get(f"{API}/sync/bootstrap")))["lending"]
    assert (boot["my_active_count"], boot["my_overdue_count"]) == (1, 0)
    assert boot["keeper_attention_count"] == 0

    as_user(lab.keeper)
    overdue = await _ok(await client.get(f"{API}/lending/loans", params={"scope": "overdue"}))
    assert [(x["id"], x["overdue_days"]) for x in overdue] == [
        (late["id"], 5),
        (later["id"], 2),
    ]
    assert overdue[0]["purpose"] == "学会発表の撮影" and overdue[0]["details_hidden"] is False
    boot = (await _ok(await client.get(f"{API}/sync/bootstrap")))["lending"]
    # keeper_overdue_days = 3: only B; then A's borrower is deactivated and counts too.
    assert boot["keeper_attention_count"] == 1
    await db.execute(update(User).where(User.id == lab.member.id).values(deactivated_at=clock.now))
    await db.commit()
    boot = (await _ok(await client.get(f"{API}/sync/bootstrap")))["lending"]
    assert boot["keeper_attention_count"] == 2
    as_user(lab.bob)
    boot = (await _ok(await client.get(f"{API}/sync/bootstrap")))["lending"]
    assert (boot["my_active_count"], boot["my_overdue_count"]) == (2, 2)

    # approved: the loans naming me (none here: nothing needed permission).
    as_user(lab.manager)
    assert await _ok(await client.get(f"{API}/lending/loans", params={"scope": "approved"})) == []
    unknown = await client.get(f"{API}/lending/loans/{uuid.uuid4()}")
    assert unknown.status_code == 404 and _code(unknown) == "lending_loan_not_found"


async def test_off_and_guests(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    freeze(monkeypatch)
    lab = await make_lab(db, client, as_user)
    item = await lab.item()
    loan = await lab.borrow(lab.member, item["id"])
    guest = await lab.borrow_response(lab.guest, item["id"])
    assert guest.status_code == 403 and _code(guest) == "guest_restricted"
    as_user(lab.guest)
    for path in ("/lending/loans", "/lending/approvers", f"/lending/loans/{loan['id']}"):
        denied = await client.get(f"{API}{path}")
        assert denied.status_code == 403 and _code(denied) == "guest_restricted", path
    await lab.enable(enabled=False)
    off = await lab.give_back(lab.member, loan["id"])
    assert off.status_code == 409 and _code(off) == "lending_disabled"
    assert (await client.get(f"{API}/lending/loans")).status_code == 409


# --- two at once (§7.1) -----------------------------------------------------------------------


async def test_two_sessions_borrow_at_once(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = freeze(monkeypatch)
    lab = await make_lab(db, client, as_user)
    item = await lab.item()
    item_id = uuid.UUID(item["id"])
    due = TODAY + timedelta(days=3)

    async def borrow(user: User) -> str:
        async with app.state.db.session_factory() as session:
            body = LendingBorrowIn(
                client_request_id=uuid.uuid4(), due_on=due, purpose="同時に借りる"
            )
            try:
                out, created = await loans.borrow(session, user, item_id, body)
            except AppError as exc:
                return exc.code
            assert created
            return str(out.borrower_id)

    for _ in range(3):
        results = await asyncio.gather(borrow(lab.member), borrow(lab.bob))
        assert sorted(results, key=len) in (
            sorted([str(lab.member.id), "lending_item_unavailable"], key=len),
            sorted([str(lab.bob.id), "lending_item_unavailable"], key=len),
        )
        active = (
            (
                await db.execute(
                    select(LendingLoan)
                    .where(LendingLoan.item_id == item_id, LendingLoan.status == "active")
                    .execution_options(populate_existing=True)
                )
            )
            .scalars()
            .all()
        )
        assert len(active) == 1
        winner = lab.member if active[0].borrower_id == lab.member.id else lab.bob
        await _ok(await lab.give_back(winner, str(active[0].id)))

    # The last guard: a second active loan cannot be written even without the lock.
    first = await lab.borrow(lab.member, item["id"], due=0)
    assert first["status"] == "active"
    db.add(
        LendingLoan(
            item_id=item_id,
            borrower_id=lab.bob.id,
            client_request_id=uuid.uuid4(),
            status="active",
            borrowed_at=clock.now,
            due_on=due,
            original_due_on=due,
            purpose="x",
            permission_required=False,
        )
    )
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_borrower_and_keeper_return_at_once(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    freeze(monkeypatch)
    lab = await make_lab(db, client, as_user)
    item = await lab.item()
    for _ in range(3):
        loan = await lab.borrow(lab.member, item["id"], due=0)
        loan_id = uuid.UUID(loan["id"])

        async def give_back(user: User, condition: str, loan_id: uuid.UUID) -> str:
            async with app.state.db.session_factory() as session:
                body = LendingReturnIn(condition=condition, note="x")  # type: ignore[arg-type]
                out = await loans.return_loan(session, user, loan_id, body)
                return str(out.returned_by)

        results = await asyncio.gather(
            give_back(lab.member, "ok", loan_id), give_back(lab.keeper, "issue", loan_id)
        )
        assert results[0] == results[1]  # both see the one return that happened
        row = await db.get(LendingLoan, loan_id, populate_existing=True)
        assert row is not None and str(row.returned_by) == results[0]
        assert row.return_condition == ("ok" if results[0] == str(lab.member.id) else "issue")
        returns = [
            e
            for e in await _events(db, item["id"])
            if e.kind == "returned" and e.loan_id == loan_id
        ]
        assert len(returns) == 1
        stored = await db.get(LendingItem, uuid.UUID(item["id"]), populate_existing=True)
        assert stored is not None and stored.status == "available"
        assert stored.current_loan_id is None
