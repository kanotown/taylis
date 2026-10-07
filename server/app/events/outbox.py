"""Transactional Outbox: writer, relay and purge (ARCHITECTURE.md §6).

Writers add a row in the same transaction as their change and NOTIFY on commit. The relay
processes rows in id order, resolves the audience, runs durable handlers, marks the row
processed, commits, and only then publishes to the (ephemeral) EventBus.
"""

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable, Sequence
from datetime import timedelta
from typing import Any, Literal, Protocol

import asyncpg
from sqlalchemy import and_, delete, or_, select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import Database
from app.core.time import utcnow
from app.events.bus import EventBus
from app.events.envelope import Audience, Envelope
from app.events.models import OutboxEvent

log = logging.getLogger("app.outbox")

NOTIFY_CHANNEL = "outbox"
# "page" (M120, docs/WIKI.md §10): the people who can read a wiki page when the relay sends it.
# "action" (M143, docs/ACTIONS.md §12): who may press a button of a status button's group.
AudienceType = Literal["channel", "user", "session", "all", "page", "action"]


async def write_outbox(
    db: AsyncSession,
    *,
    event_type: str,
    audience_type: AudienceType,
    payload: dict[str, Any],
    audience_id: uuid.UUID | None = None,
    channel_id: uuid.UUID | None = None,
    seq: int | None = None,
) -> OutboxEvent:
    """Queue an event inside the caller's transaction. The NOTIFY fires when it commits."""
    row = OutboxEvent(
        event_type=event_type,
        channel_id=channel_id,
        seq=seq,
        audience_type=audience_type,
        audience_id=audience_id,
        payload=payload,
    )
    db.add(row)
    await db.flush()
    await db.execute(text(f"SELECT pg_notify('{NOTIFY_CHANNEL}', '')"))
    return row


class OutboxHandler(Protocol):
    """Durable side effect run inside the relay's transaction (e.g. push planning). Idempotent."""

    async def handle(self, db: AsyncSession, event: OutboxEvent, audience: Audience) -> None: ...


AudienceResolver = Callable[[AsyncSession, OutboxEvent], Awaitable[Audience]]


def asyncpg_dsn(database_url: str) -> str:
    return make_url(database_url).set(drivername="postgresql").render_as_string(hide_password=False)


class OutboxRelay:
    def __init__(
        self,
        db: Database,
        bus: EventBus,
        resolve_audience: AudienceResolver,
        *,
        handlers: Sequence[OutboxHandler] = (),
        listen_dsn: str | None = None,
        poll_interval: float = 1.0,
        batch_size: int = 100,
        max_attempts: int = 10,
    ) -> None:
        self.db = db
        self.bus = bus
        self.resolve_audience = resolve_audience
        self.handlers = list(handlers)
        self.listen_dsn = listen_dsn
        self.poll_interval = poll_interval
        self.batch_size = batch_size
        self.max_attempts = max_attempts
        self._wake = asyncio.Event()
        self.processed_total = 0

    def wake(self) -> None:
        self._wake.set()

    async def process_batch(self) -> int:
        """Process up to ``batch_size`` pending rows. Returns how many rows were examined."""
        envelopes: list[Envelope] = []
        async with self.db.session_factory() as session:
            stmt = (
                select(OutboxEvent)
                .where(OutboxEvent.processed_at.is_(None), OutboxEvent.attempts < self.max_attempts)
                .order_by(OutboxEvent.id)
                .limit(self.batch_size)
                .with_for_update(skip_locked=True)
            )
            rows = list((await session.execute(stmt)).scalars().all())
            if not rows:
                return 0
            for row in rows:
                envelope = Envelope(
                    id=row.id,
                    event=row.event_type,
                    ts=row.created_at,
                    channel_id=row.channel_id,
                    seq=row.seq,
                    data=row.payload,
                )
                try:
                    async with session.begin_nested():
                        audience = await self.resolve_audience(session, row)
                        for handler in self.handlers:
                            await handler.handle(session, row, audience)
                        await session.execute(
                            update(OutboxEvent)
                            .where(OutboxEvent.id == envelope.id)
                            .values(processed_at=utcnow())
                            .execution_options(synchronize_session=False)
                        )
                except Exception as exc:
                    log.exception("outbox event %s failed", envelope.id)
                    await session.execute(
                        update(OutboxEvent)
                        .where(OutboxEvent.id == envelope.id)
                        .values(attempts=OutboxEvent.attempts + 1, last_error=repr(exc)[:500])
                        .execution_options(synchronize_session=False)
                    )
                    continue
                envelopes.append(
                    Envelope(
                        id=envelope.id,
                        event=envelope.event,
                        ts=envelope.ts,
                        channel_id=envelope.channel_id,
                        seq=envelope.seq,
                        data=envelope.data,
                        audience=audience,
                    )
                )
            await session.commit()
        for envelope in envelopes:
            await self.bus.publish(envelope)
        self.processed_total += len(envelopes)
        return len(rows)

    async def run(self, stop: asyncio.Event) -> None:
        listener = asyncio.create_task(self._listen(stop)) if self.listen_dsn else None
        try:
            while not stop.is_set():
                self._wake.clear()
                try:
                    while await self.process_batch() > 0:
                        pass
                except Exception:
                    log.exception("outbox relay batch failed")
                    await asyncio.sleep(self.poll_interval)
                    continue
                await self._wait_for_wake_or_stop(stop)
        finally:
            if listener is not None:
                listener.cancel()

    async def _wait_for_wake_or_stop(self, stop: asyncio.Event) -> None:
        waiters = [asyncio.create_task(self._wake.wait()), asyncio.create_task(stop.wait())]
        try:
            await asyncio.wait(
                waiters, timeout=self.poll_interval, return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            for waiter in waiters:
                waiter.cancel()

    async def _listen(self, stop: asyncio.Event) -> None:
        """Dedicated connection for LISTEN; falls back to polling if it cannot connect."""
        assert self.listen_dsn is not None
        backoff = 1.0
        while not stop.is_set():
            try:
                conn = await asyncpg.connect(self.listen_dsn)
                try:
                    await conn.add_listener(NOTIFY_CHANNEL, lambda *_: self.wake())
                    backoff = 1.0
                    await stop.wait()
                finally:
                    await conn.close()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("outbox LISTEN unavailable, polling only: %s", exc)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)


async def purge_processed(db: Database, older_than: timedelta, *, max_attempts: int = 10) -> int:
    """Processed rows older than the retention, and rows given up on (attempts exhausted; the
    relay skips them, so they would otherwise stay for good)."""
    cutoff = utcnow() - older_than
    async with db.session_factory() as session:
        result = await session.execute(
            delete(OutboxEvent)
            .where(
                or_(
                    and_(OutboxEvent.processed_at.is_not(None), OutboxEvent.processed_at < cutoff),
                    and_(
                        OutboxEvent.processed_at.is_(None),
                        OutboxEvent.attempts >= max_attempts,
                        OutboxEvent.created_at < cutoff,
                    ),
                )
            )
            .returning(OutboxEvent.id)
        )
        purged = len(result.all())
        await session.commit()
        return purged
