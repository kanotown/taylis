"""備品の貸し出し (equipment loans, L2 = M168, docs/LENDING.md §5.3, §6.3-§6.6, §7).

Borrowing, returning and extending are done by the borrower; a keeper may also record a return on
someone's behalf and set a due date outside the borrower's limits. Every change locks the item's
row first and then the loan's (`FOR UPDATE`, the same order everywhere, so two of them never
deadlock): two people borrowing the same item are served one after the other and the second reads
`on_loan` (409 lending_item_unavailable); the partial unique index `lending_loans_active_uniq` is
the last guard behind the lock. A retry of a borrow with the same `client_request_id` returns the
same loan (200). Each change writes the item's history, the audit row for a keeper's act on someone
else's loan (§10) and a `lending.updated` (audience all, no content) in the same transaction.

The teacher's decision (confirmed / denied), the notices and the watches come in L3 (M169)."""

import uuid
from datetime import date, timedelta
from typing import Any

from sqlalchemy import Select, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.collation import name_key as collation_key
from app.core.errors import AppError, bad_request, conflict, forbidden, not_found
from app.core.roles import PERSON_ROLES
from app.core.time import utcnow
from app.modules.audit import service as audit
from app.modules.groups.models import UserGroup, UserGroupMember
from app.modules.lab.models import LabProfile
from app.modules.lending import access, service
from app.modules.lending.models import (
    LendingCategory,
    LendingItem,
    LendingLoan,
    LendingSettings,
)
from app.modules.lending.schemas import (
    APPROVER_DAYS_AFTER_RETURN,
    KEEPER_MAX_DAYS,
    MINE_RETURNED_LIMIT,
    LendingApproversOut,
    LendingBorrowIn,
    LendingExtendIn,
    LendingLoanOut,
    LendingReturnIn,
    LoanScope,
)
from app.modules.users.models import User

# The roster's managed group whose members may give permission (§6.4, LAB.md).
FACULTY_GROUP = "faculty"


def _loan_not_found() -> AppError:
    return not_found("lending_loan_not_found", "No such loan")


def _plus(day: date, days: int) -> date:
    return day + timedelta(days=days)


# --- the teachers (§6.4) ----------------------------------------------------------------------


async def _faculty(db: AsyncSession) -> set[uuid.UUID]:
    """The active people in the roster's @faculty."""
    rows = await db.execute(
        select(User)
        .join(UserGroupMember, UserGroupMember.user_id == User.id)
        .join(UserGroup, UserGroup.id == UserGroupMember.group_id)
        .where(UserGroup.managed_key == FACULTY_GROUP)
    )
    return {u.id for u in rows.scalars().all() if access.is_person(u)}


async def approver_candidates(db: AsyncSession) -> tuple[set[uuid.UUID], set[uuid.UUID]]:
    """(who may be named, @faculty). Without a roster (no @faculty or no one active in it) every
    active person may be named, and no one borrows without naming someone (§6.4)."""
    faculty = await _faculty(db)
    if faculty:
        return set(faculty), faculty
    rows = await db.execute(
        select(User.id).where(User.role.in_(PERSON_ROLES), User.deactivated_at.is_(None))
    )
    return set(rows.scalars().all()), set()


async def approvers(db: AsyncSession, actor: User) -> LendingApproversOut:
    await service.require_ledger(db, actor)
    candidates, faculty = await approver_candidates(db)
    candidates.discard(actor.id)
    people = (
        (await db.execute(select(User).where(User.id.in_(candidates)))).scalars().all()
        if candidates
        else []
    )
    ordered = sorted(people, key=lambda u: (collation_key(u.display_name), u.username))
    supervisor = await db.scalar(
        select(LabProfile.supervisor_id).where(LabProfile.user_id == actor.id)
    )
    return LendingApproversOut(
        user_ids=[u.id for u in ordered],
        suggested_ids=[supervisor] if supervisor in candidates else [],
        self_approved=actor.id in faculty,
    )


# --- the loan's view (§5.3) -------------------------------------------------------------------


