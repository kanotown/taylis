"""User profiles and account lookups. Account creation belongs to admin.service."""

import uuid
from datetime import datetime

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import conflict, not_found
from app.core.time import utcnow
from app.modules.users import repository as repo
from app.modules.users.events import USER_UPDATED, emit_user_event
from app.modules.users.models import User
from app.modules.users.schemas import UserUpdate


async def keyword_mentions(
    db: AsyncSession, body: str, candidate_ids: list[uuid.UUID]
) -> list[uuid.UUID]:
    """M12g: candidates whose notification keywords occur in `body` (case-insensitive)."""
    if not candidate_ids or not body:
        return []
    haystack = body.lower()
    hits: list[uuid.UUID] = []
    for user in await repo.with_keywords(db, candidate_ids):
        if any(word.lower() in haystack for word in user.notify_keywords or []):
            hits.append(user.id)
    return hits


async def get_users(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, User]:
    return {user.id: user for user in await repo.get_many(db, ids)}


async def get_user(
    db: AsyncSession, user_id: uuid.UUID, *, for_update: bool = False
) -> User | None:
    return await repo.get_user(db, user_id, for_update=for_update)


async def get_by_username(
    db: AsyncSession, username: str, *, for_update: bool = False
) -> User | None:
    return await repo.get_by_username(db, username, for_update=for_update)


async def require_user(db: AsyncSession, user_id: uuid.UUID) -> User:
    user = await get_user(db, user_id)
    if user is None:
        raise not_found("user_not_found", "User not found")
    return user


async def list_users(db: AsyncSession) -> list[User]:
    # Deactivated accounts remain visible so existing messages retain their authors.
    return await repo.list_users(db)


async def update_me(db: AsyncSession, user_id: uuid.UUID, data: UserUpdate) -> User:
    user = await require_user(db, user_id)
    if data.email is not None and await repo.email_taken(db, data.email, user.id):
        raise conflict("email_taken", "Email is already in use")
    if data.display_name is not None:
        user.display_name = data.display_name
    if "email" in data.model_fields_set:
        user.email = data.email
    if "title" in data.model_fields_set:
        user.title = (data.title or "").strip() or None
    # Custom status (M11d): text and emoji move together; clearing both drops the expiry.
    status_fields = {"status_text", "status_emoji", "status_expires_at"} & data.model_fields_set
    if status_fields:
        if "status_text" in status_fields:
            user.status_text = (data.status_text or "").strip() or None
        if "status_emoji" in status_fields:
            user.status_emoji = (data.status_emoji or "").strip() or None
        if "status_expires_at" in status_fields:
            user.status_expires_at = data.status_expires_at
        if user.status_text is None and user.status_emoji is None:
            user.status_expires_at = None
    # Do not disturb (M12c).
    if "dnd_until" in data.model_fields_set:
        user.dnd_until = data.dnd_until
    if "quiet_hours" in data.model_fields_set:
        hours = data.quiet_hours
        user.quiet_hours_start = hours.start_minutes if hours else None
        user.quiet_hours_end = hours.end_minutes if hours else None
        user.quiet_hours_days = hours.days if hours else None
        user.quiet_hours_tz = hours.tz if hours else None
    if "notify_keywords" in data.model_fields_set:
        user.notify_keywords = data.notify_keywords or None
    user.updated_at = utcnow()
    try:
        await db.flush()
        await emit_user_event(db, USER_UPDATED, user)
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise conflict("email_taken", "Email is already in use") from exc
    return user


def change_password_in_tx(user: User, password_hash: str, now: datetime) -> None:
    """Auth commits this change together with revoking the user's other sessions."""
    user.password_hash = password_hash
    user.must_change_password = False
    user.updated_at = now
