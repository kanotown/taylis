"""Calls by meeting link (M117, docs/CALLS.md). Starting a call posts one ordinary message from
the caller (seq, outbox, push, idempotency as any post) whose `call_url` is a fresh room on the
workspace's meeting service; the call itself happens there, outside the app."""

import secrets
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import conflict
from app.modules.channels import service as channels
from app.modules.messages import repository as messages_repo
from app.modules.messages import service as messages
from app.modules.messages.models import Message
from app.modules.messages.schemas import MessageCreate
from app.modules.users.models import User
from app.modules.workspace import service as workspace

ROOM_PREFIX = "taylis-"
# Lower-case base32 (Jitsi folds room names to lower case): 24 characters = 120 random bits, so a
# room cannot be guessed. Never derived from ids.
ROOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
ROOM_LENGTH = 24


def room_name() -> str:
    return ROOM_PREFIX + "".join(secrets.choice(ROOM_ALPHABET) for _ in range(ROOM_LENGTH))


def call_body(url: str) -> str:
    """The body clients before M117 show (the workspace's language, docs/I18N.md §1); new clients
    draw the call from `message.call`."""
    return f"📞 通話を始めました\n{url}"


async def start_call(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, client_msg_id: uuid.UUID
) -> tuple[Message, bool]:
    """Returns (message, created). Who may start one: whoever may post a top-level message there
    (a member; not archived; announcement channels: owners and administrators; DMs as messages)."""
    existing = await messages_repo.get_by_client_msg_id(db, actor.id, client_msg_id)
    if existing is not None:
        # A retry gets its call back, whatever changed since (as a retried message does).
        if existing.channel_id != channel_id or existing.call_url is None:
            raise conflict(
                "idempotency_conflict",
                "client_msg_id was already used for another message",
            )
        return existing, False
    channel, _ = await channels.require_member(db, actor.id, channel_id)
    channels.require_writable(channel)
    base = await workspace.meeting_base_url(db)
    if base is None:
        raise conflict("calls_disabled", "Calls are turned off in this workspace")
    url = base + room_name()
    return await messages.create_message(
        db,
        actor,
        channel_id,
        MessageCreate(client_msg_id=client_msg_id, body=call_body(url)),
        call_url=url,
    )