async def _loan_outs(
    db: AsyncSession, loans: list[LendingLoan], actor: User, settings: LendingSettings
) -> list[LendingLoanOut]:
    if not loans:
        return []
    item_ids = {loan.item_id for loan in loans}
    items = {
        i.id: i
        for i in (await db.execute(select(LendingItem).where(LendingItem.id.in_(item_ids))))
        .scalars()
        .all()
    }
    category_ids = {i.category_id for i in items.values() if i.category_id is not None}
    categories: dict[uuid.UUID, LendingCategory] = {}
    if category_ids:
        rows = await db.execute(select(LendingCategory).where(LendingCategory.id.in_(category_ids)))
        categories = {c.id: c for c in rows.scalars().all()}
    today = service.today_in(settings)
    keeper = access.can_keep(actor, settings)
    outs = []
    for loan in loans:
        item = items[loan.item_id]
        category = categories.get(item.category_id) if item.category_id else None
        _, max_days = service.effective(item, category, settings)
        latest = _plus(today, max_days)
        shown = access.sees_loan_details(actor, loan, settings)
        active = loan.status == "active"
        mine = actor.id == loan.borrower_id
        can_extend = active and (
            keeper
            or (
                mine
                and loan.permission_state != "denied"
                and loan.extension_count < settings.max_extensions
                and latest > loan.due_on
            )
        )
        outs.append(
            LendingLoanOut(
                id=loan.id,
                item_id=loan.item_id,
                item_name=item.name,
                item_code=item.code,
                borrower_id=loan.borrower_id,
                status=loan.status,  # type: ignore[arg-type]
                borrowed_at=loan.borrowed_at,
                due_on=loan.due_on,
                original_due_on=loan.original_due_on,
                overdue_days=service.overdue_days(loan, today),
                extension_count=loan.extension_count,
                can_extend=can_extend,
                latest_due_on=latest,
                purpose=loan.purpose if shown else None,
                permission_required=loan.permission_required,
                approver_id=loan.approver_id if shown else None,
                permission_state=loan.permission_state if shown else None,  # type: ignore[arg-type]
                permission_decided_at=loan.permission_decided_at if shown else None,
                permission_note=loan.permission_note if shown else None,
                returned_at=loan.returned_at,
                returned_by=loan.returned_by,
                return_condition=loan.return_condition,  # type: ignore[arg-type]
                return_note=loan.return_note if shown else None,
                details_hidden=not shown,
            )
        )
    return outs


async def _loan_out(
    db: AsyncSession, loan: LendingLoan, actor: User, settings: LendingSettings
) -> LendingLoanOut:
    (out,) = await _loan_outs(db, [loan], actor, settings)
    return out


# --- borrowing (§6.3, §7) ---------------------------------------------------------------------


