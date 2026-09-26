"""EventBus boundary (ARCHITECTURE.md §10).

Only the OutboxRelay publishes and only the RealtimeHub subscribes. The bus is ephemeral:
durable work happens in outbox handlers, never in subscribers.
"""

from collections.abc import Awaitable, Callable
from typing import Protocol

from app.events.envelope import Envelope

Subscriber = Callable[[Envelope], Awaitable[None]]
Unsubscribe = Callable[[], None]


class EventBus(Protocol):
    async def publish(self, envelope: Envelope) -> None: ...

    def subscribe(self, subscriber: Subscriber) -> Unsubscribe: ...
