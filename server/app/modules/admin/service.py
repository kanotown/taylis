"""Administrator operations on user accounts (SECURITY.md §2.5)."""

import logging
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import conflict, not_found
from app.core.security import generate_temporary_password, hash_password
from app.core.time import utcnow
from app.modules.admin.schemas import AdminUserCreate, AdminUserUpdate
from app.modules.attachments.blobstore import BlobStore
from app.modules.audit import service as audit
from app.modules.auth import repository as auth_repo
from app.modules.auth import service as auth
from app.modules.groups import service as groups
from app.modules.lab import service as lab
from app.modules.totp import service as totp
from app.modules.users.events import (
    USER_CREATED,
    USER_DEACTIVATED,
    USER_UPDATED,
    emit_user_event,
)
from app.modules.users.models import User

log = logging.getLogger("app.admin")


async def _get_user(db: AsyncSession, user_id: uuid.UUID) -> User:
    user = await db.get(User, user_id)
    if user is None:
        raise not_found("user_not_found", "User not found")
    return user


async def _ensure_unique(db: AsyncSession, username: str, email: str | None) -> None:
    taken = await db.execute(select(User.id).where(User.username == username))
    if taken.scalar_one_or_none() is not None:
        raise conflict("username_taken", "Username is already in use")
    if await groups.name_in_use(db, username):  # `@name` must stay unambiguous (M12k)
        raise conflict("username_taken", "A group has that name")
    if email is not None:
        taken = await db.execute(select(User.id).where(User.email == email))
        if taken.scalar_one_or_none() is not None:
            raise conflict("email_taken", "Email is already in use")


async def create_user_in_tx(
    db: AsyncSession,
    data: AdminUserCreate,
    *,
    password_hash: str,
    must_change_password: bool,
    actor_id: uuid.UUID | None,
    details: dict[str, Any] | None = None,
) -> User:
    """Insert an account, its user.created event and the audit row; the caller commits.

    Raises ``conflict`` when the username or e-mail is taken; a concurrent insert surfaces as
    ``IntegrityError`` at commit time, which the caller maps to the same 409.
    """
    await _ensure_unique(db, data.username, data.email)
    user = User(
        username=data.username,
        display_name=data.display_name,
        email=data.email,
        password_hash=password_hash,
        role=data.role,
        must_change_password=must_change_password,
    )
    db.add(user)
    await db.flush()
    await emit_user_event(db, USER_CREATED, user)
    await audit.record_in_tx(
        db,
        actor_id=actor_id,
        action="admin.user_created",
        target_type="user",
        target_id=user.id,
        details={"username": user.username, "role": user.role, **(details or {})},
    )
    return user


async def create_bot_in_tx(
    db: AsyncSession, *, actor_id: uuid.UUID, username: str, display_name: str
) -> User:
    """A `bot` account for an incoming webhook (M13a): it never logs in; the caller commits."""
    await _ensure_unique(db, username, None)
    user = User(
        username=username,
        display_name=display_name,
        password_hash=await hash_password(generate_temporary_password(32)),
        role="bot",
        must_change_password=False,
    )
    db.add(user)
    await db.flush()
    await emit_user_event(db, USER_CREATED, user)
    await audit.record_in_tx(
        db,
        actor_id=actor_id,
        action="admin.user_created",
        target_type="user",
        target_id=user.id,
        details={"username": user.username, "role": user.role},
    )
    return user


async def deactivate_bot_in_tx(db: AsyncSession, user_id: uuid.UUID) -> None:
    user = await _get_user(db, user_id)
    if user.is_active:
        user.deactivated_at = utcnow()
        user.updated_at = user.deactivated_at
        await db.flush()
        await emit_user_event(db, USER_DEACTIVATED, user)


async def create_user(
    db: AsyncSession,
    data: AdminUserCreate,
    *,
    password: str | None = None,
    must_change_password: bool = True,
    actor: User | None = None,
) -> tuple[User, str]:
    """Create an account. Without ``password`` a temporary one is generated and returned once."""
    secret = password or generate_temporary_password()
    try:
        user = await create_user_in_tx(
            db,
            data,
            password_hash=await hash_password(secret),
            must_change_password=must_change_password,
            actor_id=actor.id if actor else None,
        )
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
    await db.flush()
    await emit_user_event(db, USER_DEACTIVATED if data.deactivated is True else USER_UPDATED, user)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="admin.user_updated",
        target_type="user",
        target_id=user.id,
        details=data.model_dump(exclude_none=True, mode="json"),
    )
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
    await audit.record_in_tx(
        db, actor_id=actor.id, action="admin.password_reset", target_type="user", target_id=user.id
    )
    await db.commit()
    return temporary


async def revoke_sessions(db: AsyncSession, actor: User, user_id: uuid.UUID) -> int:
    user = await _get_user(db, user_id)
    count = await auth.revoke_all_sessions(db, user.id, "admin", utcnow())
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="admin.sessions_revoked",
        target_type="user",
        target_id=user.id,
        details={"count": count},
    )
    await db.commit()
    return count


async def anonymize_user(
    db: AsyncSession, actor: User | None, user_id: uuid.UUID, blobs: BlobStore | None = None
) -> User:
    """Erase the identity (name, e-mail, credentials, devices, profile, picture, second factor)
    and end all sessions.

    Messages stay (the history of a channel is the team's), attributed to a generic name.
    The audit row carries only the id, on purpose.
    """
    user = await _get_user(db, user_id)
    if actor is not None and user.id == actor.id:
        raise conflict("cannot_modify_self", "Administrators cannot anonymize their own account")
    now = utcnow()
    user.username = f"deleted-{user.id.hex[:12]}"
    user.display_name = "退会したユーザー"
    user.email = None
    # Everything else that describes the person goes too (profile, status, private keywords).
    user.title = None
    user.status_text = user.status_emoji = None
    user.status_expires_at = None
    user.notify_keywords = None
    user.dnd_until = None
    user.quiet_hours_start = user.quiet_hours_end = None
    user.quiet_hours_days = None
    user.quiet_hours_tz = None
    avatar_key = user.avatar_key
    user.avatar_key = None
    user.avatar_updated_at = None
    user.password_hash = await hash_password(generate_temporary_password())
    user.must_change_password = True
    user.deactivated_at = user.deactivated_at or now
    user.updated_at = now
    await db.flush()
    await auth.revoke_all_sessions(db, user.id, "anonymized", now)
    await auth_repo.clear_push_tokens(db, user.id)
    await totp.remove_in_tx(db, user.id)
    await lab.forget_in_tx(db, actor, user.id)  # the roster line, research topic included (M23)
    await emit_user_event(db, USER_DEACTIVATED, user)
    await audit.record_in_tx(
        db,
        actor_id=actor.id if actor else None,
        action="admin.user_anonymized",
        target_type="user",
        target_id=user.id,
    )
    await db.commit()
    if avatar_key and blobs is not None:
        try:
            await blobs.delete(avatar_key)
        except Exception:  # the row no longer points at it; a stray object is harmless
            log.warning("could not delete the avatar of an anonymized user")
    return user
