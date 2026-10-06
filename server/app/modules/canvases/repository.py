import uuid
from datetime import datetime, timedelta

from sqlalchemy import and_, delete, func, or_, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.doctext.revisions import thin_statement
from app.modules.canvases.models import Canvas, CanvasRevision, CanvasTemplate


async def get(db: AsyncSession, canvas_id: uuid.UUID, *, lock: bool = False) -> Canvas | None:
    stmt = select(Canvas).where(Canvas.id == canvas_id)
    if lock:
        # Saves to one canvas run one at a time (like channels.last_seq for messages).
        # populate_existing: the body as it is now, also when this session read the row before.
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


async def list_for_channel(
    db: AsyncSession, channel_id: uuid.UUID, *, trashed: bool = False
) -> list[Canvas]:
    deleted = Canvas.deleted_at.is_not(None) if trashed else Canvas.deleted_at.is_(None)
    stmt = (
        select(Canvas)
        .where(Canvas.channel_id == channel_id, deleted)
        .order_by(Canvas.updated_at.desc(), Canvas.id.desc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def list_for_channels(
    db: AsyncSession,
    channel_ids: list[uuid.UUID],
    *,
    before: tuple[datetime, uuid.UUID] | None,
    limit: int,
) -> list[Canvas]:
    """Live canvases of these conversations, most recently updated first (keyset)."""
    if not channel_ids:
        return []
    stmt = select(Canvas).where(Canvas.channel_id.in_(channel_ids), Canvas.deleted_at.is_(None))
    if before is not None:
        at, last_id = before
        stmt = stmt.where(
            or_(Canvas.updated_at < at, and_(Canvas.updated_at == at, Canvas.id < last_id))
        )
    stmt = stmt.order_by(Canvas.updated_at.desc(), Canvas.id.desc()).limit(limit)
    return list((await db.execute(stmt)).scalars().all())


async def count_live(db: AsyncSession, channel_id: uuid.UUID) -> int:
    stmt = (
        select(func.count())
        .select_from(Canvas)
        .where(Canvas.channel_id == channel_id, Canvas.deleted_at.is_(None))
    )
    return int((await db.execute(stmt)).scalar_one())


async def tab_of(db: AsyncSession, channel_id: uuid.UUID) -> Canvas | None:
    stmt = select(Canvas).where(
        Canvas.channel_id == channel_id, Canvas.is_channel_tab, Canvas.deleted_at.is_(None)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def tab_ids(db: AsyncSession, channel_ids: list[uuid.UUID]) -> dict[uuid.UUID, uuid.UUID]:
    """channel id → its canvas tab's id (for bootstrap's ChannelOut.canvas_tab_id)."""
    if not channel_ids:
        return {}
    stmt = select(Canvas.channel_id, Canvas.id).where(
        Canvas.channel_id.in_(channel_ids), Canvas.is_channel_tab, Canvas.deleted_at.is_(None)
    )
    return {row[0]: row[1] for row in (await db.execute(stmt)).all()}


async def get_revision(db: AsyncSession, revision_id: uuid.UUID) -> CanvasRevision | None:
    return await db.get(CanvasRevision, revision_id)


async def revision_by_save_id(
    db: AsyncSession, author_id: uuid.UUID, client_save_id: uuid.UUID
) -> CanvasRevision | None:
    stmt = select(CanvasRevision).where(
        CanvasRevision.author_id == author_id, CanvasRevision.client_save_id == client_save_id
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def list_revisions(
    db: AsyncSession,
    canvas_id: uuid.UUID,
    *,
    before: tuple[datetime, uuid.UUID] | None,
    limit: int,
) -> list[CanvasRevision]:
    """The history, newest first; side versions (bases of merged saves) are left out."""
    stmt = select(CanvasRevision).where(
        CanvasRevision.canvas_id == canvas_id, CanvasRevision.kind != "side"
    )
    if before is not None:
        at, last_id = before
        stmt = stmt.where(
            or_(
                CanvasRevision.created_at < at,
                and_(CanvasRevision.created_at == at, CanvasRevision.id < last_id),
            )
        )
    stmt = stmt.order_by(CanvasRevision.created_at.desc(), CanvasRevision.id.desc()).limit(limit)
    return list((await db.execute(stmt)).scalars().all())


async def export_rows(db: AsyncSession, channel_id: uuid.UUID) -> list[Canvas]:
    stmt = (
        select(Canvas)
        .where(Canvas.channel_id == channel_id, Canvas.deleted_at.is_(None))
        .order_by(Canvas.created_at, Canvas.id)
    )
    return list((await db.execute(stmt)).scalars().all())


# --- housekeeping (CANVAS.md §4.9, §4.10, §4.14) -------------------------------------------------


async def delete_side_revisions(db: AsyncSession, before: datetime) -> int:
    """Side versions (the bases of merged saves) older than `before`."""
    result = await db.execute(
        delete(CanvasRevision).where(
            CanvasRevision.kind == "side", CanvasRevision.created_at < before
        )
    )
    return int(getattr(result, "rowcount", 0) or 0)


# CANVAS.md §4.9: the thinning policy (app/core/doctext/revisions.py) on the canvases' tables. A
# task version (M80) is thinned like a save.
_THIN = thin_statement(
    revisions="canvas_revisions",
    documents="canvases",
    fk="canvas_id",
    thinnable=("save", "merge", "task"),
)


async def thin_revisions(
    db: AsyncSession, *, before: datetime, since: datetime, bucket: timedelta
) -> int:
    result = await db.execute(_THIN, {"before": before, "since": since, "bucket": bucket})
    return int(getattr(result, "rowcount", 0) or 0)


async def trashed_before(db: AsyncSession, before: datetime, limit: int) -> list[Canvas]:
    stmt = (
        select(Canvas)
        .where(Canvas.deleted_at.is_not(None), Canvas.deleted_at < before)
        .order_by(Canvas.deleted_at, Canvas.id)
        .limit(limit)
    )
    return list((await db.execute(stmt)).scalars().all())


async def revision_counts(db: AsyncSession, canvas_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not canvas_ids:
        return {}
    stmt = (
        select(CanvasRevision.canvas_id, func.count())
        .where(CanvasRevision.canvas_id.in_(canvas_ids))
        .group_by(CanvasRevision.canvas_id)
    )
    return {row[0]: int(row[1]) for row in (await db.execute(stmt)).all()}


async def delete_canvases(db: AsyncSession, canvas_ids: list[uuid.UUID]) -> None:
    """For good: the versions go with them (ON DELETE CASCADE)."""
    if canvas_ids:
        await db.execute(delete(Canvas).where(Canvas.id.in_(canvas_ids)))


# Images bound to a canvas before :bound_before that neither the canvas's body nor any version
# it keeps refers to (the id in either case). Reads attachments (canvases → attachments); the
# attachments module marks them deleted.
_UNREFERENCED_IMAGES = text(
    """
    SELECT a.id FROM attachments a
    WHERE a.canvas_id IS NOT NULL AND a.status = 'attached' AND a.attached_at < :bound_before
      AND NOT EXISTS (
          SELECT 1 FROM canvases c WHERE c.id = a.canvas_id
             AND (strpos(c.body, a.id::text) > 0 OR strpos(c.body, upper(a.id::text)) > 0))
      AND NOT EXISTS (
          SELECT 1 FROM canvas_revisions r WHERE r.canvas_id = a.canvas_id
             AND (strpos(r.body, a.id::text) > 0 OR strpos(r.body, upper(a.id::text)) > 0))
    ORDER BY a.attached_at
    LIMIT :limit
    """
)


async def unreferenced_images(
    db: AsyncSession, *, bound_before: datetime, limit: int
) -> list[uuid.UUID]:
    rows = await db.execute(_UNREFERENCED_IMAGES, {"bound_before": bound_before, "limit": limit})
    return [row[0] for row in rows.all()]


# --- templates ---------------------------------------------------------------------------------


async def list_templates(db: AsyncSession, *, include_hidden: bool) -> list[CanvasTemplate]:
    stmt = select(CanvasTemplate)
    if not include_hidden:
        stmt = stmt.where(CanvasTemplate.hidden.is_(False))
    stmt = stmt.order_by(CanvasTemplate.position, CanvasTemplate.name, CanvasTemplate.id)
    return list((await db.execute(stmt)).scalars().all())


async def get_template(db: AsyncSession, template_id: uuid.UUID) -> CanvasTemplate | None:
    return await db.get(CanvasTemplate, template_id)


async def template_by_key(db: AsyncSession, key: str) -> CanvasTemplate | None:
    stmt = select(CanvasTemplate).where(CanvasTemplate.key == key)
    return (await db.execute(stmt)).scalar_one_or_none()


async def next_template_position(db: AsyncSession) -> int:
    last = (await db.execute(select(func.max(CanvasTemplate.position)))).scalar_one()
    return 0 if last is None else int(last) + 1


async def insert_template_if_missing(db: AsyncSession, values: dict[str, object]) -> bool:
    stmt = (
        insert(CanvasTemplate)
        .values(**values)
        .on_conflict_do_nothing(index_elements=[CanvasTemplate.key])
    )
    result = await db.execute(stmt)
    return bool(getattr(result, "rowcount", 0))
