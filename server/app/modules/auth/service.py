"""Device-bound authentication, token rotation and session revocation (SECURITY.md §2)."""

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, not_found, unauthorized
from app.core.security import (
    create_access_token,
    decode_access_token,
    generate_refresh_token,
    hash_password,
    hash_token,
    verify_password,
)
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.auth import repository as repo
from app.modules.auth.models import Device, UserSession
from app.modules.auth.schemas import (
    DeviceOut,
    DeviceUpdate,
    LoginRequest,
    PasswordChange,
    SessionOut,
    TokenResponse,
    to_device_out,
    to_session_out,
)
from app.modules.users import service as users
from app.modules.users.models import User
from app.modules.users.schemas import to_user_me

log = logging.getLogger("app.auth")


@dataclass(frozen=True)
class AuthContext:
    user: User
    session: UserSession


def _require_valid(session: UserSession, user: User | None, now: datetime) -> None:
    if session.revoked_at is not None or user is None or not user.is_active:
        raise unauthorized("session_revoked", "Session revoked")
    if session.expires_at <= now:
        raise unauthorized("session_expired", "Session expired")


async def authenticate(db: AsyncSession, token: str, settings: Settings) -> AuthContext:
    claims = decode_access_token(token, settings.secret_key)
    session = await repo.get_session(db, claims.session_id)
    if session is None or session.user_id != claims.user_id:
        raise unauthorized("invalid_token", "Invalid access token")
    user = await users.get_user(db, session.user_id)
    _require_valid(session, user, utcnow())
    assert user is not None
    return AuthContext(user=user, session=session)


def _token_response(
    user: User,
    session: UserSession,
    device: Device,
    refresh_token: str,
    settings: Settings,
    now: datetime,
) -> TokenResponse:
    return TokenResponse(
        access_token=create_access_token(
            user_id=user.id,
            session_id=session.id,
            secret=settings.secret_key,
            ttl_seconds=settings.access_token_ttl_seconds,
            now=now,
        ),
        refresh_token=refresh_token,
        expires_in=settings.access_token_ttl_seconds,
        session_id=session.id,
        device=to_device_out(device),
        user=to_user_me(user),
    )


async def login(
    db: AsyncSession, data: LoginRequest, settings: Settings, ip: str | None
) -> TokenResponse:
    # All mutations lock user before sessions, so login cannot race a password reset.
    user = await users.get_by_username(db, data.username, for_update=True)
    valid_password = await verify_password(user.password_hash if user else None, data.password)
    if not valid_password or user is None or not user.is_active:
        log.warning("login failed", extra={"ip": ip})
        raise unauthorized("invalid_credentials", "Invalid username or password")
    now = utcnow()
    device = Device(
        user_id=user.id,
        platform=data.device.platform,
        device_name=data.device.device_name,
        app_version=data.device.app_version,
        last_seen_at=now,
        created_at=now,
        updated_at=now,
    )
    db.add(device)
    await db.flush()
    refresh_token = generate_refresh_token()
    session = UserSession(
        user_id=user.id,
        device_id=device.id,
        refresh_token_hash=hash_token(refresh_token),
        last_ip=ip,
        created_at=now,
        last_used_at=now,
        expires_at=now
        + timedelta(days=min(settings.refresh_token_ttl_days, settings.refresh_token_max_days)),
    )
    db.add(session)
    await db.commit()
    return _token_response(user, session, device, refresh_token, settings, now)


