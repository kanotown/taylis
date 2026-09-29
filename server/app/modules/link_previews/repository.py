from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.link_previews.models import LinkPreview


async def get(db: AsyncSession, url_hash: str) -> LinkPreview | None:
    return await db.get(LinkPreview, url_hash)


async def put(db: AsyncSession, row: LinkPreview) -> LinkPreview:
    """An upsert: two requests for the same uncached page fetch it at the same time, and the
    second must overwrite the first's row, not fail on the key."""
    fields = {
        "url": row.url,
        "status": row.status,
        "title": row.title,
        "description": row.description,
        "image_url": row.image_url,
        "site_name": row.site_name,
        "fetched_at": row.fetched_at,
    }
    stmt = pg_insert(LinkPreview).values(url_hash=row.url_hash, **fields)
    await db.execute(stmt.on_conflict_do_update(index_elements=["url_hash"], set_=fields))
    return row
