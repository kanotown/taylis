from uuid import UUID

from fastapi import APIRouter, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.templates import service
from app.modules.templates.schemas import TemplateCreate, TemplateOut, TemplateUpdate

router = APIRouter(tags=["templates"])


@router.get("/templates", response_model=list[TemplateOut])
async def list_templates(user: CurrentUser, db: Db) -> list[TemplateOut]:
    """M30: the workspace's templates, then mine (also part of bootstrap)."""
    return await service.list_for(db, user)


@router.post("/templates", response_model=TemplateOut, status_code=201)
async def create_template(body: TemplateCreate, user: CurrentUser, db: Db) -> TemplateOut:
    """A personal template, or (admins) one for the whole workspace."""
    return await service.create(db, user, body)


@router.patch("/templates/{template_id}", response_model=TemplateOut)
async def update_template(
    template_id: UUID, body: TemplateUpdate, user: CurrentUser, db: Db
) -> TemplateOut:
    return await service.update(db, user, template_id, body)


@router.delete("/templates/{template_id}", status_code=204)
async def delete_template(template_id: UUID, user: CurrentUser, db: Db) -> Response:
    await service.delete(db, user, template_id)
    return Response(status_code=204)
