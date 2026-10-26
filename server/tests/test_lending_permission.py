"""備品 L2 (M168, docs/LENDING.md §4.2, §6.3, §6.4, §14): whether an item needs a teacher's
permission (item → category → no), the teachers who may be named (the roster's @faculty, everyone
without a roster, never oneself, not deactivated people, guests or bots), a teacher borrowing
without anyone's permission, and who sees the permission's details. The teacher's own decision
(confirmed / denied) is L3."""

import uuid
from collections.abc import Callable
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
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
