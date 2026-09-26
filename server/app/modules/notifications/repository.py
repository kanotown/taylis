import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth.models import Device
from app.modules.notifications.models import NotificationPreference, PushDelivery


async def get_preference(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID
) -> NotificationPreference | None:
    return await db.get(NotificationPreference, (user_id, channel_id))


async def preferences_for_user(
    db: AsyncSession, user_id: uuid.UUID
) -> dict[uuid.UUID, NotificationPreference]:
    stmt = select(NotificationPreference).where(NotificationPreference.user_id == user_id)
    return {p.channel_id: p for p in (await db.execute(stmt)).scalars().all()}


async def preferences_for_channel(
    db: AsyncSession, channel_id: uuid.UUID, user_ids: list[uuid.UUID]
) -> dict[uuid.UUID, NotificationPreference]:
    if not user_ids:
        return {}
    stmt = select(NotificationPreference).where(
        NotificationPreference.channel_id == channel_id,
        NotificationPreference.user_id.in_(user_ids),
    )
    return {p.user_id: p for p in (await db.execute(stmt)).scalars().all()}


async def push_devices_for_users(db: AsyncSession, user_ids: list[uuid.UUID]) -> list[Device]:
    if not user_ids:
        return []
    stmt = select(Device).where(
        Device.user_id.in_(user_ids),
        Device.enabled.is_(True),
        Device.push_token.is_not(None),
        Device.push_provider != "none",
    )
    return list((await db.execute(stmt)).scalars().all())


async def add_delivery(
    db: AsyncSession,
    *,
    event_id: int,
    device: Device,
    kind: str,
    collapse_key: str | None,
    channel_id: uuid.UUID | None,
    message_id: uuid.UUID | None,
    message_seq: int | None,
    payload: dict[str, Any],
    expires_at: datetime,
) -> bool:
    """Idempotent per (event, device): re-processing an outbox event never plans a second push."""
    stmt = (
        insert(PushDelivery)
        .values(
            event_id=event_id,
            device_id=device.id,
            user_id=device.user_id,
            kind=kind,
            collapse_key=collapse_key,
            channel_id=channel_id,
            message_id=message_id,
            message_seq=message_seq,
            payload=payload,
            expires_at=expires_at,
        )
        .on_conflict_do_nothing(constraint="uq_push_deliveries_event_device")
        .returning(PushDelivery.id)
    )
    return (await db.execute(stmt)).scalar_one_or_none() is not None


async def lease_pending(
    db: AsyncSession, now: datetime, *, limit: int, lease: timedelta
) -> list[int]:
    """Claim a batch: bump attempts and push next_attempt_at so a crashed sender retries later."""
    stmt = (
        select(PushDelivery.id)
        .where(PushDelivery.status == "pending", PushDelivery.next_attempt_at <= now)
        .order_by(PushDelivery.id)
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    ids = list((await db.execute(stmt)).scalars().all())
    if ids:
        await db.execute(
            update(PushDelivery)
            .where(PushDelivery.id.in_(ids))
            .values(attempts=PushDelivery.attempts + 1, next_attempt_at=now + lease)
            .execution_options(synchronize_session=False)
        )
    return ids


async def get_delivery_with_device(
    db: AsyncSession, delivery_id: int
) -> tuple[PushDelivery, Device] | None:
    stmt = (
        select(PushDelivery, Device)
        .join(Device, Device.id == PushDelivery.device_id)
        .where(PushDelivery.id == delivery_id)
    )
    row = (await db.execute(stmt)).first()
    return (row[0], row[1]) if row else None


async def invalidate_push_token(db: AsyncSession, device: Device, reason: str) -> None:
    device.push_token = None
    device.push_token_invalid_reason = reason


async def purge_deliveries(db: AsyncSession, older_than: datetime) -> int:
    stmt = (
        delete(PushDelivery)
        .where(PushDelivery.status != "pending", PushDelivery.created_at < older_than)
        .returning(PushDelivery.id)
    )
    return len((await db.execute(stmt)).all())
