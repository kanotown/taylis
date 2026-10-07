"""Administrator operations on user accounts (SECURITY.md §2.5)."""

import logging
import uuid
from collections.abc import Sequence
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import conflict, forbidden, not_found
from app.core.roles import has_capability
from app.core.security import generate_temporary_password, hash_password
from app.core.time import utcnow
from app.modules.admin.schemas import AdminUserCreate, AdminUserUpdate
from app.modules.attachments.blobstore import BlobStore
from app.modules.attendance import service as attendance
from app.modules.audit import service as audit
from app.modules.auth import repository as auth_repo
from app.modules.auth import service as auth
from app.modules.groups import service as groups
from app.modules.lab import service as lab
from app.modules.moderation.models import UserBlock
from app.modules.sso import repository as sso_repo
from app.modules.totp import service as totp
from app.modules.users import service as users
from app.modules.users import username as usernames
from app.modules.users.events import (
    USER_CREATED,
    USER_DEACTIVATED,
    USER_UPDATED,
    emit_user_event,
)
from app.modules.users.models import User
from app.modules.wiki import service as wiki
from app.modules.workspace import default_channels

log = logging.getLogger("app.admin")

# What an anonymized account is called (M10; M104 account deletion).
ANONYMIZED_DISPLAY_NAME = "退会したユーザー"


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
    password_hash: str | None,
    must_change_password: bool,
    actor_id: uuid.UUID | None,
    details: dict[str, Any] | None = None,
    join_default_channels: bool = True,
    legacy_default_channels: Sequence[str] = (),
) -> User:
    """Insert an account, its user.created event and the audit row; the caller commits.

    Raises ``conflict`` when the username or e-mail is taken; a concurrent insert surfaces as
    ``IntegrityError`` at commit time, which the caller maps to the same 409. ``password_hash``
    is None for an account made by Google sign-in (M48): it cannot log in with a password.

    M90 (docs/MEMBERSHIP.md §6): every path that makes a person's account comes through here, so
    this is the one place a non-guest joins the default channels (the administrator's list, else
    ``legacy_default_channels`` = SSO_DEFAULT_CHANNELS, passed only by Google sign-in). Imports
    pass ``join_default_channels=False``: their memberships come from the source.
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
    if join_default_channels:
        await default_channels.join_in_tx(db, user, legacy_names=legacy_default_channels)
    return user


async def create_bot_in_tx(
    db: AsyncSession,
    *,
    actor_id: uuid.UUID,
    username: str,
    display_name: str,
    bot_kind: str | None = None,
) -> User:
    """A `bot` account for an incoming webhook (M13a): it never logs in; the caller commits.
    `bot_kind` (M98): "feed" for a channel's feed bot (users.bot_kind)."""
    await _ensure_unique(db, username, None)
    user = User(
        username=username,
        display_name=display_name,
        password_hash=await hash_password(generate_temporary_password(32)),
        role="bot",
        bot_kind=bot_kind,
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


async def update_bot_in_tx(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    display_name: str | None = None,
    bot_kind: str | None = None,
    reactivate: bool = False,
) -> User:
    """M98: a `bot` account's name, kind or reactivation, from the module that owns the bot (the
    channel feeds); one user.updated event when something changed. The caller commits."""
    user = await _get_user(db, user_id)
    changed = False
    if display_name is not None and display_name != user.display_name:
        user.display_name = display_name
        changed = True
    if bot_kind is not None and bot_kind != user.bot_kind:
        user.bot_kind = bot_kind
        changed = True
    if reactivate and not user.is_active:
        user.deactivated_at = None
        changed = True
    if changed:
        user.updated_at = utcnow()
        await db.flush()
        await emit_user_event(db, USER_UPDATED, user)
    return user


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
    if not has_capability(actor, "users.manage"):
        # M142 (docs/ROLES.md §5): a manager edits only the display name and title of members
        # and guests; roles, deactivation and usernames stay with administrators.
        if data.role is not None or data.deactivated is not None or data.username is not None:
            raise forbidden("admin_required", "Only an administrator changes roles and accounts")
        if user_id == actor.id:
            raise conflict("cannot_modify_self", "Change your own profile via /users/me")
        target = await _get_user(db, user_id)
        if target.role not in ("member", "guest"):
            raise forbidden("admin_required", "Only an administrator edits this account")
    if user_id == actor.id and (data.role is not None or data.deactivated is not None):
        raise conflict("cannot_modify_self", "Administrators cannot change their own account")
    lowers_admins = data.role not in (None, "admin") or data.deactivated is True
    if lowers_admins:
        await users.lock_admin_set(db)  # before the row lock (review v0.1.37 #1)
        user = await users.get_user(db, user_id, for_update=True)
        if user is None:
            raise not_found("user_not_found", "User not found")
        if user.is_admin and user.is_active:
            await users.ensure_admin_remains(db, losing=user.id)
    else:
        user = await _get_user(db, user_id)
    if data.username is not None:
        # M96: any account, bots included, without the self-service limit (users/username.py).
        locked = await db.get(User, user_id, with_for_update=True, populate_existing=True)
        await usernames.rename_in_tx(db, locked or user, data.username, actor=actor)
    now = utcnow()
    if data.display_name is not None:
        user.display_name = data.display_name.strip() or user.display_name
    if "title" in data.model_fields_set:
        user.title = (data.title or "").strip() or None
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
        details=data.model_dump(exclude_unset=True, mode="json"),
    )
    try:
        await db.commit()
    except IntegrityError as exc:  # M96: the new username was taken meanwhile
        await db.rollback()
        if usernames.is_username_conflict(exc):
            raise conflict("username_taken", "Username is already in use") from exc
        raise
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


