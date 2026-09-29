"""Incoming webhooks (M13a): a URL token that posts into one channel as its own bot user.

Each webhook owns a user with role `bot` (cannot log in, no password anyone knows) and a
membership of its channel, so a post goes through the ordinary message path: seq, outbox,
mentions, pushes and search need nothing special. The token is random and stored hashed; the
response of `create` is the one time it is shown.
"""

import re
import secrets
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, conflict, forbidden, not_found
from app.core.security import hash_token
from app.core.time import utcnow
from app.modules.admin import service as admin
from app.modules.audit import service as audit
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.messages import service as messages
from app.modules.messages.schemas import MessageCreate
from app.modules.users import service as users
from app.modules.users.models import User
from app.modules.webhooks import repository as repo
from app.modules.webhooks.models import Webhook
from app.modules.webhooks.schemas import (
    WebhookCreate,
    WebhookOut,
    WebhookPost,
    WebhookUpdate,
    to_webhook_out,
)

TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{20,128}$")


def _slug(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:20] or "hook"
    return f"hook-{base}-{secrets.token_hex(2)}"


async def _target_channel(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> Channel:
    """A public channel, or a private one the administrator belongs to: a webhook must not be
    a way into a private channel its maker could not post in (SECURITY.md §3.2)."""
    channel = await channels.require_channel(db, channel_id)
    if channel.is_dm:
        raise AppError(400, "invalid_channel", "Webhooks post to channels, not direct messages")
    if channel.is_archived:
        raise conflict("channel_archived", "Channel is archived")
    if channel.type == "private" and await channels.membership_of(db, actor.id, channel.id) is None:
        raise forbidden("not_a_member", "You are not a member of this channel")
    return channel


async def list_all(db: AsyncSession) -> list[WebhookOut]:
    return [to_webhook_out(row) for row in await repo.list_all(db)]


async def create(db: AsyncSession, actor: User, data: WebhookCreate) -> tuple[WebhookOut, str]:
    channel = await _target_channel(db, actor, data.channel_id)
    token = secrets.token_urlsafe(32)
    now = utcnow()
    bot = await admin.create_bot_in_tx(
        db, actor_id=actor.id, username=_slug(data.name), display_name=data.name.strip()
    )
    await channels.add_member_in_tx(db, channel, bot.id)
    row = Webhook(
        name=data.name.strip(),
        channel_id=channel.id,
        bot_user_id=bot.id,
        token_hash=hash_token(token),
        created_by=actor.id,
        enabled=True,
        post_count=0,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.flush()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="admin.webhook_created",
        target_type="webhook",
        target_id=row.id,
        details={"name": row.name, "channel_id": str(channel.id), "bot_user_id": str(bot.id)},
    )
    await db.commit()
    return to_webhook_out(row), token


async def update(
    db: AsyncSession, actor: User, webhook_id: uuid.UUID, data: WebhookUpdate
) -> WebhookOut:
    row = await repo.get(db, webhook_id, for_update=True)
    if row is None:
        raise not_found("webhook_not_found", "Webhook not found")
    bot = await users.require_user(db, row.bot_user_id)
    if data.name is not None:
        row.name = data.name.strip()
        bot.display_name = row.name
        bot.updated_at = utcnow()
    if data.channel_id is not None and data.channel_id != row.channel_id:
        target = await _target_channel(db, actor, data.channel_id)
        old = await channels.find_channel(db, row.channel_id)
        if old is not None:
            await channels.remove_member_in_tx(db, old, bot.id)
        await channels.add_member_in_tx(db, target, bot.id)
        row.channel_id = target.id
    if data.enabled is not None:
        row.enabled = data.enabled
    row.updated_at = utcnow()
    await db.flush()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="admin.webhook_updated",
        target_type="webhook",
        target_id=row.id,
        details=data.model_dump(exclude_none=True, mode="json"),
    )
    await db.commit()
    return to_webhook_out(row)


async def delete(db: AsyncSession, actor: User, webhook_id: uuid.UUID) -> None:
    """The bot user is deactivated (its messages stay); the token stops working at once."""
    row = await repo.get(db, webhook_id, for_update=True)
    if row is None:
        raise not_found("webhook_not_found", "Webhook not found")
    channel = await channels.find_channel(db, row.channel_id)
    if channel is not None:
        await channels.remove_member_in_tx(db, channel, row.bot_user_id)
    await admin.deactivate_bot_in_tx(db, row.bot_user_id)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="admin.webhook_deleted",
        target_type="webhook",
        target_id=row.id,
        details={"name": row.name},
    )
    await db.delete(row)
    await db.commit()


async def resolve(db: AsyncSession, token: str) -> Webhook:
    """The live webhook for a URL token; unknown and disabled ones look the same (404)."""
    if not TOKEN_PATTERN.match(token):
        raise not_found("webhook_not_found", "Webhook not found")
    row = await repo.get_by_token_hash(db, hash_token(token))
    if row is None or not row.enabled:
        raise not_found("webhook_not_found", "Webhook not found")
    return row


async def post(db: AsyncSession, webhook: Webhook, data: WebhookPost) -> uuid.UUID:
    bot = await users.require_user(db, webhook.bot_user_id)
    message, created = await messages.create_message(
        db,
        bot,
        webhook.channel_id,
        MessageCreate(client_msg_id=data.id or uuid.uuid4(), body=data.text),
    )
    if created:
        row = await repo.get(db, webhook.id, for_update=True)
        if row is not None:
            row.post_count += 1
            row.last_post_at = utcnow()
            await db.commit()
    return message.id
