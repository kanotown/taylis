"""PushSender: leases pending push_deliveries and hands them to the providers (§2, §6, §7)."""

import asyncio
import logging
import uuid
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import Database
from app.core.time import utcnow
from app.modules.notifications import repository as repo
from app.modules.notifications.providers import PushProvider

log = logging.getLogger("app.push")

BACKOFF_SECONDS = [30, 120, 600]  # after attempt 1, 2, 3; then failed (§6)


class PushSender:
    def __init__(
        self,
        db: Database,
        providers: dict[str, PushProvider],
        *,
        poll_interval: float = 1.0,
        batch_size: int = 50,
        concurrency: int = 10,
        lease_seconds: int = 60,
    ) -> None:
        self.db = db
        self.providers = providers
        self.poll_interval = poll_interval
        self.batch_size = batch_size
        self.concurrency = concurrency
        self.lease = timedelta(seconds=lease_seconds)
        self._wake = asyncio.Event()
        self.sent_total = 0

    def wake(self) -> None:
        self._wake.set()

    async def process_batch(self, now: datetime | None = None) -> int:
        now = now or utcnow()
        async with self.db.session_factory() as session:
            ids = await repo.lease_pending(session, now, limit=self.batch_size, lease=self.lease)
            await session.commit()
        if not ids:
            return 0
        semaphore = asyncio.Semaphore(self.concurrency)

        async def deliver(delivery_id: int) -> None:
            async with semaphore:
                await self.deliver(delivery_id, now)

        await asyncio.gather(*(deliver(i) for i in ids))
        return len(ids)

    async def deliver(self, delivery_id: int, now: datetime | None = None) -> None:
        now = now or utcnow()
        async with self.db.session_factory() as session:
            row = await repo.get_delivery_with_device(session, delivery_id)
            if row is None:
                return
            delivery, device = row
            if delivery.expires_at <= now:
                delivery.status, delivery.last_error = "skipped", "expired"
            elif not device.enabled or not device.push_registered:
                delivery.status, delivery.last_error = "skipped", "device_disabled"
            elif not await self._session_alive(session, device.id, now):
                # Sessions run out quietly (the hourly sweep disables the device later): a phone
                # that can no longer show the message gets no content (SECURITY.md §2.6).
                delivery.status, delivery.last_error = "skipped", "session_expired"
            elif await self._already_read(session, device.user_id, delivery):
                delivery.status, delivery.last_error = "skipped", "already_read"
            else:
                provider = self.providers.get(device.push_provider)
                if provider is None:
                    delivery.status, delivery.last_error = (
                        "failed",
                        f"no provider for {device.push_provider}",
                    )
                else:
                    try:
                        result = await provider.send(device, delivery.payload)
                    except Exception as exc:  # the lease makes a crash here a retry, not a loss
                        log.exception(
                            "push provider %s raised for delivery %s",
                            device.push_provider,
                            delivery.id,
                        )
                        result = None
                        delivery.last_error = repr(exc)[:500]
                    if result is not None:
                        self.apply(delivery, device, result, now)
            await session.commit()

    @staticmethod
    async def _session_alive(session: AsyncSession, device_id: uuid.UUID, now: datetime) -> bool:
        from app.modules.auth import service as auth

        return await auth.has_live_session(session, device_id, now)

    @staticmethod
    async def _already_read(session: AsyncSession, user_id: uuid.UUID, delivery: object) -> bool:
        """Read on another device since planning (PUSH_NOTIFICATIONS.md §6: 送信直前の再判定).
        A thread reply is read by its thread's position (THREADS.md), not the channel's."""
        from app.modules.notifications.models import PushDelivery
        from app.modules.reads import service as reads
        from app.modules.threads import service as threads

        assert isinstance(delivery, PushDelivery)
        if delivery.channel_id is None or delivery.message_seq is None:
            return False
        parent_id = delivery.payload.get("parent_id")
        if parent_id:
            return await threads.is_read(
                session, user_id, uuid.UUID(str(parent_id)), delivery.message_seq
            )
        return await reads.is_read(session, user_id, delivery.channel_id, delivery.message_seq)

    def apply(self, delivery: object, device: object, result: object, now: datetime) -> None:
        from app.modules.auth.models import Device
        from app.modules.notifications.models import PushDelivery
        from app.modules.notifications.providers import PushResult

        assert (
            isinstance(delivery, PushDelivery)
            and isinstance(device, Device)
            and isinstance(result, PushResult)
        )
        if result.outcome == "sent":
            delivery.status, delivery.sent_at, delivery.last_error = "sent", now, None
            self.sent_total += 1
        elif result.outcome == "invalid_token":
            device.push_token = None
            device.push_token_invalid_reason = result.detail or "invalid_token"
            delivery.status, delivery.last_error = "failed", result.detail or "invalid_token"
        elif result.outcome == "retry":
            index = delivery.attempts - 1  # attempts was bumped by the lease
            if index >= len(BACKOFF_SECONDS):
                delivery.status, delivery.last_error = "failed", f"gave up: {result.detail}"
            else:
                delay = result.retry_after or BACKOFF_SECONDS[index]
                next_at = now + timedelta(seconds=delay)
                if next_at >= delivery.expires_at:
                    delivery.status, delivery.last_error = (
                        "failed",
                        f"expired before retry: {result.detail}",
                    )
                else:
                    delivery.next_attempt_at, delivery.last_error = next_at, result.detail
        else:
            delivery.status, delivery.last_error = "failed", result.detail

    async def run(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            self._wake.clear()
            try:
                while await self.process_batch() > 0:
                    pass
            except Exception:
                log.exception("push sender batch failed")
            waiters = [asyncio.create_task(self._wake.wait()), asyncio.create_task(stop.wait())]
            try:
                await asyncio.wait(
                    waiters, timeout=self.poll_interval, return_when=asyncio.FIRST_COMPLETED
                )
            finally:
                for waiter in waiters:
                    waiter.cancel()
