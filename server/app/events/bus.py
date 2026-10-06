"""EventBus boundary (ARCHITECTURE.md §10).

The OutboxRelay publishes the stored events and only the RealtimeHub subscribes. The AI bots'
typing ticker (docs/AI.md §2.2) also publishes volatile ``typing`` frames (``Envelope.volatile``).
The bus is ephemeral: durable work happens in outbox handlers, never in subscribers.
"""

from collections.abc import Awaitable, Callable
from typing import Protocol

from app.events.envelope import Envelope

Subscriber = Callable[[Envelope], Awaitable[None]]
Unsubscribe = Callable[[], None]


class EventBus(Protocol):
    async def publish(self, envelope: Envelope) -> None: ...

    def subscribe(self, subscriber: Subscriber) -> Unsubscribe: ...