async def _by_request(
    db: AsyncSession, borrower_id: uuid.UUID, request_id: uuid.UUID
) -> LendingLoan | None:
    return (
        await db.execute(
            select(LendingLoan)
            .where(
                LendingLoan.borrower_id == borrower_id,
                LendingLoan.client_request_id == request_id,
            )
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()


async def _replay(
    db: AsyncSession,
    actor: User,
    settings: LendingSettings,
    loan: LendingLoan,
    item_id: uuid.UUID,
) -> LendingLoanOut:
    """A retry of a borrow already made (§7.2): the same loan, even if returned since."""
    if loan.item_id != item_id:
        raise conflict(
            "idempotency_conflict", "client_request_id was already used to borrow another item"
        )
    out = await _loan_out(db, loan, actor, settings)
    await db.commit()
    return out


async def _unavailable(db: AsyncSession, item: LendingItem) -> AppError:
    details: dict[str, Any] = {"status": item.status}
    if item.current_loan_id is not None:
        loan = await db.get(LendingLoan, item.current_loan_id)
        if loan is not None:
            details |= {
                "loan_id": str(loan.id),
                "borrower_id": str(loan.borrower_id),
                "due_on": loan.due_on.isoformat(),
            }
    return conflict("lending_item_unavailable", "The item cannot be borrowed now", details)


def _due_invalid(reason: str, latest: date) -> AppError:
    return bad_request(
        "lending_due_invalid",
        "The return date is out of range",
        {"reason": reason, "latest": latest.isoformat()},
    )


async def borrow(
    db: AsyncSession, actor: User, item_id: uuid.UUID, data: LendingBorrowIn
) -> tuple[LendingLoanOut, bool]:
    """(the loan, whether it was made now). 409 lending_item_unavailable (details: status, and
    loan_id, borrower_id, due_on when on loan), 400 lending_due_invalid (details.reason: past /
    too_long, details.latest), 400 lending_permission_required / lending_approver_invalid, 409
    idempotency_conflict for a client_request_id used on another item."""
    settings = await service.require_ledger(db, actor)
    earlier = await _by_request(db, actor.id, data.client_request_id)
    if earlier is not None:
        return await _replay(db, actor, settings, earlier, item_id), False
    item = await service.locked_item(db, item_id)
    # A twin of this request may have held the lock first.
    earlier = await _by_request(db, actor.id, data.client_request_id)
    if earlier is not None:
        return await _replay(db, actor, settings, earlier, item_id), False
    if item.status != "available":
        raise await _unavailable(db, item)

    category = await db.get(LendingCategory, item.category_id) if item.category_id else None
    requires, max_days = service.effective(item, category, settings)
    today = service.today_in(settings)
    latest = _plus(today, max_days)
    if data.due_on < today:
        raise _due_invalid("past", latest)
    if data.due_on > latest:
        raise _due_invalid("too_long", latest)

    approver_id: uuid.UUID | None = None
    state: str | None = None
    self_approved = False
    if requires:
        candidates, faculty = await approver_candidates(db)
        if actor.id in faculty:
            # A teacher borrowing needs no one's permission (§6.3).
            self_approved = True
        elif not data.permission_confirmed or data.approver_id is None:
            raise bad_request(
                "lending_permission_required",
                "This item needs a teacher's permission: tick it and name the teacher",
            )
        elif data.approver_id == actor.id or data.approver_id not in candidates:
            raise bad_request(
                "lending_approver_invalid",
                "Name one of the teachers who may give permission",
                {"approver_id": str(data.approver_id)},
            )
        else:
            approver_id, state = data.approver_id, "claimed"

    now = utcnow()
    loan = LendingLoan(
        item_id=item.id,
        borrower_id=actor.id,
        client_request_id=data.client_request_id,
        status="active",
        borrowed_at=now,
        due_on=data.due_on,
        original_due_on=data.due_on,
        extension_count=0,
        purpose=data.purpose,
        permission_required=state is not None,
        approver_id=approver_id,
        permission_state=state,
        created_at=now,
        updated_at=now,
    )
    try:
        async with db.begin_nested():
            db.add(loan)
            await db.flush()
    except IntegrityError:
        # The unique indexes behind the lock (§7.1, §7.2): a twin request on another item, or a
        # loan made without the item's lock.
        earlier = await _by_request(db, actor.id, data.client_request_id)
        if earlier is not None:
            return await _replay(db, actor, settings, earlier, item_id), False
        item = await service.locked_item(db, item_id)
        raise await _unavailable(db, item) from None

    item.status = "on_loan"
    item.current_loan_id = loan.id
    details: dict[str, Any] = {"due_on": data.due_on.isoformat()}
    if self_approved:
        details["self_approved"] = True
    await service.record(db, item, actor, "borrowed", details, loan_id=loan.id)
    await service.emit(db, item_ids=[item.id])
    await db.commit()
    return await _loan_out(db, loan, actor, settings), True


# --- returning and extending (§6.5, §6.6) -----------------------------------------------------


async def _locked(
    db: AsyncSession, actor: User, settings: LendingSettings, loan_id: uuid.UUID
) -> tuple[LendingItem, LendingLoan]:
    """The loan's item and then the loan, both locked (§7.1); 403 lending_not_yours for anyone
    but the borrower and the keepers."""
    loan = await db.get(LendingLoan, loan_id)
    if loan is None:
        raise _loan_not_found()
    if not access.may_return(actor, loan, settings):
        raise forbidden("lending_not_yours", "Only the borrower or a keeper can do this")
    item = await service.locked_item(db, loan.item_id)
    locked = await db.get(LendingLoan, loan_id, with_for_update=True, populate_existing=True)
    assert locked is not None  # loans are never deleted
    return item, locked


async def return_loan(
    db: AsyncSession, actor: User, loan_id: uuid.UUID, data: LendingReturnIn
) -> LendingLoanOut:
    """The borrower, or a keeper on their behalf (audited). Already returned: no change (the
    second of two people pressing at once reads it returned)."""
    settings = await service.require_ledger(db, actor)
    item, loan = await _locked(db, actor, settings, loan_id)
    if loan.status == "returned":
        out = await _loan_out(db, loan, actor, settings)
        await db.commit()
        return out
    now = utcnow()
    loan.status = "returned"
    loan.returned_at = now
    loan.returned_by = actor.id
    loan.return_condition = data.condition
    loan.return_note = data.note
    loan.updated_at = now
    item.status = "available"
    item.current_loan_id = None
    by_keeper = actor.id != loan.borrower_id
    await service.record(
        db,
        item,
        actor,
        "returned",
        {"condition": data.condition, "by_keeper": by_keeper},
        loan_id=loan.id,
    )
    if by_keeper:
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="lending_loan.returned_by_keeper",
            target_type="lending_loan",
            target_id=loan.id,
            details={
                "item_id": str(item.id),
                "borrower_id": str(loan.borrower_id),
                "condition": data.condition,
            },
        )
    await service.emit(db, item_ids=[item.id])
    await db.commit()
    return await _loan_out(db, loan, actor, settings)


def _borrower_refusal(
    loan: LendingLoan, new: date, latest: date, settings: LendingSettings
) -> AppError | None:
    """Why the borrower may not move the due date to `new` (§6.5), or None."""
    if loan.permission_state == "denied":
        return conflict(
            "lending_permission_denied",
            "The teacher said they did not give permission: return the item",
        )
    if loan.extension_count >= settings.max_extensions:
        return conflict(
            "lending_extend_limit",
            "The loan cannot be extended again",
            {"max_extensions": settings.max_extensions},
        )
    if new <= loan.due_on:
        return _due_invalid("not_later", latest)
    if new > latest:
        return _due_invalid("too_long", latest)
    return None


async def extend(
    db: AsyncSession, actor: User, loan_id: uuid.UUID, data: LendingExtendIn
) -> LendingLoanOut:
    """The borrower: a later date up to today + the item's max_days, at most max_extensions
    times, not after the teacher's 「許可していない」. A keeper (on someone else's loan, or on
    their own beyond those limits): any date from today to 365 days ahead, not counted, recorded
    as due_changed and audited. The same date again: no change. 409 lending_loan_closed once
    returned."""
    settings = await service.require_ledger(db, actor)
    item, loan = await _locked(db, actor, settings, loan_id)
    if loan.status != "active":
        raise conflict("lending_loan_closed", "The loan was returned")
    new = data.due_on
    if new == loan.due_on:
        out = await _loan_out(db, loan, actor, settings)
        await db.commit()
        return out
    today = service.today_in(settings)
    category = await db.get(LendingCategory, item.category_id) if item.category_id else None
    _, max_days = service.effective(item, category, settings)
    refusal = (
        _borrower_refusal(loan, new, _plus(today, max_days), settings)
        if actor.id == loan.borrower_id
        else None
    )
    before = loan.due_on
    details = {"from": before.isoformat(), "to": new.isoformat()}
    if actor.id == loan.borrower_id and refusal is None:
        loan.extension_count += 1
        kind = "extended"
    elif access.can_keep(actor, settings):
        keeper_latest = _plus(today, KEEPER_MAX_DAYS)
        if new < today:
            raise _due_invalid("past", keeper_latest)
        if new > keeper_latest:
            raise _due_invalid("too_long", keeper_latest)
        kind = "due_changed"
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="lending_loan.due_changed_by_keeper",
            target_type="lending_loan",
            target_id=loan.id,
            details={"item_id": str(item.id), "borrower_id": str(loan.borrower_id), **details},
        )
    else:
        assert refusal is not None
        raise refusal
    loan.due_on = new
    loan.updated_at = utcnow()
    await service.record(db, item, actor, kind, details, loan_id=loan.id)
    await service.emit(db, item_ids=[item.id])
    await db.commit()
    return await _loan_out(db, loan, actor, settings)


