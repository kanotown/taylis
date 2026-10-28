import uuid
from datetime import datetime

from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attachments.models import Attachment
from app.modules.channels.models import ChannelMember
from app.modules.messages.models import Message


async def get(db: AsyncSession, attachment_id: uuid.UUID) -> Attachment | None:
    return await db.get(Attachment, attachment_id)


async def get_many(
    db: AsyncSession, ids: list[uuid.UUID], *, for_update: bool = False
) -> list[Attachment]:
    if not ids:
        return []
    stmt = select(Attachment).where(Attachment.id.in_(ids))
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return list((await db.execute(stmt)).scalars().all())


async def for_messages(db: AsyncSession, message_ids: list[uuid.UUID]) -> list[Attachment]:
    """The messages' attachments; CF1: a posted file purged from the drive too (its tombstone,
    drive_state 'deleted', status deleted or purged), shown as 「削除されたファイル」."""
    if not message_ids:
        return []
    stmt = (
        select(Attachment)
        .where(
            Attachment.message_id.in_(message_ids),
            or_(Attachment.status == "attached", Attachment.drive_state == "deleted"),
        )
        .order_by(Attachment.created_at.asc(), Attachment.id.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def for_message(
    db: AsyncSession, message_id: uuid.UUID, *, for_update: bool = False
) -> list[Attachment]:
    stmt = select(Attachment).where(Attachment.message_id == message_id)
    if for_update:
        stmt = (
            stmt.order_by(Attachment.id).with_for_update().execution_options(populate_existing=True)
        )
    return list((await db.execute(stmt)).scalars().all())


# CF1: the drive version each posted file is (plain SQL: attachments does not import the drive).
_DRIVE_VERSIONS = text(
    "SELECT attachment_id, id, number FROM drive_file_versions "
    "WHERE attachment_id = ANY(CAST(:ids AS uuid[]))"
)


async def drive_versions(
    db: AsyncSession, attachment_ids: list[uuid.UUID]
) -> dict[uuid.UUID, tuple[uuid.UUID, int]]:
    """{attachment id: (version id, version number)} of the rows that are drive versions."""
    if not attachment_ids:
        return {}
    rows = await db.execute(_DRIVE_VERSIONS, {"ids": [str(i) for i in attachment_ids]})
    return {row[0]: (row[1], int(row[2])) for row in rows.all()}


async def for_canvases(db: AsyncSession, canvas_ids: list[uuid.UUID]) -> list[Attachment]:
    """Every attachment bound to these canvases (any status but deleted)."""
    if not canvas_ids:
        return []
    stmt = select(Attachment).where(
        Attachment.canvas_id.in_(canvas_ids), Attachment.status != "deleted"
    )
    return list((await db.execute(stmt)).scalars().all())


async def for_pages(db: AsyncSession, page_ids: list[uuid.UUID]) -> list[Attachment]:
    """Every attachment bound to these wiki pages (any status but deleted)."""
    if not page_ids:
        return []
    stmt = select(Attachment).where(
        Attachment.page_id.in_(page_ids), Attachment.status != "deleted"
    )
    return list((await db.execute(stmt)).scalars().all())


async def count_for_page(db: AsyncSession, page_id: uuid.UUID) -> int:
    stmt = (
        select(func.count())
        .select_from(Attachment)
        .where(Attachment.page_id == page_id, Attachment.status == "attached")
    )
    return int((await db.execute(stmt)).scalar_one())


async def count_for_canvas(db: AsyncSession, canvas_id: uuid.UUID) -> int:
    stmt = (
        select(func.count())
        .select_from(Attachment)
        .where(Attachment.canvas_id == canvas_id, Attachment.status == "attached")
    )
    return int((await db.execute(stmt)).scalar_one())


async def expired_pending(db: AsyncSession, before: datetime, limit: int) -> list[Attachment]:
    stmt = (
        select(Attachment)
        .where(Attachment.status == "pending", Attachment.created_at < before)
        .order_by(Attachment.created_at.asc())
        .limit(limit)
    )
    return list((await db.execute(stmt)).scalars().all())


async def deleted(db: AsyncSession, limit: int) -> list[tuple[Attachment, bool]]:
    """Rows to purge, each with whether it stays as a tombstone (CF1, docs/CHANNEL_FILES.md
    §7.5: a posted file purged from the drive while its message is alive)."""
    stmt = (
        select(Attachment, Message.deleted_at)
        .outerjoin(Message, Message.id == Attachment.message_id)
        .where(Attachment.status == "deleted")
        .order_by(Attachment.deleted_at.asc())
        .limit(limit)
    )
    return [
        (
            row[0],
            row[0].drive_state == "deleted" and row[0].message_id is not None and row[1] is None,
        )
        for row in (await db.execute(stmt)).all()
    ]


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
    Keyset paging on (attached_at DESC, id ASC): the files of one message share an attached_at
    and keep their upload order (UUIDv7 ids), the order the message itself shows them in.
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
        .where(
            Attachment.status == "attached",
            Attachment.deleted_at.is_(None),
            # CF1 (docs/CHANNEL_FILES.md §2): a posted file moved to another location or in the
            # trash is not the channel's any more.
            or_(Attachment.drive_state.is_(None), Attachment.drive_state == "available"),
        )
        .order_by(Attachment.attached_at.desc(), Attachment.id.asc())
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
                and_(Attachment.attached_at == at, Attachment.id > last_id),
            )
        )
    return [(row[0], row[1]) for row in (await db.execute(stmt)).all()]


async def all_live(db: AsyncSession) -> list[Attachment]:
    """Rows whose bytes should be in the store (not deleted, not a CF1 tombstone)."""
    stmt = select(Attachment).where(Attachment.status.not_in(("deleted", "purged")))
    return list((await db.execute(stmt)).scalars().all())
