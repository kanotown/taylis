"""PushSender: lease, backoff, expiry, invalid tokens (PUSH_NOTIFICATIONS.md §6, §7)."""

from datetime import timedelta

from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.modules.auth.models import Device
from app.modules.notifications.models import PushDelivery
from app.modules.notifications.providers import FakePushProvider, PushResult
from app.modules.notifications.sender import PushSender
from app.modules.users.models import User
from tests.helpers import make_user


async def seed(
    db: AsyncSession,
    user: User,
    *,
    token: str | None = "tok",
    enabled: bool = True,
    expires_in: int = 600,
) -> PushDelivery:
    device = Device(
        user_id=user.id,
        platform="ios",
        push_provider="apns",
        push_token=token,
        push_environment="sandbox",
        enabled=enabled,
    )
    db.add(device)
    await db.flush()
    delivery = PushDelivery(
        event_id=1,
        device_id=device.id,
        user_id=user.id,
        kind="alert",
        collapse_key="c",
        payload={"title": "t", "body": "b", "kind": "message"},
        expires_at=utcnow() + timedelta(seconds=expires_in),
    )
    db.add(delivery)
    await db.commit()
    return delivery


async def reload(db: AsyncSession, delivery_id: int) -> PushDelivery:
    stmt = (
        select(PushDelivery)
        .where(PushDelivery.id == delivery_id)
        .execution_options(populate_existing=True)
    )
    return (await db.execute(stmt)).scalar_one()


def sender(app: FastAPI, provider: FakePushProvider, **kwargs: int) -> PushSender:
    return PushSender(app.state.db, {"apns": provider}, **kwargs)


async def test_sends_and_marks_sent(app: FastAPI, db: AsyncSession) -> None:
    user = await make_user(db, "alice")
    delivery = await seed(db, user)
    provider = FakePushProvider()
    assert await sender(app, provider).process_batch() == 1
    row = await reload(db, delivery.id)
    assert row.status == "sent" and row.sent_at is not None and row.attempts == 1
    assert provider.sent[0][1]["title"] == "t"


async def test_retry_backoff_then_gives_up(app: FastAPI, db: AsyncSession) -> None:
    user = await make_user(db, "alice")
    delivery = await seed(db, user, expires_in=3600)
    provider = FakePushProvider()
    provider.outcomes = [PushResult("retry", "503")] * 4
    push_sender = sender(app, provider)
    now = utcnow()
    assert await push_sender.process_batch(now) == 1
    row = await reload(db, delivery.id)
    assert row.status == "pending" and row.attempts == 1
    assert abs((row.next_attempt_at - now).total_seconds() - 30) < 2
    assert await push_sender.process_batch(now) == 0  # not due yet
    for expected_attempt, delay in ((2, 120), (3, 600)):
        now = row.next_attempt_at
        assert await push_sender.process_batch(now) == 1
        row = await reload(db, delivery.id)
        assert row.status == "pending" and row.attempts == expected_attempt
        assert abs((row.next_attempt_at - now).total_seconds() - delay) < 2
    assert await push_sender.process_batch(row.next_attempt_at) == 1
    row = await reload(db, delivery.id)
    assert row.status == "failed" and "gave up" in (row.last_error or "")


async def test_invalid_token_disables_push_on_the_device(app: FastAPI, db: AsyncSession) -> None:
    user = await make_user(db, "alice")
    delivery = await seed(db, user)
    provider = FakePushProvider()
    provider.outcomes = [PushResult("invalid_token", "Unregistered")]
    await sender(app, provider).process_batch()
    row = await reload(db, delivery.id)
    assert row.status == "failed"
    device = await db.get(Device, row.device_id)
    assert (
        device is not None
        and device.push_token is None
        and device.push_token_invalid_reason == "Unregistered"
    )


async def test_expired_and_disabled_are_skipped_without_sending(
    app: FastAPI, db: AsyncSession
) -> None:
    user = await make_user(db, "alice")
    expired = await seed(db, user, expires_in=-1)
    disabled = await seed(db, user, token="tok2", enabled=False)
    provider = FakePushProvider()
    await sender(app, provider).process_batch()
    assert provider.sent == []
    assert (await reload(db, expired.id)).last_error == "expired"
    assert (await reload(db, disabled.id)).last_error == "device_disabled"


async def test_provider_crash_keeps_the_lease_for_a_retry(app: FastAPI, db: AsyncSession) -> None:
    user = await make_user(db, "alice")
    delivery = await seed(db, user)
    provider = FakePushProvider()
    provider.outcomes = [RuntimeError("boom")]
    push_sender = sender(app, provider, lease_seconds=60)
    now = utcnow()
    await push_sender.process_batch(now)
    row = await reload(db, delivery.id)
    assert row.status == "pending" and row.attempts == 1 and "boom" in (row.last_error or "")
    assert row.next_attempt_at >= now + timedelta(seconds=59)
    assert await push_sender.process_batch(now + timedelta(seconds=61)) == 1
    assert (await reload(db, delivery.id)).status == "sent"
