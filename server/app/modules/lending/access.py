"""Who may use and keep the 備品 (equipment) ledger (docs/LENDING.md §3). Plain rules on loaded
rows, in one place: the service, the bootstrap, the attachments' read check, the activity list
(L3), the WebSocket audience and the push planner use the same ones."""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.roles import PERSON_ROLES, has_capability
from app.modules.lending.models import LendingItem, LendingLoan, LendingNotice, LendingSettings
from app.modules.users.models import User


def is_person(user: User) -> bool:
    """Admins, managers and members who are active: guests and bots never see the feature
    (§3.3)."""
    return user.is_active and user.role in PERSON_ROLES


def is_enabled(settings: LendingSettings | None) -> bool:
    return settings is not None and settings.enabled


def can_manage(user: User) -> bool:
    """`lending.manage` (ROLES.md §2): the switch, the keepers and the defaults."""
    return is_person(user) and has_capability(user, "lending.manage")


def can_keep(user: User, settings: LendingSettings | None) -> bool:
    """備品係 (§3.1 K1): anyone with `lending.manage`, or a person on `keeper_ids`."""
    if not is_person(user):
        return False
    if has_capability(user, "lending.manage"):
        return True
    return settings is not None and user.id in settings.keeper_ids


def may_see_ledger(user: User, settings: LendingSettings | None) -> bool:
    """The ledger (items, categories, photos, history): every person while the feature is on."""
    return is_person(user) and is_enabled(settings)


def sees_loan_details(user: User, loan: LendingLoan, settings: LendingSettings | None) -> bool:
    """A loan's purpose, permission and return note (§3.2): the borrower, the teacher named on
    it, the keepers and the administrators."""
    if not is_person(user):
        return False
    return user.id in (loan.borrower_id, loan.approver_id) or can_keep(user, settings)


def may_return(user: User, loan: LendingLoan, settings: LendingSettings | None) -> bool:
    """The borrower, or a keeper recording it on their behalf."""
    return is_person(user) and (user.id == loan.borrower_id or can_keep(user, settings))


async def can_read_photo(db: AsyncSession, actor: User, item_id: uuid.UUID) -> bool:
    """For attachments.get_for_access (handed over by main.py): an item's photo is read by whoever
    sees the ledger; for anyone else (a guest, or while the feature is off) it does not exist."""
    settings = await db.get(LendingSettings, True)
    if not may_see_ledger(actor, settings):
        return False
    return await db.get(LendingItem, item_id) is not None


def may_read(user: User, notice: LendingNotice, settings: LendingSettings | None) -> bool:
    """Whether `user` may see this notice of theirs now (§8.3): while they see the ledger; a
    keepers' notice (names, items and days of others) only while they keep the equipment."""
    if notice.user_id != user.id or not may_see_ledger(user, settings):
        return False
    return notice.role != "keeper" or can_keep(user, settings)


async def may_deliver(db: AsyncSession, notice_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    """For the WebSocket audience and the push planner: the notice still exists, its reader may
    read it now, and a borrower's reminder (`due:<loan>:<due_on>:<n>`) is still about an active
    loan due that day (a return or an extension made it moot)."""
    notice = await db.get(LendingNotice, notice_id, populate_existing=True)
    if notice is None:
        return False
    user = await db.get(User, user_id, populate_existing=True)
    settings = await db.get(LendingSettings, True, populate_existing=True)
    if user is None or not may_read(user, notice, settings):
        return False
    if notice.key.startswith("due:") and notice.loan_id is not None:
        loan = await db.get(LendingLoan, notice.loan_id, populate_existing=True)
        due_on = notice.key.split(":")[2]
        return loan is not None and loan.status == "active" and loan.due_on.isoformat() == due_on
    return True
