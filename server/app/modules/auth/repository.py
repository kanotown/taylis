import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Exists, delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.outbox import write_outbox
from app.modules.auth.events import SESSION_REVOKED, SessionRevokedData
from app.modules.auth.models import Device, UserSession


async def get_session(
    db: AsyncSession, session_id: uuid.UUID, *, for_update: bool = False
) -> UserSession | None:
    stmt = select(UserSession).where(UserSession.id == session_id)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_by_refresh_hash(db: AsyncSession, token_hash: bytes) -> UserSession | None:
    stmt = select(UserSession).where(
        or_(UserSession.refresh_token_hash == token_hash, UserSession.prev_token_hash == token_hash)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_device(db: AsyncSession, device_id: uuid.UUID) -> Device | None:
    return await db.get(Device, device_id)


async def release_push_token(
    db: AsyncSession, provider: str, token: str, *, except_device_id: uuid.UUID
) -> None:
    """A push token belongs to one device row; clear it wherever else it is registered."""
    await db.execute(
        update(Device)
        .where(
            Device.push_provider == provider,
            Device.push_token == token,
            Device.id != except_device_id,
        )
        .values(push_token=None)
        .execution_options(synchronize_session=False)
    )


async def list_sessions(
    db: AsyncSession, user_id: uuid.UUID, now: datetime
) -> list[tuple[UserSession, Device]]:
    stmt = (
        select(UserSession, Device)
        .join(Device, Device.id == UserSession.device_id)
        .where(
            UserSession.user_id == user_id,
            UserSession.revoked_at.is_(None),
            UserSession.expires_at > now,
        )
        .order_by(UserSession.created_at.desc(), UserSession.id.desc())
    )
    return [(row[0], row[1]) for row in (await db.execute(stmt)).all()]


async def revoke_sessions(
    db: AsyncSession,
    user_id: uuid.UUID,
    reason: str,
    now: datetime,
    *,
    session_id: uuid.UUID | None = None,
    except_session_id: uuid.UUID | None = None,
) -> int:
    """Caller holds the user lock; session and device changes share its transaction."""
    stmt = update(UserSession).where(
        UserSession.user_id == user_id, UserSession.revoked_at.is_(None)
    )
    if session_id is not None:
        stmt = stmt.where(UserSession.id == session_id)
    if except_session_id is not None:
        stmt = stmt.where(UserSession.id != except_session_id)
    result = await db.execute(
        stmt.values(revoked_at=now, revoke_reason=reason).returning(
            UserSession.id, UserSession.device_id
        )
    )
    revoked = result.all()
    device_ids = [row[1] for row in revoked]
    for revoked_id, _ in revoked:
        await write_outbox(
            db,
            event_type=SESSION_REVOKED,
            audience_type="session",
            audience_id=revoked_id,
            payload=SessionRevokedData(reason=reason).model_dump(mode="json"),
        )
    if device_ids:
        await db.execute(
            update(Device)
            .where(Device.id.in_(device_ids))
            .values(enabled=False, disabled_reason=reason, updated_at=now)
        )
    return len(device_ids)


def _live_session_of(device_id: Any, now: datetime) -> Exists:
    return (
        select(UserSession.id)
        .where(
            UserSession.device_id == device_id,
            UserSession.revoked_at.is_(None),
            UserSession.expires_at > now,
        )
        .exists()
    )


async def has_live_session(db: AsyncSession, device_id: uuid.UUID, now: datetime) -> bool:
    """Whether the device can still act for its user (a session neither revoked nor expired)."""
    return bool((await db.execute(select(_live_session_of(device_id, now)))).scalar_one())


async def disable_devices_without_session(db: AsyncSession, now: datetime) -> int:
    """Enabled devices whose every session has expired (or is gone) are disabled, as a logout
    would have done: sessions only run out quietly, and an enabled row with a push token would
    keep receiving message content long after the phone could show it (SECURITY.md §2.6)."""
    stmt = (
        update(Device)
        .where(Device.enabled.is_(True), ~_live_session_of(Device.id, now))
        .values(enabled=False, disabled_reason="session_expired", updated_at=now)
        .returning(Device.id)
        .execution_options(synchronize_session=False)
    )
    return len((await db.execute(stmt)).all())


async def purge_sessions(db: AsyncSession, before: datetime) -> int:
    """Revoked or expired sessions older than the retention window (SECURITY.md §2.4)."""
    stmt = (
        delete(UserSession)
        .where(or_(UserSession.revoked_at < before, UserSession.expires_at < before))
        .returning(UserSession.id)
    )
    return len((await db.execute(stmt)).all())


async def purge_devices(db: AsyncSession, before: datetime) -> int:
    """Disabled devices without sessions that have not been seen within the retention window."""
    has_session = select(UserSession.id).where(UserSession.device_id == Device.id).exists()
    stmt = (
        delete(Device)
        .where(Device.enabled.is_(False), Device.updated_at < before, ~has_session)
        .returning(Device.id)
    )
    return len((await db.execute(stmt)).all())


async def clear_push_tokens(db: AsyncSession, user_id: uuid.UUID) -> None:
    """Anonymisation: no device of the user may receive another push."""
    await db.execute(
        update(Device)
        .where(Device.user_id == user_id)
        .values(push_token=None, push_provider="none", enabled=False, disabled_reason="anonymized")
    )
