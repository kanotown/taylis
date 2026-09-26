"""Administrator operations on user accounts (SECURITY.md §2.5)."""

import uuid

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import conflict, not_found
from app.core.security import generate_temporary_password, hash_password
from app.core.time import utcnow
from app.modules.admin.schemas import AdminUserCreate, AdminUserUpdate
from app.modules.auth import service as auth
from app.modules.users.models import User


async def _get_user(db: AsyncSession, user_id: uuid.UUID) -> User:
    user = await db.get(User, user_id)
    if user is None:
        raise not_found("user_not_found", "User not found")
    return user


async def _ensure_unique(db: AsyncSession, username: str, email: str | None) -> None:
    taken = await db.execute(select(User.id).where(User.username == username))
    if taken.scalar_one_or_none() is not None:
        raise conflict("username_taken", "Username is already in use")
    if email is not None:
        taken = await db.execute(select(User.id).where(User.email == email))
        if taken.scalar_one_or_none() is not None:
            raise conflict("email_taken", "Email is already in use")


async def create_user(
    db: AsyncSession,
    data: AdminUserCreate,
    *,
    password: str | None = None,
    must_change_password: bool = True,
) -> tuple[User, str]:
    """Create an account. Without ``password`` a temporary one is generated and returned once."""
    await _ensure_unique(db, data.username, data.email)
    secret = password or generate_temporary_password()
    user = User(
        username=data.username,
        display_name=data.display_name,
        email=data.email,
        password_hash=await hash_password(secret),
        role=data.role,
        must_change_password=must_change_password,
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise conflict("username_taken", "Username or email is already in use") from exc
    return user, secret


async def list_users(db: AsyncSession) -> list[User]:
    result = await db.execute(select(User).order_by(User.username))
    return list(result.scalars().all())


async def update_user(
    db: AsyncSession, actor: User, user_id: uuid.UUID, data: AdminUserUpdate
) -> User:
    user = await _get_user(db, user_id)
    if user.id == actor.id and (data.role is not None or data.deactivated is not None):
        raise conflict("cannot_modify_self", "Administrators cannot change their own account")
    now = utcnow()
    if data.role is not None:
        user.role = data.role
    if data.deactivated is True and user.is_active:
        user.deactivated_at = now
        await auth.revoke_all_sessions(db, user.id, "admin", now)
    elif data.deactivated is False:
        user.deactivated_at = None
    user.updated_at = now
    await db.commit()
    return user


async def reset_password(db: AsyncSession, actor: User, user_id: uuid.UUID) -> str:
    """Issue a new temporary password, force a change at next login and end all sessions."""
    user = await _get_user(db, user_id)
    if user.id == actor.id:
        raise conflict("cannot_modify_self", "Change your own password via /users/me/password")
    temporary = generate_temporary_password()
    user.password_hash = await hash_password(temporary)
    user.must_change_password = True
    now = utcnow()
    user.updated_at = now
    await auth.revoke_all_sessions(db, user.id, "admin", now)
    await db.commit()
    return temporary


async def revoke_sessions(db: AsyncSession, user_id: uuid.UUID) -> int:
    user = await _get_user(db, user_id)
    count = await auth.revoke_all_sessions(db, user.id, "admin", utcnow())
    await db.commit()
    return count
