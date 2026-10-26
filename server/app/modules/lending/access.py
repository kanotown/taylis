"""Who may use and keep the 備品 (equipment) ledger (docs/LENDING.md §3). Plain rules on loaded
rows, in one place: the service, the bootstrap, the attachments' read check and (from L3) the
activity list, the WebSocket audience and the push planner use the same ones."""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.roles import PERSON_ROLES, has_capability
from app.modules.lending.models import LendingItem, LendingSettings
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


async def can_read_photo(db: AsyncSession, actor: User, item_id: uuid.UUID) -> bool:
    """For attachments.get_for_access (handed over by main.py): an item's photo is read by whoever
    sees the ledger; for anyone else (a guest, or while the feature is off) it does not exist."""
    settings = await db.get(LendingSettings, True)
    if not may_see_ledger(actor, settings):
        return False
    return await db.get(LendingItem, item_id) is not None
