"""Changing a username (M96, DATA_MODEL.md users「ユーザー名の変更」, SECURITY.md §2.9).

History is safe: mentions are stored as `<@id>`, Google sign-in matches by address and imports by
import_refs. Password sign-in, `@name` completion and `from:@name` use the new name at once; the
old one is free for anyone right away (the audit row keeps who had it).

Not in users.service: this checks group names and renames the times channel, and both of those
modules depend on users.
"""

import uuid
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, conflict
from app.core.time import utcnow
from app.modules.audit import service as audit
from app.modules.audit.models import AuditLog
from app.modules.channels import service as channels
from app.modules.groups import service as groups
from app.modules.groups.schemas import RESERVED_NAMES
from app.modules.users.models import User

AUDIT_ACTION = "user.username_changed"
# Renaming yourself: 3 times in any 24 hours (administrators are not limited).
SELF_RENAMES_PER_WINDOW = 3
SELF_RENAME_WINDOW = timedelta(hours=24)
# The anonymized accounts' prefix (admin.anonymize_user): nobody else may look like one.
ANONYMIZED_PREFIX = "deleted-"


def is_reserved(username: str) -> bool:
    """@here / @channel / @everyone / @all / @group and the anonymized accounts' names."""
    name = username.lower()
    return name in RESERVED_NAMES or name.startswith(ANONYMIZED_PREFIX)


async def _self_renames_since(
    db: AsyncSession, user_id: uuid.UUID, since: datetime
) -> list[datetime]:
    stmt = (
        select(AuditLog.at)
        .where(
            AuditLog.action == AUDIT_ACTION,
            AuditLog.target_type == "user",
            AuditLog.target_id == str(user_id),
            AuditLog.actor_id == user_id,
            AuditLog.at > since,
        )
        .order_by(AuditLog.at)
    )
    return list((await db.scalars(stmt)).all())


def _limited(retry_after_seconds: int) -> AppError:
    return AppError(
        429,
        "username_change_limited",
        f"A username can be changed {SELF_RENAMES_PER_WINDOW} times in 24 hours",
        details={
            "retry_after_seconds": retry_after_seconds,
            "limit": SELF_RENAMES_PER_WINDOW,
            "window_hours": int(SELF_RENAME_WINDOW.total_seconds() // 3600),
        },
        headers={"Retry-After": str(retry_after_seconds)},
    )


async def rename_in_tx(db: AsyncSession, user: User, new_username: str, *, actor: User) -> bool:
    """Give `user` the (pattern-checked) `new_username`; False when it already is theirs.

    `user` should be locked (SELECT … FOR UPDATE) so that two renames of one person cannot both
    pass the limit. Writes the audit row and renames a times channel made from the old name; the
    caller emits user.updated and commits (a concurrent taker surfaces as IntegrityError on
    uq_users_username there). Refusals: 409 `username_reserved`, 409 `username_taken`, 429
    `username_change_limited` (renaming yourself only, not as an administrator of others).
    """
    old = user.username
    if new_username == old:
        return False
    if is_reserved(new_username):
        raise conflict("username_reserved", "That name is reserved")
    taken = await db.scalar(
        select(User.id).where(User.username == new_username, User.id != user.id)
    )
    if taken is not None:
        raise conflict("username_taken", "Username is already in use")
    if await groups.name_in_use(db, new_username):  # `@name` must stay unambiguous (M12k)
        raise conflict("username_taken", "A group has that name")
    by_self = actor.id == user.id
    if by_self and not actor.is_admin:
        now = utcnow()
        recent = await _self_renames_since(db, user.id, now - SELF_RENAME_WINDOW)
        if len(recent) >= SELF_RENAMES_PER_WINDOW:
            oldest = recent[len(recent) - SELF_RENAMES_PER_WINDOW]
            wait = oldest + SELF_RENAME_WINDOW - now
            raise _limited(max(1, int(wait.total_seconds()) + 1))
    user.username = new_username
    user.updated_at = utcnow()
    await db.flush()
    details: dict[str, object] = {
        "from": old,
        "to": new_username,
        "by": "self" if by_self else "admin",
    }
    times = await channels.rename_times_for_username_in_tx(db, user.id, old, new_username)
    if times is not None:
        details["times_channel"] = {"from": times[0], "to": times[1]}
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action=AUDIT_ACTION,
        target_type="user",
        target_id=user.id,
        details=details,
    )
    return True