async def anonymize_in_tx(
    db: AsyncSession,
    user: User,
    *,
    admin: User | None,
    actor_id: uuid.UUID | None,
    action: str,
) -> str | None:
    """Erase the identity (name, e-mail, credentials, devices, profile, picture, second factor,
    private block list) and end all sessions, in the caller's transaction; returns the picture's
    key for the caller to delete after the commit.

    Messages stay (the history of a channel is the team's), attributed to a generic name.
    The audit row (`action`, by `actor_id`) carries only the id, on purpose. `admin` is the
    administrator doing it (None for the person themselves or the CLI). Shared by the
    administrator's action (M10) and the person's own account deletion (M104,
    docs/MODERATION.md §2).
    """
    now = utcnow()
    user.username = f"{usernames.ANONYMIZED_PREFIX}{user.id.hex[:12]}"
    user.display_name = ANONYMIZED_DISPLAY_NAME
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
    await sso_repo.forget_user_in_tx(db, user.id)  # M48: Google no longer signs in as it
    await lab.forget_in_tx(db, admin, user.id)  # the roster line, research topic included (M23)
    await attendance.forget_in_tx(db, user.id)  # M140: 在室状況 row, log, own states, deliveries
    # M120 (docs/WIKI.md §4.5): pages shared with the person by name no longer name them.
    await wiki.remove_user_grants_in_tx(db, user.id)
    # M104: the person's own block list is theirs; blocks of them by others stay (harmless).
    await db.execute(delete(UserBlock).where(UserBlock.blocker_id == user.id))
    await emit_user_event(db, USER_DEACTIVATED, user)
    await audit.record_in_tx(
        db, actor_id=actor_id, action=action, target_type="user", target_id=user.id
    )
    return avatar_key


async def delete_avatar_after_commit(blobs: BlobStore | None, avatar_key: str | None) -> None:
    if avatar_key and blobs is not None:
        try:
            await blobs.delete(avatar_key)
        except Exception:  # the row no longer points at it; a stray object is harmless
            log.warning("could not delete the avatar of an anonymized user")


async def anonymize_user(
    db: AsyncSession, actor: User | None, user_id: uuid.UUID, blobs: BlobStore | None = None
) -> User:
    """The administrator's 「削除 (匿名化)」 (M10): anonymize_in_tx for someone else."""
    if actor is not None and user_id == actor.id:
        raise conflict("cannot_modify_self", "Administrators cannot anonymize their own account")
    await users.lock_admin_set(db)  # before the row lock (review v0.1.37 #1)
    user = await users.get_user(db, user_id, for_update=True)
    if user is None:
        raise not_found("user_not_found", "User not found")
    if user.is_admin and user.is_active:
        await users.ensure_admin_remains(db, losing=user.id)
    avatar_key = await anonymize_in_tx(
        db, user, admin=actor, actor_id=actor.id if actor else None, action="admin.user_anonymized"
    )
    await db.commit()
    await delete_avatar_after_commit(blobs, avatar_key)
    return user
