import uuid
from datetime import datetime

from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy import exists as sql_exists
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlalchemy.sql.elements import ColumnElement

from app.modules.channels.models import ChannelMember
from app.modules.drafts.models import Draft
from app.modules.messages.models import Message  # read-only: live thread parents


def _live_parent() -> ColumnElement[bool]:
    """Channel drafts, and thread drafts whose parent still exists (messages are soft-deleted,
    so the foreign key's ON DELETE CASCADE never fires)."""
    parent = aliased(Message)
    return or_(
        Draft.parent_id.is_(None),
        sql_exists(
            select(parent.id).where(parent.id == Draft.parent_id, parent.deleted_at.is_(None))
        ),
    )


async def list_for(db: AsyncSession, user_id: uuid.UUID) -> list[Draft]:
    """My drafts in conversations I still belong to, newest first."""
    stmt = (
        select(Draft)
        .join(
            ChannelMember,
            and_(ChannelMember.channel_id == Draft.channel_id, ChannelMember.user_id == user_id),
        )
        .where(Draft.user_id == user_id, _live_parent())
        .order_by(Draft.updated_at.desc())
    )
    return list((await db.execute(stmt)).scalars().all())


def _composer(
    user_id: uuid.UUID, channel_id: uuid.UUID, parent_id: uuid.UUID | None
) -> ColumnElement[bool]:
    parent = Draft.parent_id.is_(None) if parent_id is None else Draft.parent_id == parent_id
    return and_(Draft.user_id == user_id, Draft.channel_id == channel_id, parent)


async def exists(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, parent_id: uuid.UUID | None
) -> bool:
    stmt = select(func.count()).select_from(Draft).where(_composer(user_id, channel_id, parent_id))
    return bool((await db.execute(stmt)).scalar_one())


async def count_for(db: AsyncSession, user_id: uuid.UUID) -> int:
    stmt = select(func.count()).select_from(Draft).where(Draft.user_id == user_id, _live_parent())
    return int((await db.execute(stmt)).scalar_one())


async def upsert(
    db: AsyncSession,
    user_id: uuid.UUID,
    channel_id: uuid.UUID,
    parent_id: uuid.UUID | None,
    body: str,
    now: datetime,
) -> Draft:
    stmt = (
        pg_insert(Draft)
        .values(
            user_id=user_id, channel_id=channel_id, parent_id=parent_id, body=body, updated_at=now
        )
        .on_conflict_do_update(
            index_elements=[Draft.user_id, Draft.channel_id, Draft.parent_id],
            set_={"body": body, "updated_at": now},
        )
        .returning(Draft)
    )
    return (await db.execute(stmt)).scalar_one()


async def remove(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, parent_id: uuid.UUID | None
) -> bool:
    result = await db.execute(delete(Draft).where(_composer(user_id, channel_id, parent_id)))
    return bool(getattr(result, "rowcount", 0))  # a CursorResult at runtime (DML)
