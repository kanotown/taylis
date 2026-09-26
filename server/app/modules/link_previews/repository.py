from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.link_previews.models import LinkPreview


async def get(db: AsyncSession, url_hash: str) -> LinkPreview | None:
    return await db.get(LinkPreview, url_hash)


async def put(db: AsyncSession, row: LinkPreview) -> LinkPreview:
    return await db.merge(row)
