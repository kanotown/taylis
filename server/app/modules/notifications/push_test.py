"""A test notification to all of my devices (PUSH_NOTIFICATIONS.md §15).

Unlike a planned push it is sent right away, inside the request, so the answer can say what
happened on each device. It goes through the same providers, ignores mute, the notification level
and do-not-disturb (the person asked for it), and still skips devices that are logged out.
"""

import asyncio
import logging
import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.auth.models import Device
from app.modules.notifications.events import NOTIFICATION_TEST, NotificationTestData
from app.modules.notifications.providers import LogPushProvider, PushProvider, PushResult
from app.modules.notifications.schemas import (
    PushPayload,
    TestNotificationDevice,
    TestNotificationOut,
    TestNotificationStatus,
)
from app.modules.users.dnd import dnd_active
from app.modules.users.models import User
from app.modules.workspace import service as workspace

log = logging.getLogger("app.push")

TITLE = "Taylis"
BODY = "テスト通知です。この端末に通知が届いています。"
# A logged-out device stays listed this long, so "why did my old phone get nothing" has an answer.
DISABLED_LISTED_FOR = timedelta(days=30)
MAX_DEVICES = 20
MOBILE = ("ios", "android")


def configured(provider: PushProvider | None) -> bool:
    """A LogPushProvider stands in when PUSH_APNS_ENABLED / PUSH_FCM_ENABLED is off."""
    return provider is not None and not isinstance(provider, LogPushProvider)


async def _devices(db: AsyncSession, user_id: uuid.UUID) -> list[Device]:
    since = utcnow() - DISABLED_LISTED_FOR
    stmt = select(Device).where(
        Device.user_id == user_id,
        or_(Device.enabled.is_(True), Device.updated_at >= since),
    )
    return list((await db.execute(stmt)).scalars().all())


async def _send(provider: PushProvider, device: Device, payload: dict[str, Any]) -> PushResult:
    try:
        return await provider.send(device, payload)
    except Exception as exc:  # one device's failure must not hide the others' results
        log.exception("test push to device %s raised", device.id)
        return PushResult("failed", type(exc).__name__)


async def send_test(
    db: AsyncSession,
    user: User,
    *,
    current_device_id: uuid.UUID | None,
    providers: dict[str, PushProvider],
    settings: Settings,
) -> TestNotificationOut:
    from app.modules.auth import service as auth
    from app.modules.notifications.planner import PushPlanner

    now = utcnow()
    devices = await _devices(db, user.id)
    # The current device first, then the ones in use, then the logged-out ones.
    devices.sort(
        key=lambda d: (
            d.id != current_device_id,
            not d.enabled,
            -(d.last_seen_at or d.created_at).timestamp(),
        )
    )
    devices = devices[:MAX_DEVICES]
    badge = await PushPlanner(settings, is_active=lambda _: False).badge_for(db, user.id)
    payload = PushPayload(
        kind="test",
        workspace_id=await workspace.workspace_id(db),
        title=TITLE,
        body=BODY,
        badge=badge,
        collapse_key="test",
        sent_at=now,
    ).model_dump(mode="json")
    payload["expires_at"] = (now + timedelta(seconds=settings.push_alert_ttl_seconds)).isoformat()

    results: dict[uuid.UUID, tuple[TestNotificationStatus, str | None]] = {}
    sends: list[tuple[Device, Any]] = []
    for device in devices:
        if not device.enabled:
            results[device.id] = ("disabled", device.disabled_reason or "logout")
        elif not await auth.has_live_session(db, device.id, now):
            results[device.id] = ("disabled", "session_expired")
        elif not device.push_registered:
            results[device.id] = ("no_token" if device.platform in MOBILE else "in_app", None)
        elif not configured(providers.get(device.push_provider)):
            results[device.id] = ("not_configured", None)
        else:
            provider = providers[device.push_provider]
            sends.append((device, _send(provider, device, payload)))

    outcomes = await asyncio.gather(*(task for _, task in sends))
    for (device, _), result in zip(sends, outcomes, strict=True):
        if result.outcome == "sent":
            results[device.id] = ("sent", None)
            continue
        if result.outcome == "invalid_token":
            # As the sender does (§8): the app registers a fresh token on its next start.
            device.push_token = None
            device.push_token_invalid_reason = (result.detail or "invalid_token")[:32]
        results[device.id] = ("failed", result.detail or result.outcome)

    data = NotificationTestData(
        title=TITLE,
        body=BODY,
        device_id=str(current_device_id) if current_device_id else None,
        sent_at=now.isoformat().replace("+00:00", "Z"),
    )
    await write_outbox(
        db,
        event_type=NOTIFICATION_TEST,
        audience_type="user",
        audience_id=user.id,
        payload=data.model_dump(mode="json"),
    )
    await db.commit()

    out = TestNotificationOut(
        apns_configured=configured(providers.get("apns")),
        fcm_configured=configured(providers.get("fcm")),
        dnd_active=dnd_active(user, now),
        sent_count=sum(1 for status, _ in results.values() if status == "sent"),
        devices=[
            TestNotificationDevice(
                device_id=d.id,
                device_name=d.device_name,
                platform=d.platform,
                push_provider=d.push_provider,
                current=d.id == current_device_id,
                status=results[d.id][0],
                detail=results[d.id][1],
                last_seen_at=d.last_seen_at,
            )
            for d in devices
        ],
    )
    log.info(
        "test notification sent",
        extra={
            "user_id": str(user.id),
            "sent": out.sent_count,
            "devices": {str(d.device_id): d.status for d in out.devices},
        },
    )
    return out