async def refresh(
    db: AsyncSession, token: str, settings: Settings, ip: str | None
) -> TokenResponse:
    token_hash = hash_token(token)
    candidate = await repo.get_by_refresh_hash(db, token_hash)
    if candidate is None:
        raise unauthorized("invalid_token", "Invalid refresh token")
    user = await users.get_user(db, candidate.user_id, for_update=True)
    session = await repo.get_session(db, candidate.id, for_update=True)
    if session is None:
        raise unauthorized("invalid_token", "Invalid refresh token")
    now = utcnow()
    _require_valid(session, user, now)
    assert user is not None
    # Another refresh may have rotated while we waited for the locks.
    if token_hash != session.refresh_token_hash:
        if token_hash != session.prev_token_hash:
            raise unauthorized("invalid_token", "Invalid refresh token")
        if session.rotated_at is None or now - session.rotated_at > timedelta(
            seconds=settings.refresh_grace_seconds
        ):
            await repo.revoke_sessions(db, user.id, "reuse_detected", now, session_id=session.id)
            # Persist revocation before the error response rolls back the request transaction.
            await db.commit()
            log.warning(
                "refresh token reuse detected",
                extra={"user_id": str(user.id), "session_id": str(session.id)},
            )
            raise unauthorized("session_revoked", "Session revoked")
    expires_at = min(
        now + timedelta(days=settings.refresh_token_ttl_days),
        session.created_at + timedelta(days=settings.refresh_token_max_days),
    )
    if expires_at <= now:
        raise unauthorized("session_expired", "Session expired")
    device = await _require_device(db, session)
    refresh_token = generate_refresh_token()
    session.prev_token_hash = session.refresh_token_hash
    session.refresh_token_hash = hash_token(refresh_token)
    session.rotated_at = now
    session.last_used_at = now
    session.last_ip = ip
    session.expires_at = expires_at
    device.last_seen_at = now
    device.updated_at = now
    await db.commit()
    return _token_response(user, session, device, refresh_token, settings, now)


async def _lock_current(db: AsyncSession, context: AuthContext) -> AuthContext:
    user = await users.get_user(db, context.user.id, for_update=True)
    session = await repo.get_session(db, context.session.id, for_update=True)
    if session is None:
        raise unauthorized("invalid_token", "Invalid session")
    _require_valid(session, user, utcnow())
    assert user is not None
    return AuthContext(user=user, session=session)


async def _require_device(db: AsyncSession, session: UserSession) -> Device:
    device = await repo.get_device(db, session.device_id)
    if device is None or device.user_id != session.user_id or not device.enabled:
        raise unauthorized("session_revoked", "Session revoked")
    return device


async def logout(db: AsyncSession, context: AuthContext) -> None:
    context = await _lock_current(db, context)
    await repo.revoke_sessions(
        db, context.user.id, "logout", utcnow(), session_id=context.session.id
    )
    await db.commit()


async def list_sessions(db: AsyncSession, context: AuthContext) -> list[SessionOut]:
    return [
        to_session_out(session, device, context.session.id)
        for session, device in await repo.list_sessions(db, context.user.id, utcnow())
    ]


async def revoke_session(db: AsyncSession, context: AuthContext, session_id: uuid.UUID) -> None:
    context = await _lock_current(db, context)
    session = await repo.get_session(db, session_id)
    if session is None or session.user_id != context.user.id:
        raise not_found("session_not_found", "Session not found")
    await repo.revoke_sessions(db, context.user.id, "logout", utcnow(), session_id=session.id)
    await db.commit()


async def update_device(db: AsyncSession, context: AuthContext, data: DeviceUpdate) -> DeviceOut:
    context = await _lock_current(db, context)
    device = await _require_device(db, context.session)
    if "device_name" in data.model_fields_set:
        device.device_name = data.device_name
    if "app_version" in data.model_fields_set:
        device.app_version = data.app_version
    device.last_seen_at = utcnow()
    device.updated_at = device.last_seen_at
    await db.commit()
    return to_device_out(device)


async def change_password(
    db: AsyncSession, context: AuthContext, data: PasswordChange, settings: Settings
) -> None:
    if len(data.new_password) < settings.password_min_length:
        raise AppError(
            422,
            "password_too_short",
            f"Password must be at least {settings.password_min_length} characters",
            details={"min_length": settings.password_min_length},
        )
    context = await _lock_current(db, context)
    if not await verify_password(context.user.password_hash, data.current_password):
        raise unauthorized("invalid_credentials", "Invalid current password")
    password_hash = await hash_password(data.new_password)
    now = utcnow()
    users.change_password_in_tx(context.user, password_hash, now)
    await repo.revoke_sessions(
        db, context.user.id, "password_changed", now, except_session_id=context.session.id
    )
    await db.commit()


async def revoke_all_sessions(
    db: AsyncSession, user_id: uuid.UUID, reason: str, now: datetime
) -> int:
    """Revoke all unrevoked sessions and disable their devices; the caller commits."""
    await users.get_user(db, user_id, for_update=True)
    return await repo.revoke_sessions(db, user_id, reason, now)
