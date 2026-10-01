import uuid
from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import bindparam, select, text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.messages.models import Message

# The newest `limit` timeline rows of each channel first (LATERAL), then the newest `limit` of
# those: one short index walk per channel. `channel_id IN (...) ORDER BY created_at` instead reads
# rows in proportion to the history (43 ms against 0.95 ms on 465k messages, LAB.md §5).
_FEED = text(
    """
    SELECT m.id FROM unnest(:channel_ids) AS c(id)
    CROSS JOIN LATERAL (
        SELECT id, created_at FROM messages
        WHERE channel_id = c.id AND deleted_at IS NULL AND type = 'user'
          AND (parent_id IS NULL OR also_in_channel)
          AND (CAST(:before_at AS timestamptz) IS NULL
               OR (created_at, id) < (CAST(:before_at AS timestamptz), CAST(:before_id AS uuid)))
        ORDER BY created_at DESC, id DESC
        LIMIT :limit
    ) m
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT :limit
    """
).bindparams(bindparam("channel_ids", type_=ARRAY(UUID(as_uuid=True))))


async def feed_page(
    db: AsyncSession,
    channel_ids: Sequence[uuid.UUID],
    *,
    before: tuple[datetime, uuid.UUID] | None,
    limit: int,
) -> list[Message]:
    if not channel_ids:
        return []
    params = {
        "channel_ids": list(channel_ids),
        "before_at": before[0] if before else None,
        "before_id": before[1] if before else None,
        "limit": limit,
    }
    ids = [row[0] for row in (await db.execute(_FEED, params)).all()]
    if not ids:
        return []
    loaded = await db.execute(select(Message).where(Message.id.in_(ids)))
    found = {m.id: m for m in loaded.scalars()}
    return [found[i] for i in ids if i in found]
