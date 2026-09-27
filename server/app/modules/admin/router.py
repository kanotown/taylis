from uuid import UUID

from fastapi import APIRouter

from app.core.db import Db
from app.modules.admin import service
from app.modules.admin.schemas import (
    AdminUserCreate,
    AdminUserCreated,
    AdminUserOut,
    AdminUserUpdate,
    TemporaryPasswordOut,
    to_admin_out,
)
from app.modules.auth.deps import CurrentAdmin
from app.modules.totp import service as totp

router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/users", response_model=AdminUserCreated, status_code=201)
async def create_user(actor: CurrentAdmin, body: AdminUserCreate, db: Db) -> AdminUserCreated:
    user, temporary = await service.create_user(db, body, actor=actor)
    return AdminUserCreated(user=to_admin_out(user), temporary_password=temporary)


@router.get("/users", response_model=list[AdminUserOut])
async def list_users(_: CurrentAdmin, db: Db) -> list[AdminUserOut]:
    users = await service.list_users(db)
    with_totp = await totp.enabled_user_ids(db, [u.id for u in users])
    return [to_admin_out(u, totp_enabled=u.id in with_totp) for u in users]


@router.patch("/users/{user_id}", response_model=AdminUserOut)
async def update_user(
    user_id: UUID, actor: CurrentAdmin, body: AdminUserUpdate, db: Db
) -> AdminUserOut:
    return to_admin_out(await service.update_user(db, actor, user_id, body))


@router.post("/users/{user_id}/reset-password", response_model=TemporaryPasswordOut)
async def reset_password(user_id: UUID, actor: CurrentAdmin, db: Db) -> TemporaryPasswordOut:
    return TemporaryPasswordOut(temporary_password=await service.reset_password(db, actor, user_id))


@router.delete("/users/{user_id}/sessions", status_code=204)
async def revoke_sessions(user_id: UUID, actor: CurrentAdmin, db: Db) -> None:
    await service.revoke_sessions(db, actor, user_id)


@router.post("/users/{user_id}/anonymize", response_model=AdminUserOut)
async def anonymize_user(user_id: UUID, actor: CurrentAdmin, db: Db) -> AdminUserOut:
    """Erase the identity and end all sessions; messages stay under a generic name (M10)."""
    return to_admin_out(await service.anonymize_user(db, actor, user_id))
