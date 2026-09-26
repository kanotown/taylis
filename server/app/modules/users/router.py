from uuid import UUID

from fastapi import APIRouter

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.users import service
from app.modules.users.schemas import UserMe, UserPublic, UserUpdate, to_user_me, to_user_public

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[UserPublic])
async def list_users(_: CurrentUser, db: Db) -> list[UserPublic]:
    return [to_user_public(user) for user in await service.list_users(db)]


@router.get("/me", response_model=UserMe, name="users:me")
async def get_me(user: CurrentUser) -> UserMe:
    return to_user_me(user)


@router.patch("/me", response_model=UserMe)
async def update_me(user: CurrentUser, body: UserUpdate, db: Db) -> UserMe:
    return to_user_me(await service.update_me(db, user.id, body))


@router.get("/{user_id}", response_model=UserPublic)
async def get_user(user_id: UUID, _: CurrentUser, db: Db) -> UserPublic:
    return to_user_public(await service.require_user(db, user_id))
