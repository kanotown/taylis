import uuid
from datetime import datetime

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attachments.models import Attachment
from app.modules.channels.models import ChannelMember
from app.modules.messages.models import Message


async def get(db: AsyncSession, attachment_id: uuid.UUID) -> Attachment | None:
    return await db.get(Attachment, attachment_id)


async def get_many(db: AsyncSession, ids: list[uuid.UUID]) -> list[Attachment]:
    if not ids:
        return []
    stmt = select(Attachment).where(Attachment.id.in_(ids))
    return list((await db.execute(stmt)).scalars().all())


async def for_messages(db: AsyncSession, message_ids: list[uuid.UUID]) -> list[Attachment]:
    if not message_ids:
        return []
    stmt = (
        select(Attachment)
        .where(Attachment.message_id.in_(message_ids), Attachment.status == "attached")
        .order_by(Attachment.created_at.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def for_message(db: AsyncSession, message_id: uuid.UUID) -> list[Attachment]:
    stmt = select(Attachment).where(Attachment.message_id == message_id)
    return list((await db.execute(stmt)).scalars().all())


async def expired_pending(db: AsyncSession, before: datetime, limit: int) -> list[Attachment]:
    stmt = (
        select(Attachment)
        .where(Attachment.status == "pending", Attachment.created_at < before)
        .order_by(Attachment.created_at.asc())
        .limit(limit)
    )
    return list((await db.execute(stmt)).scalars().all())


async def deleted(db: AsyncSession, limit: int) -> list[Attachment]:
    stmt = (
        select(Attachment)
        .where(Attachment.status == "deleted")
        .order_by(Attachment.deleted_at.asc())
        .limit(limit)
    )
    return list((await db.execute(stmt)).scalars().all())


async def list_attached(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    channel_id: uuid.UUID | None,
    query: str | None,
    before: tuple[datetime, uuid.UUID] | None,
    limit: int,
) -> list[tuple[Attachment, uuid.UUID | None]]:
    """Files attached to messages in the user's channels, newest first (M11i).

    Each row carries the message's parent_id so a client can reveal a thread reply.
    Keyset paging on (attached_at, id): attachments of one message share an attached_at.
    """
    stmt = (
        select(Attachment, Message.parent_id)
        .join(Message, Message.id == Attachment.message_id)
        .join(
            ChannelMember,
            and_(
                ChannelMember.channel_id == Attachment.channel_id,
                ChannelMember.user_id == user_id,
            ),
        )
        .where(Attachment.status == "attached", Attachment.deleted_at.is_(None))
        .order_by(Attachment.attached_at.desc(), Attachment.id.desc())
        .limit(limit)
    )
    if channel_id is not None:
        stmt = stmt.where(Attachment.channel_id == channel_id)
    if query:
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        stmt = stmt.where(Attachment.filename.ilike(f"%{escaped}%", escape="\\"))
    if before is not None:
        at, last_id = before
        stmt = stmt.where(
            or_(
                Attachment.attached_at < at,
                and_(Attachment.attached_at == at, Attachment.id < last_id),
            )
        )
    return [(row[0], row[1]) for row in (await db.execute(stmt)).all()]


async def all_live(db: AsyncSession) -> list[Attachment]:
    stmt = select(Attachment).where(Attachment.status != "deleted")
    return list((await db.execute(stmt)).scalars().all())
