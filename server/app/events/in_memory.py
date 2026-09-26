"""Single-process EventBus. A RedisEventBus would replace this for multiple processes."""

import logging

from app.events.bus import Subscriber, Unsubscribe
from app.events.envelope import Envelope

log = logging.getLogger("app.events")


class InMemoryEventBus:
    def __init__(self) -> None:
        self._subscribers: list[Subscriber] = []

    async def publish(self, envelope: Envelope) -> None:
        for subscriber in list(self._subscribers):
            try:
                await subscriber(envelope)
            except Exception:  # a subscriber must never break delivery to the others
                log.exception("event subscriber failed", extra={"event": envelope.event})

    def subscribe(self, subscriber: Subscriber) -> Unsubscribe:
        self._subscribers.append(subscriber)

        def unsubscribe() -> None:
            if subscriber in self._subscribers:
                self._subscribers.remove(subscriber)

        return unsubscribe
