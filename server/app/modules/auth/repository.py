import uuid
from datetime import datetime

from sqlalchemy import or_, select, update
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
