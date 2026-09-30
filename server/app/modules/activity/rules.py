"""Activity rules with no dependencies (the messages module uses them: no import cycle)."""

import uuid


def reaction_audience(sender_id: uuid.UUID | None, actor_id: uuid.UUID) -> uuid.UUID | None:
    """Whom a reaction is news to: the message's author, unless they reacted to their own
    message."""
    return sender_id if sender_id is not None and sender_id != actor_id else None
