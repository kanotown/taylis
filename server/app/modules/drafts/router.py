from uuid import UUID

from fastapi import APIRouter, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.drafts import service
from app.modules.drafts.schemas import DraftOut, DraftPut

router = APIRouter(tags=["drafts"])


@router.get("/drafts", response_model=list[DraftOut])
async def list_drafts(user: CurrentUser, db: Db) -> list[DraftOut]:
    """M15d: my drafts in conversations I belong to, newest first (also in bootstrap)."""
    return await service.list_for(db, user.id)


@router.put("/drafts", response_model=DraftOut)
async def save_draft(user: CurrentUser, body: DraftPut, db: Db) -> DraftOut:
    """Save one composer's text (a conversation, or a thread with `parent_id`)."""
    return await service.save(db, user, body)


@router.delete("/drafts", status_code=204)
async def delete_draft(
    user: CurrentUser, db: Db, channel_id: UUID, parent_id: UUID | None = None
) -> Response:
    """The composer was emptied or its text sent; a missing draft is not an error."""
    await service.delete(db, user, channel_id, parent_id)
    return Response(status_code=204)
