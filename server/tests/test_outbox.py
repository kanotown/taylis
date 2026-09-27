"""Transactional outbox and relay (ARCHITECTURE.md §6)."""

import uuid
from datetime import timedelta

from fastapi import FastAPI
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.bus import Subscriber, Unsubscribe
from app.events.envelope import Envelope
from app.events.models import OutboxEvent
from app.events.outbox import OutboxRelay, purge_processed, write_outbox
from app.modules.channels import service as channels
from app.modules.channels.schemas import ChannelCreate
from app.modules.messages import service as messages
from app.modules.messages.schemas import MessageCreate
from tests.helpers import make_user


class RecordingBus:
    def __init__(self) -> None:
        self.published: list[Envelope] = []

    async def publish(self, envelope: Envelope) -> None:
        self.published.append(envelope)

    def subscribe(self, subscriber: Subscriber) -> Unsubscribe:
        return lambda: None


def _relay(
    app: FastAPI, bus: RecordingBus, *, batch_size: int = 100, max_attempts: int = 10
) -> OutboxRelay:
    return OutboxRelay(
        app.state.db,
        bus,
        channels.resolve_event_audience,
        batch_size=batch_size,
        max_attempts=max_attempts,
    )


async def test_domain_changes_are_relayed_in_order_with_audience(
    app: FastAPI, db: AsyncSession
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    channel = await channels.create_channel(db, alice, ChannelCreate(name="general"))
    await channels.join_channel(db, bob, channel.id)
    message, _ = await messages.create_message(
        db, alice, channel.id, MessageCreate(client_msg_id=uuid.uuid4(), body="hello")
    )

    bus = RecordingBus()
    relay = _relay(app, bus)
    # channel.created, member_added, channel.created (for bob), message.created,
    # read.updated (the sender has read their own message; M8b)
    assert await relay.process_batch() == 5
    assert await relay.process_batch() == 0

    events = [e.event for e in bus.published]
    assert events == [
        "channel.created",
        "channel.member_added",
        "channel.created",
        "message.created",
        "read.updated",
    ]
    assert [e.id for e in bus.published] == sorted(e.id for e in bus.published)

    created = bus.published[0]
    # A public channel goes to every non-guest user (M13e), resolved to explicit ids.
    assert created.audience.kind == "users" and {alice.id, bob.id} <= set(created.audience.ids)
    assert created.data["member_ids"] == [str(alice.id)]

    joined = bus.published[1]
    assert joined.audience.kind == "users" and set(joined.audience.ids) == {alice.id, bob.id}

    for_bob = bus.published[2]
    assert for_bob.audience.kind == "users" and for_bob.audience.ids == (bob.id,)

    posted = bus.published[3]
    assert posted.seq == 1 and posted.channel_id == channel.id
    assert set(posted.audience.ids) == {alice.id, bob.id} and carol.id not in posted.audience.ids
    assert posted.data["message"]["id"] == str(message.id)
    assert posted.data["message"]["body"] == "hello"
    frame = posted.frame()
    assert frame["type"] == "event" and frame["event"] == "message.created" and frame["seq"] == 1

    pending = await db.execute(select(OutboxEvent).where(OutboxEvent.processed_at.is_(None)))
    assert pending.scalars().all() == []


async def test_a_new_relay_delivers_rows_left_by_a_crashed_one(
    app: FastAPI, db: AsyncSession
) -> None:
    alice = await make_user(db, "alice")
    channel = await channels.create_channel(db, alice, ChannelCreate(name="general"))
    for i in range(3):
        await messages.create_message(
            db, alice, channel.id, MessageCreate(client_msg_id=uuid.uuid4(), body=f"m{i}")
        )
    first = RecordingBus()
    assert await _relay(app, first, batch_size=2).process_batch() == 2  # "crash" after one batch

    second = RecordingBus()
    assert await _relay(app, second).process_batch() == 5
    delivered = [e.event for e in first.published + second.published]
    assert delivered == ["channel.created"] + ["message.created", "read.updated"] * 3
    assert [e.seq for e in second.published if e.seq is not None] == [2, 3]


async def test_poison_event_is_retried_then_skipped_without_blocking_others(
    app: FastAPI, db: AsyncSession
) -> None:
    await write_outbox(db, event_type="broken", audience_type="channel", payload={})  # no channel
    await write_outbox(db, event_type="fine", audience_type="all", payload={"ok": True})
    await db.commit()

    bus = RecordingBus()
    relay = _relay(app, bus, max_attempts=2)
    assert await relay.process_batch() == 2
    assert [e.event for e in bus.published] == ["fine"]

    rows = (await db.execute(select(OutboxEvent).order_by(OutboxEvent.id))).scalars().all()
    broken, fine = rows
    assert broken.processed_at is None and broken.attempts == 1
    assert "unresolvable" in (broken.last_error or "")
    assert fine.processed_at is not None

    assert await relay.process_batch() == 1  # second attempt
    assert await relay.process_batch() == 0  # attempts exhausted: skipped, relay keeps going


async def test_purge_removes_only_old_processed_events(app: FastAPI, db: AsyncSession) -> None:
    old = await write_outbox(db, event_type="x", audience_type="all", payload={})
    recent = await write_outbox(db, event_type="y", audience_type="all", payload={})
    pending = await write_outbox(db, event_type="z", audience_type="all", payload={})
    await db.commit()
    await db.execute(
        update(OutboxEvent)
        .where(OutboxEvent.id == old.id)
        .values(processed_at=utcnow() - timedelta(days=8))
    )
    await db.execute(
        update(OutboxEvent).where(OutboxEvent.id == recent.id).values(processed_at=utcnow())
    )
    await db.commit()

    assert await purge_processed(app.state.db, timedelta(days=7)) == 1
    remaining = (await db.execute(select(OutboxEvent.id).order_by(OutboxEvent.id))).scalars().all()
    assert remaining == [recent.id, pending.id]
