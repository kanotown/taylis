from uuid import UUID

from fastapi import APIRouter

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.channels import service as channels  # M13e guest visibility (ARCHITECTURE.md §5)
from app.modules.users import service
from app.modules.users.schemas import UserMe, UserPublic, UserUpdate, to_user_me, to_user_public

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[UserPublic])
async def list_users(user: CurrentUser, db: Db) -> list[UserPublic]:
    rows = await service.list_users(db)
    if user.is_guest:  # M13e: only the people who share a channel with the guest
        visible = await channels.shared_member_ids(db, user.id)
        rows = [u for u in rows if u.id in visible]
    return [to_user_public(u) for u in rows]


@router.get("/me", response_model=UserMe, name="users:me")
async def get_me(user: CurrentUser) -> UserMe:
    return to_user_me(user)


@router.patch("/me", response_model=UserMe)
async def update_me(user: CurrentUser, body: UserUpdate, db: Db) -> UserMe:
    return to_user_me(await service.update_me(db, user.id, body))


@router.get("/{user_id}", response_model=UserPublic)
async def get_user(user_id: UUID, _: CurrentUser, db: Db) -> UserPublic:
    return to_user_public(await service.require_user(db, user_id))
