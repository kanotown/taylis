import uuid

from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.templates.models import MessageTemplate


async def get(db: AsyncSession, template_id: uuid.UUID) -> MessageTemplate | None:
    return await db.get(MessageTemplate, template_id)


def _visible(user_id: uuid.UUID):  # type: ignore[no-untyped-def]
    return or_(
        MessageTemplate.scope == "workspace",
        (MessageTemplate.scope == "user") & (MessageTemplate.owner_id == user_id),
    )


async def list_for(db: AsyncSession, user_id: uuid.UUID) -> list[MessageTemplate]:
    """The workspace's, then mine; each by position, then name."""
    rows = await db.execute(
        select(MessageTemplate)
        .where(_visible(user_id))
        .order_by(
            case((MessageTemplate.scope == "workspace", 0), else_=1),
            MessageTemplate.position,
            func.lower(MessageTemplate.name),
        )
    )
    return list(rows.scalars().all())


async def name_taken(
    db: AsyncSession,
    scope: str,
    owner_id: uuid.UUID | None,
    name: str,
    *,
    except_id: uuid.UUID | None = None,
) -> bool:
    query = select(MessageTemplate.id).where(
        MessageTemplate.scope == scope, func.lower(MessageTemplate.name) == name.lower()
    )
    if scope == "user":
        query = query.where(MessageTemplate.owner_id == owner_id)
    if except_id is not None:
        query = query.where(MessageTemplate.id != except_id)
    return (await db.execute(query.limit(1))).first() is not None


async def count_in(db: AsyncSession, scope: str, owner_id: uuid.UUID | None) -> int:
    query = select(func.count()).select_from(MessageTemplate).where(MessageTemplate.scope == scope)
    if scope == "user":
        query = query.where(MessageTemplate.owner_id == owner_id)
    return int((await db.execute(query)).scalar_one())


async def next_position(db: AsyncSession, scope: str, owner_id: uuid.UUID | None) -> int:
    query = select(func.max(MessageTemplate.position)).where(MessageTemplate.scope == scope)
    if scope == "user":
        query = query.where(MessageTemplate.owner_id == owner_id)
    last = (await db.execute(query)).scalar_one()
    return 0 if last is None else int(last) + 1
