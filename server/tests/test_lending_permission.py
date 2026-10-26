"""備品 L2 (M168, docs/LENDING.md §4.2, §6.3, §6.4, §14): whether an item needs a teacher's
permission (item → category → no), the teachers who may be named (the roster's @faculty, everyone
without a roster, never oneself, not deactivated people, guests or bots), a teacher borrowing
without anyone's permission, and who sees the permission's details. L3 (M169): the teacher's own
decision (confirmed / denied, only the teacher named, until 14 days after the return), its
notices (the borrower and the keepers; the administrators without keepers), the to-do done (by
the decision, or by the worker 14 days after the return), the history and the audit."""

import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient, Response
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.audit.models import AuditLog
from app.modules.lending import notices
from app.modules.lending.models import LendingNotice
from app.modules.users.models import User
from tests.helpers import make_user
from tests.lending_helpers import API, LoanLab, _code, _ok, freeze, make_lab


async def _category(lab: LoanLab, **body: Any) -> str:
    lab.as_user(lab.keeper)
    out = await _ok(await lab.client.post(f"{API}/lending/categories", json=body), 201)
    return str(out["id"])


async def _roster(lab: LoanLab, user: User, **line: Any) -> None:
    lab.as_user(lab.admin)
    await _ok(await lab.client.put(f"{API}/lab/roster/{user.id}", json=line))


