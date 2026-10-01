import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import bad_request
from app.core.time import utcnow
from app.modules.channels import service as channels
from app.modules.messages import service as messages
from app.modules.notifications import service as notifications
from app.modules.reads import rules as unread_rules
from app.modules.times_feed import repository as repo
from app.modules.times_feed.schemas import TimesFeedOut
from app.modules.users.models import User


async def feed_channel_ids(db: AsyncSession, actor: User) -> list[uuid.UUID]:
    """The times I am a member of (archived ones too) and have not muted (TIMES_FEED.md §2)."""
    mine = await channels.list_channels(db, actor, include_public=False)
    prefs = await notifications.preferences_for(db, actor.id)
    now = utcnow()
    out: list[uuid.UUID] = []
    for c in mine:
        if c.times_owner_id is None:
            continue
        pref = prefs.get(c.id)
        conversation = unread_rules.Conversation(
            is_dm=False,
            others_times=c.times_owner_id != actor.id,
            level=pref.level if pref is not None else None,
            muted=notifications.is_muted(pref, now),
            unread=0,
            mentions=0,
        )
        if not unread_rules.is_muted(conversation):
            out.append(c.id)
    return out


def encode_cursor(created_at: datetime, message_id: uuid.UUID) -> str:
    return f"{created_at.isoformat()}_{message_id}"


def decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    at, sep, message_id = cursor.rpartition("_")
    try:
        if not sep:
            raise ValueError(cursor)
        parsed_at = datetime.fromisoformat(at)
        if parsed_at.tzinfo is None:
            raise ValueError(cursor)
        return parsed_at, uuid.UUID(message_id)
    except ValueError:
        raise bad_request("invalid_cursor", "The cursor is not one this server gave") from None


async def feed(db: AsyncSession, actor: User, *, cursor: str | None, limit: int) -> TimesFeedOut:
    before = decode_cursor(cursor) if cursor else None
    channel_ids = await feed_channel_ids(db, actor)
    rows = await repo.feed_page(db, channel_ids, before=before, limit=limit)
    items = await messages.messages_out(db, rows, actor.id)
    last = rows[-1] if len(rows) == limit else None
    return TimesFeedOut(
        items=items,
        next_cursor=encode_cursor(last.created_at, last.id) if last is not None else None,
    )
