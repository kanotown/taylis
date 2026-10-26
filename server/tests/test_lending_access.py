"""備品 L2 (M168, docs/LENDING.md §3.2, §14): the loan rows of the table of who may do what, over
{admin, manager, member, guest, keeper, the borrower, the teacher named} (the ledger's rows are in
test_lending_ledger.py; the teacher's decision comes in L3), and a keeper taken off the list or
deactivated."""

from collections.abc import Callable
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.modules.users.models import User
from tests.helpers import make_user
from tests.lending_helpers import API, day, freeze, make_lab

G = "guest_restricted"
NOT_YOURS = "lending_not_yours"
KEEPERS = "lending_keeper_required"


def _outcome(status: int, body: dict[str, Any]) -> int | str:
    return status if status < 400 else body["error"]["code"]


async def test_loan_permission_table(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    freeze(monkeypatch)
    lab = await make_lab(db, client, as_user)
    teacher = await make_user(db, "prof")
    as_user(lab.admin)
    roster = await client.put(f"{API}/lab/roster/{teacher.id}", json={"affiliation": "faculty"})
    assert roster.status_code == 200
    actors = {
        "admin": lab.admin,
        "manager": lab.manager,
        "member": lab.bob,
        "guest": lab.guest,
        "keeper": lab.keeper,
        "borrower": lab.member,
        "approver": teacher,
    }
    # (sees the details, extend, return, the overdue list, borrow another item)
    expected: dict[str, tuple[bool | str, int | str, int | str, int | str, int | str]] = {
        "admin": (True, 200, 200, 200, 201),
        "manager": (False, NOT_YOURS, NOT_YOURS, KEEPERS, 201),
        "member": (False, NOT_YOURS, NOT_YOURS, KEEPERS, 201),
        "guest": (G, G, G, G, G),
        "keeper": (True, 200, 200, 200, 201),
        "borrower": (True, 200, 200, KEEPERS, 201),
        "approver": (True, NOT_YOURS, NOT_YOURS, KEEPERS, 201),
    }
    for name, actor in actors.items():
        item = await lab.item(name=f"{name} の備品", requires_permission=True)
        spare = await lab.item(name=f"{name} の予備", requires_permission=True)
        loan = await lab.borrow(
            lab.member, item["id"], due=1, permission_confirmed=True, approver_id=str(teacher.id)
        )
        as_user(actor)
        seen = await client.get(f"{API}/lending/loans/{loan['id']}")
        details: bool | str = (
            seen.json()["error"]["code"]
            if seen.status_code >= 400
            else not seen.json()["details_hidden"]
        )
        extended = await client.post(
            f"{API}/lending/loans/{loan['id']}/extend", json={"due_on": day(2)}
        )
        returned = await client.post(
            f"{API}/lending/loans/{loan['id']}/return", json={"condition": "ok"}
        )
        overdue = await client.get(f"{API}/lending/loans", params={"scope": "overdue"})
        # The teacher borrows without naming anyone; the others name the teacher.
        named: dict[str, Any] = {} if actor is teacher else {"approver_id": str(teacher.id)}
        borrowed = await lab.borrow_response(actor, spare["id"], permission_confirmed=True, **named)
        got = (
            details,
            _outcome(extended.status_code, extended.json()),
            _outcome(returned.status_code, returned.json()),
            _outcome(overdue.status_code, overdue.json()),
            _outcome(borrowed.status_code, borrowed.json()),
        )
        assert got == expected[name], name


async def test_keeper_off_the_list_or_deactivated(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    freeze(monkeypatch)
    lab = await make_lab(db, client, as_user)
    item = await lab.item()
    loan = await lab.borrow(lab.member, item["id"])
    # Taken off the list: no longer a keeper.
    await lab.enable(keeper_ids=[])
    gone = await lab.give_back(lab.keeper, loan["id"])
    assert gone.status_code == 403 and gone.json()["error"]["code"] == NOT_YOURS
    # On the list but deactivated: not a person any more.
    await lab.enable(keeper_ids=[str(lab.keeper.id)])
    await db.execute(update(User).where(User.id == lab.keeper.id).values(deactivated_at=utcnow()))
    await db.commit()
    await db.refresh(lab.keeper)
    off = await lab.give_back(lab.keeper, loan["id"])
    assert off.status_code == 403 and off.json()["error"]["code"] == G
