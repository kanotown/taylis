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
