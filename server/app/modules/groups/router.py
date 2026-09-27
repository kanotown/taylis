from uuid import UUID

from fastapi import APIRouter

from app.core.db import Db
from app.modules.auth.deps import CurrentAdmin, CurrentUser
from app.modules.groups import service
from app.modules.groups.schemas import GroupCreate, GroupOut, GroupUpdate

router = APIRouter(tags=["groups"])


@router.get("/groups", response_model=list[GroupOut])
async def list_groups(_: CurrentUser, db: Db) -> list[GroupOut]:
    """Every group with its members (M12k); also part of the bootstrap."""
    return await service.list_all(db)


@router.post("/admin/groups", response_model=GroupOut, status_code=201)
async def create_group(actor: CurrentAdmin, body: GroupCreate, db: Db) -> GroupOut:
    return await service.create(db, actor, body)


@router.patch("/admin/groups/{group_id}", response_model=GroupOut)
async def update_group(group_id: UUID, actor: CurrentAdmin, body: GroupUpdate, db: Db) -> GroupOut:
    return await service.update(db, actor, group_id, body)


@router.delete("/admin/groups/{group_id}", status_code=204)
async def delete_group(group_id: UUID, actor: CurrentAdmin, db: Db) -> None:
    await service.delete(db, actor, group_id)