async def test_requires_permission_resolution(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    freeze(monkeypatch)
    lab = await make_lab(db, client, as_user)
    pcs = await _category(lab, name="PC", requires_permission=True)
    inherits = await lab.item(name="PC-01", category_id=pcs)
    overridden = await lab.item(name="PC-02", category_id=pcs, requires_permission=False)
    own = await lab.item(name="カメラ", requires_permission=True)
    plain = await lab.item(name="ケーブル")
    assert (inherits["requires_permission"], inherits["requires_permission_source"]) == (
        True,
        "category",
    )

    for item in (inherits, own):
        missing = await lab.borrow_response(lab.member, item["id"])
        assert missing.status_code == 400 and _code(missing) == "lending_permission_required"
        unticked = await lab.borrow_response(
            lab.member, item["id"], approver_id=str(lab.manager.id)
        )
        assert _code(unticked) == "lending_permission_required"
        nobody = await lab.borrow_response(lab.member, item["id"], permission_confirmed=True)
        assert _code(nobody) == "lending_permission_required"
    # Not needed: what is sent about it is ignored.
    for item in (overridden, plain):
        loan = await lab.borrow(lab.member, item["id"], approver_id=str(lab.manager.id))
        assert loan["permission_required"] is False and loan["approver_id"] is None

    loan = await lab.borrow(
        lab.member, own["id"], permission_confirmed=True, approver_id=str(lab.manager.id)
    )
    assert loan["permission_required"] is True and loan["permission_state"] == "claimed"
    assert loan["approver_id"] == str(lab.manager.id)
    # A later change of the item does not change the loan.
    as_user(lab.keeper)
    await _ok(
        await client.patch(f"{API}/lending/items/{own['id']}", json={"requires_permission": False})
    )
    seen = await _ok(await client.get(f"{API}/lending/loans/{loan['id']}"))
    assert seen["permission_required"] is True

    # The details: the borrower, the teacher named, keepers and administrators; no one else.
    for viewer, shown in (
        (lab.member, True),
        (lab.manager, True),
        (lab.keeper, True),
        (lab.admin, True),
        (lab.bob, False),
    ):
        as_user(viewer)
        out = await _ok(await client.get(f"{API}/lending/loans/{loan['id']}"))
        assert out["details_hidden"] is (not shown)
        assert out["approver_id"] == (str(lab.manager.id) if shown else None)
        assert out["permission_state"] == ("claimed" if shown else None)
        assert out["permission_required"] is True
        brief = (await _ok(await client.get(f"{API}/lending/items/{own['id']}")))["loan"]
        assert brief["permission_state"] == ("claimed" if shown else None)
    as_user(lab.manager)
    approved = await _ok(await client.get(f"{API}/lending/loans", params={"scope": "approved"}))
    assert [a["id"] for a in approved] == [loan["id"]] and approved[0]["purpose"]
    as_user(lab.bob)
    assert await _ok(await client.get(f"{API}/lending/loans", params={"scope": "approved"})) == []


async def test_approvers_without_a_roster(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    freeze(monkeypatch)
    lab = await make_lab(db, client, as_user)
    bot = await make_user(db, "robot", role="bot")
    gone = await make_user(db, "gone")
    await db.execute(update(User).where(User.id == gone.id).values(deactivated_at=utcnow()))
    await db.commit()
    as_user(lab.member)
    out = await _ok(await client.get(f"{API}/lending/approvers"))
    people = {lab.admin.id, lab.manager.id, lab.keeper.id, lab.bob.id}
    assert set(out["user_ids"]) == {str(i) for i in people}
    assert out["suggested_ids"] == [] and out["self_approved"] is False

    item = await lab.item(requires_permission=True)
    for wrong in (lab.member.id, gone.id, bot.id, lab.guest.id, uuid.uuid4()):
        refused = await lab.borrow_response(
            lab.member, item["id"], permission_confirmed=True, approver_id=str(wrong)
        )
        assert refused.status_code == 400 and _code(refused) == "lending_approver_invalid", wrong
    # Without a roster no one is a teacher: an administrator names someone too.
    admin = await lab.borrow_response(lab.admin, item["id"])
    assert _code(admin) == "lending_permission_required"
    await lab.borrow(lab.bob, item["id"], permission_confirmed=True, approver_id=str(lab.admin.id))


async def test_faculty_approvers_and_teachers_borrowing(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    freeze(monkeypatch)
    lab = await make_lab(db, client, as_user)
    prof = await make_user(db, "prof")
    assoc = await make_user(db, "assoc")
    await _roster(lab, prof, affiliation="faculty", rank="professor")
    await _roster(lab, assoc, affiliation="faculty", rank="associate_professor")
    await _roster(lab, lab.member, affiliation="student", grade="M1", supervisor_id=str(assoc.id))

    as_user(lab.member)
    out = await _ok(await client.get(f"{API}/lending/approvers"))
    assert set(out["user_ids"]) == {str(prof.id), str(assoc.id)}
    assert out["suggested_ids"] == [str(assoc.id)] and out["self_approved"] is False
    as_user(prof)
    out = await _ok(await client.get(f"{API}/lending/approvers"))
    assert out["user_ids"] == [str(assoc.id)] and out["self_approved"] is True

    item = await lab.item(requires_permission=True)
    other = await lab.item(name="カメラ B", requires_permission=True)
    # Someone who is not faculty cannot be named any more.
    refused = await lab.borrow_response(
        lab.member, item["id"], permission_confirmed=True, approver_id=str(lab.admin.id)
    )
    assert _code(refused) == "lending_approver_invalid"
    loan = await lab.borrow(
        lab.member, item["id"], permission_confirmed=True, approver_id=str(assoc.id)
    )
    assert loan["approver_id"] == str(assoc.id)

    # A teacher borrows without anyone's permission (recorded as self_approved).
    own = await lab.borrow(prof, other["id"])
    assert own["permission_required"] is False and own["approver_id"] is None
    as_user(prof)
    history = await _ok(await client.get(f"{API}/lending/items/{other['id']}/history"))
    assert history["events"][0]["details"]["self_approved"] is True

    # A deactivated teacher is no candidate; with no one active on @faculty everyone is.
    await db.execute(
        update(User).where(User.id.in_([prof.id, assoc.id])).values(deactivated_at=utcnow())
    )
    await db.commit()
    as_user(lab.member)
    out = await _ok(await client.get(f"{API}/lending/approvers"))
    assert str(prof.id) not in out["user_ids"] and str(lab.bob.id) in out["user_ids"]
    assert out["suggested_ids"] == []


# --- the teacher's decision (L3, M169, §5.3, §8.2) -------------------------------------------


async def _teacher_lab(
    db: AsyncSession,
    client: AsyncClient,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[LoanLab, User, Any]:
    clock = freeze(monkeypatch)
    lab = await make_lab(db, client, as_user)
    prof = await make_user(db, "prof")
    await _roster(lab, prof, affiliation="faculty", rank="professor")
    return lab, prof, clock


async def _decide(lab: LoanLab, user: User, loan_id: str, decision: str, **body: Any) -> Response:
    lab.as_user(user)
    return await lab.client.post(
        f"{API}/lending/loans/{loan_id}/permission", json={"decision": decision, **body}
    )


async def _lending_notices(db: AsyncSession, user: User) -> list[LendingNotice]:
    rows = await db.execute(
        select(LendingNotice)
        .where(LendingNotice.user_id == user.id)
        .order_by(LendingNotice.at, LendingNotice.id)
        .execution_options(populate_existing=True)
    )
    return list(rows.scalars().all())


async def test_denial_tells_the_borrower_and_the_keepers(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab, prof, _ = await _teacher_lab(db, client, as_user, monkeypatch)
    item = await lab.item(code="CAM-02", requires_permission=True)
    loan = await lab.borrow(
        lab.member, item["id"], due=4, permission_confirmed=True, approver_id=str(prof.id)
    )
    lid = loan["id"]
    # The teacher's to-do, in their activity.
    (todo,) = await _lending_notices(db, prof)
    assert todo.key == f"permission:{lid}" and todo.role == "approver" and todo.done_at is None
    assert todo.text == (
        "🔑 Alice さんが「カメラ A（CAM-02）」を借りました（10/30 まで、目的：学会発表の撮影）。"
        "あなたの許可を得たとしています。許可していなければ「許可していない」を押してください。"
    )
    as_user(prof)
    feed = (await _ok(await client.get(f"{API}/activity", params={"include": "lending"})))["items"]
    assert feed[0]["lending"]["role"] == "approver" and feed[0]["lending"]["done"] is False
    assert await _lending_notices(db, lab.keeper) == []

    # Only the teacher named: not the borrower, a keeper or an administrator.
    for other in (lab.member, lab.keeper, lab.admin, lab.bob):
        refused = await _decide(lab, other, lid, "denied")
        assert refused.status_code == 403 and _code(refused) == "lending_not_approver", other
    plain = await lab.item(name="ケーブル")
    free = await lab.borrow(lab.bob, plain["id"])
    refused = await _decide(lab, prof, free["id"], "denied")
    assert refused.status_code == 409 and _code(refused) == "lending_permission_not_required"
    missing = await _decide(lab, prof, str(uuid.uuid4()), "denied")
    assert missing.status_code == 404 and _code(missing) == "lending_loan_not_found"

    denied = await _ok(await _decide(lab, prof, lid, "denied", note="  聞いていません  "))
    assert denied["permission_state"] == "denied" and denied["permission_note"] == "聞いていません"
    assert denied["permission_decided_at"] is not None
    (todo,) = await _lending_notices(db, prof)
    assert todo.done_at is not None and todo.done_by == prof.id
    updated = await db.scalars(
        select(OutboxEvent).where(
            OutboxEvent.event_type == "activity.updated", OutboxEvent.audience_id == prof.id
        )
    )
    assert [e.payload["item_ids"] for e in updated] == [[str(todo.id)]]
    as_user(prof)
    summary = await _ok(await client.get(f"{API}/activity/summary", params={"include": "lending"}))
    assert summary["unread_count"] == 0
    (to_borrower,) = await _lending_notices(db, lab.member)
    assert to_borrower.key == f"denied:{lid}" and to_borrower.role == "borrower"
    assert to_borrower.text == (
        "⚠️ Prof さんは「カメラ A（CAM-02）」の貸し出しを許可していないとしました。"
        "返却して、もう一度相談してください。 一言：聞いていません"
    )
    (to_keeper,) = await _lending_notices(db, lab.keeper)
    assert to_keeper.key == f"denied:{lid}" and to_keeper.role == "keeper"
    assert to_keeper.text == (
        "⚠️ Alice さんの「カメラ A（CAM-02）」の貸し出し（10/30 まで）を、"
        "Prof さんが許可していないとしました。"
    )
    # The borrower can no longer extend it.
    as_user(lab.member)
    mine = await _ok(await client.get(f"{API}/lending/loans/{lid}"))
    assert mine["can_extend"] is False
    refused = await lab.extend(lab.member, lid, 6)
    assert refused.status_code == 409 and _code(refused) == "lending_permission_denied"
    # The history and the audit.
    as_user(lab.keeper)
    history = await _ok(await client.get(f"{API}/lending/items/{item['id']}/history"))
    assert history["events"][0]["kind"] == "permission_denied"
    assert history["events"][0]["details"] == {"from": "claimed", "to": "denied"}
    audits = (
        await db.scalars(
            select(AuditLog).where(AuditLog.action == "lending_loan.permission_decided")
        )
    ).all()
    assert [(a.details["from"], a.details["to"]) for a in audits] == [("claimed", "denied")]

    # The same decision again: nothing new. Then 「確認した」 (a mistake): kept, nobody told.
    await _ok(await _decide(lab, prof, lid, "denied"))
    confirmed = await _ok(await _decide(lab, prof, lid, "confirmed"))
    assert confirmed["permission_state"] == "confirmed" and confirmed["permission_note"] is None
    as_user(lab.keeper)
    history = await _ok(await client.get(f"{API}/lending/items/{item['id']}/history"))
    assert [e["kind"] for e in history["events"][:2]] == [
        "permission_confirmed",
        "permission_denied",
    ]
    assert len(await _lending_notices(db, lab.member)) == 1
    assert len(await _lending_notices(db, lab.keeper)) == 1
    # Denied once more: the notices were sent already (one per key).
    await _ok(await _decide(lab, prof, lid, "denied"))
    assert len(await _lending_notices(db, lab.member)) == 1


async def test_denial_without_keepers_goes_to_admins(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab, prof, _ = await _teacher_lab(db, client, as_user, monkeypatch)
    item = await lab.item(requires_permission=True)
    await lab.enable(keeper_ids=[])
    loan = await lab.borrow(
        lab.member, item["id"], permission_confirmed=True, approver_id=str(prof.id)
    )
    await _ok(await _decide(lab, prof, loan["id"], "denied"))
    assert [n.key for n in await _lending_notices(db, lab.admin)] == [f"denied:{loan['id']}"]
    assert await _lending_notices(db, lab.keeper) == []


async def test_decisions_close_14_days_after_the_return(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab, prof, clock = await _teacher_lab(db, client, as_user, monkeypatch)
    first = await lab.item(requires_permission=True)
    second = await lab.item(name="カメラ B", requires_permission=True)
    early = await lab.borrow(
        lab.member, first["id"], permission_confirmed=True, approver_id=str(prof.id)
    )
    late = await lab.borrow(
        lab.bob, second["id"], permission_confirmed=True, approver_id=str(prof.id)
    )
    await _ok(await lab.give_back(lab.member, early["id"]))
    returned_at = clock.now
    await _ok(await lab.give_back(lab.bob, late["id"]))

    # The to-dos stay open after the return; a decision is still possible for 14 days.
    clock.now = returned_at + timedelta(days=14)
    async with app.state.db.session_factory() as session:
        assert await notices.tick(session, now=clock.now) == 0
    await _ok(await _decide(lab, prof, early["id"], "confirmed"))
    clock.now = returned_at + timedelta(days=14, minutes=1)
    refused = await _decide(lab, prof, early["id"], "denied")
    assert refused.status_code == 409 and _code(refused) == "lending_loan_closed"
    # The worker closes the to-do nobody did once its 14 days are over.
    async with app.state.db.session_factory() as session:
        assert await notices.tick(session, now=clock.now) == 1
    todos = {n.loan_id: n for n in await _lending_notices(db, prof)}
    assert todos[uuid.UUID(late["id"])].done_at is not None
    assert todos[uuid.UUID(late["id"])].done_by is None
    assert todos[uuid.UUID(early["id"])].done_by == prof.id
    as_user(prof)
    approved = await _ok(await client.get(f"{API}/lending/loans", params={"scope": "approved"}))
    assert approved == []
