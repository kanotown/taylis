"""Drafts shared by my devices (M15d).

One draft per composer (a conversation, or a thread in it). Clients save the text a moment after
typing stops and delete it when the composer empties (including after sending); every change
reaches my other devices as `draft.updated`. The rule for conflicts lives in the clients: a
device with unsaved local edits keeps them (SYNC_PROTOCOL.md "下書きの同期").
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import conflict, not_found
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.channels import service as channels
from app.modules.drafts import repository as repo
from app.modules.drafts.events import DRAFT_UPDATED
from app.modules.drafts.models import Draft
from app.modules.drafts.schemas import MAX_DRAFTS, DraftOut, DraftPut, DraftUpdatedData
from app.modules.messages import service as messages
from app.modules.users.models import User


def to_out(row: Draft) -> DraftOut:
    return DraftOut(
        channel_id=row.channel_id, parent_id=row.parent_id, body=row.body, updated_at=row.updated_at
    )


async def list_for(db: AsyncSession, user_id: uuid.UUID) -> list[DraftOut]:
    return [to_out(row) for row in await repo.list_for(db, user_id)]


async def _emit(db: AsyncSession, user_id: uuid.UUID, data: DraftUpdatedData) -> None:
    await write_outbox(
        db,
        event_type=DRAFT_UPDATED,
        audience_type="user",
        audience_id=user_id,
        payload=data.model_dump(mode="json"),
    )


async def save(db: AsyncSession, actor: User, data: DraftPut) -> DraftOut:
    await channels.require_member(db, actor.id, data.channel_id)
    if data.parent_id is not None:
        parent = await messages.get_message(db, actor, data.parent_id)
        if parent.channel_id != data.channel_id or parent.parent_id is not None:
            raise not_found("message_not_found", "Parent message not found")
    if (
        not await repo.exists(db, actor.id, data.channel_id, data.parent_id)
        and await repo.count_for(db, actor.id) >= MAX_DRAFTS
    ):
        raise conflict("too_many_drafts", f"At most {MAX_DRAFTS} drafts")
    row = await repo.upsert(db, actor.id, data.channel_id, data.parent_id, data.body, utcnow())
    out = to_out(row)
    await _emit(db, actor.id, DraftUpdatedData(**out.model_dump()))
    await db.commit()
    return out


async def delete(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, parent_id: uuid.UUID | None
) -> None:
    """Idempotent: deleting a draft that is not there changes nothing and tells no one."""
    if not await repo.remove(db, actor.id, channel_id, parent_id):
        return
    await _emit(
        db,
        actor.id,
        DraftUpdatedData(
            channel_id=channel_id, parent_id=parent_id, body="", updated_at=utcnow(), deleted=True
        ),
    )
    await db.commit()