# --- reading (§5.3) ---------------------------------------------------------------------------


async def _all(db: AsyncSession, stmt: Select[LendingLoan]) -> list[LendingLoan]:
    return list((await db.execute(stmt)).scalars().all())


async def list_loans(db: AsyncSession, actor: User, scope: LoanScope) -> list[LendingLoanOut]:
    """mine: my active loans by due date, then my last 50 returned ones (newest first). active:
    every active loan by due date. overdue (keepers): the active loans past due, the longest
    overdue first. approved: the loans naming me as the teacher, active or returned in the last
    14 days."""
    settings = await service.require_ledger(db, actor)
    active = select(LendingLoan).where(LendingLoan.status == "active")
    by_due = (LendingLoan.due_on, LendingLoan.borrowed_at, LendingLoan.id)
    returned = select(LendingLoan).where(LendingLoan.status == "returned")
    newest = (LendingLoan.returned_at.desc(), LendingLoan.id.desc())
    loans: list[LendingLoan]
    if scope == "mine":
        mine = LendingLoan.borrower_id == actor.id
        loans = await _all(db, active.where(mine).order_by(*by_due))
        loans += await _all(db, returned.where(mine).order_by(*newest).limit(MINE_RETURNED_LIMIT))
    elif scope == "active":
        loans = await _all(db, active.order_by(*by_due))
    elif scope == "overdue":
        if not access.can_keep(actor, settings):
            raise forbidden("lending_keeper_required", "Only equipment keepers can do this")
        today = service.today_in(settings)
        loans = await _all(db, active.where(LendingLoan.due_on < today).order_by(*by_due))
    else:
        named = LendingLoan.approver_id == actor.id
        since = utcnow() - timedelta(days=APPROVER_DAYS_AFTER_RETURN)
        loans = await _all(db, active.where(named).order_by(*by_due))
        loans += await _all(
            db,
            returned.where(named, LendingLoan.returned_at >= since).order_by(*newest),
        )
    return await _loan_outs(db, loans, actor, settings)


async def get_loan(db: AsyncSession, actor: User, loan_id: uuid.UUID) -> LendingLoanOut:
    settings = await service.require_ledger(db, actor)
    loan = await db.get(LendingLoan, loan_id)
    if loan is None:
        raise _loan_not_found()
    return await _loan_out(db, loan, actor, settings)
