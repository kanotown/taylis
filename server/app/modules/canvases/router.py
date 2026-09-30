from uuid import UUID

from fastapi import APIRouter, Header, Query, Request, Response

from app.core.db import Db
from app.core.errors import rate_limited
from app.modules.auth.deps import CurrentUser
from app.modules.canvases import service
from app.modules.canvases.schemas import (
    CanvasConflictResponse,
    CanvasCreate,
    CanvasMeta,
    CanvasOut,
    CanvasPage,
    CanvasTemplateCreate,
    CanvasTemplateOut,
    CanvasTemplateUpdate,
    CanvasUpdate,
    ContentSave,
    RevisionMeta,
    RevisionOut,
    RevisionPage,
    RevisionRestore,
    RevisionUpdate,
    SaveOut,
)
from app.modules.users.models import User

router = APIRouter(tags=["canvases"])

# CANVAS.md §4.5. Access follows the conversation's membership (§4.7); saves are §4.4.


def _limit_saves(request: Request, user: User) -> None:
    """CANVAS.md §4.3: at most 120 saves per user per minute (settings.canvas_save_rate_limit)."""
    limiter = request.app.state.limiters["canvas_save"]
    key = str(user.id)
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))


def _base_url(request: Request) -> str:
    """The server's address as the client reached it (the proxies pass Host and
    X-Forwarded-Proto on): the permalinks in shared messages are built on it."""
    return str(request.base_url).rstrip("/")


def _etag(version: int) -> str:
    return f'"v{version}"'


@router.get("/channels/{channel_id}/canvases", response_model=list[CanvasMeta])
async def list_channel_canvases(
    channel_id: UUID,
    user: CurrentUser,
    db: Db,
    trashed: bool = Query(default=False, description="The trash instead (restorable)"),
) -> list[CanvasMeta]:
    """The conversation's canvases without bodies, most recently updated first."""
    return await service.list_for_channel(db, user, channel_id, trashed=trashed)


@router.post(
    "/channels/{channel_id}/canvases",
    response_model=CanvasOut,
    status_code=201,
    responses={200: {"model": CanvasOut, "description": "A retry: the canvas made before"}},
)
async def create_canvas(
    channel_id: UUID,
    user: CurrentUser,
    body: CanvasCreate,
    db: Db,
    request: Request,
    response: Response,
) -> CanvasOut:
    """A new canvas, empty or from a template (placeholders put in with `tz`)."""
    _limit_saves(request, user)
    canvas, created = await service.create(db, user, channel_id, body, base_url=_base_url(request))
    response.status_code = 201 if created else 200
    return canvas


@router.get("/canvases", response_model=CanvasPage)
async def list_my_canvases(
    user: CurrentUser,
    db: Db,
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
) -> CanvasPage:
    """The canvases of all my conversations, most recently updated first."""
    return await service.list_mine(db, user, cursor=cursor, limit=limit)


@router.get(
    "/canvases/{canvas_id}",
    response_model=CanvasOut,
    responses={304: {"description": "If-None-Match matched the version (ETag)"}},
)
async def get_canvas(
    canvas_id: UUID,
    user: CurrentUser,
    db: Db,
    response: Response,
    if_none_match: str | None = Header(default=None),
) -> CanvasOut | Response:
    """Metadata, body and head_rev_id. ETag is the version; If-None-Match → 304."""
    canvas = await service.get(db, user, canvas_id)
    etag = _etag(canvas.version)
    if if_none_match is not None and etag in [t.strip() for t in if_none_match.split(",")]:
        return Response(status_code=304, headers={"ETag": etag})
    response.headers["ETag"] = etag
    return canvas


@router.put(
    "/canvases/{canvas_id}/content",
    response_model=SaveOut,
    responses={409: {"model": CanvasConflictResponse}},
)
async def save_canvas_content(
    canvas_id: UUID, user: CurrentUser, body: ContentSave, db: Db, request: Request
) -> SaveOut:
    """Save the whole body written on `base_rev_id`; merged with saves made since (CANVAS.md
    §4.4). 409 canvas_conflict when the same words changed on both sides (on_conflict=fail),
    409 canvas_base_expired when the base version is gone."""
    _limit_saves(request, user)
    return await service.save_content(db, user, canvas_id, body)


@router.patch("/canvases/{canvas_id}", response_model=CanvasOut)
async def update_canvas(
    canvas_id: UUID, user: CurrentUser, body: CanvasUpdate, db: Db
) -> CanvasOut:
    """Title, edit_policy, the conversation's tab."""
    return await service.update(db, user, canvas_id, body)


@router.delete("/canvases/{canvas_id}", status_code=204)
async def delete_canvas(canvas_id: UUID, user: CurrentUser, db: Db) -> Response:
    """To the trash."""
    await service.delete(db, user, canvas_id)
    return Response(status_code=204)


@router.post("/canvases/{canvas_id}/restore", response_model=CanvasOut)
async def restore_canvas(canvas_id: UUID, user: CurrentUser, db: Db) -> CanvasOut:
    """Back from the trash."""
    return await service.restore(db, user, canvas_id)


@router.post("/canvases/{canvas_id}/share", response_model=CanvasOut)
async def share_canvas(canvas_id: UUID, user: CurrentUser, db: Db, request: Request) -> CanvasOut:
    """Post the permalink `<server>/c/<id>` to the conversation as an ordinary message, whose
    thread holds the comments (share_message_id). Nothing new if that message still exists."""
    _limit_saves(request, user)
    return await service.share(db, user, canvas_id, base_url=_base_url(request))


@router.get("/canvases/{canvas_id}/revisions", response_model=RevisionPage)
async def list_canvas_revisions(
    canvas_id: UUID,
    user: CurrentUser,
    db: Db,
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
) -> RevisionPage:
    """The history without bodies, newest first."""
    return await service.list_revisions(db, user, canvas_id, cursor=cursor, limit=limit)


@router.get("/canvases/{canvas_id}/revisions/{revision_id}", response_model=RevisionOut)
async def get_canvas_revision(
    canvas_id: UUID, revision_id: UUID, user: CurrentUser, db: Db
) -> RevisionOut:
    return await service.get_revision(db, user, canvas_id, revision_id)


@router.post("/canvases/{canvas_id}/revisions/{revision_id}/restore", response_model=CanvasOut)
async def restore_canvas_revision(
    canvas_id: UUID,
    revision_id: UUID,
    user: CurrentUser,
    body: RevisionRestore,
    db: Db,
    request: Request,
) -> CanvasOut:
    """That version's body as a new version."""
    _limit_saves(request, user)
    return await service.restore_revision(db, user, canvas_id, revision_id, body)


@router.patch("/canvases/{canvas_id}/revisions/{revision_id}", response_model=RevisionMeta)
async def label_canvas_revision(
    canvas_id: UUID, revision_id: UUID, user: CurrentUser, body: RevisionUpdate, db: Db
) -> RevisionMeta:
    """Name a version (「提出版」); null removes the name."""
    return await service.label_revision(db, user, canvas_id, revision_id, body)


@router.delete("/canvases/{canvas_id}/revisions/{revision_id}", response_model=RevisionMeta)
async def erase_canvas_revision(
    canvas_id: UUID, revision_id: UUID, user: CurrentUser, db: Db
) -> RevisionMeta:
    """Erase a version's body (owners and administrators; in a DM its creator). Audited."""
    return await service.erase_revision(db, user, canvas_id, revision_id)


@router.get("/canvas-templates", response_model=list[CanvasTemplateOut])
async def list_canvas_templates(user: CurrentUser, db: Db) -> list[CanvasTemplateOut]:
    """Templates to start a canvas from (hidden ones left out)."""
    return await service.list_templates(db, user)


@router.get("/admin/canvas-templates", response_model=list[CanvasTemplateOut])
async def admin_list_canvas_templates(user: CurrentUser, db: Db) -> list[CanvasTemplateOut]:
    """All templates, hidden ones too (administrators)."""
    return await service.list_templates(db, user, include_hidden=True)


@router.post("/admin/canvas-templates", response_model=CanvasTemplateOut, status_code=201)
async def admin_create_canvas_template(
    body: CanvasTemplateCreate, user: CurrentUser, db: Db
) -> CanvasTemplateOut:
    return await service.create_template(db, user, body)


@router.patch("/admin/canvas-templates/{template_id}", response_model=CanvasTemplateOut)
async def admin_update_canvas_template(
    template_id: UUID, body: CanvasTemplateUpdate, user: CurrentUser, db: Db
) -> CanvasTemplateOut:
    """Edit, reorder or hide (`hidden`) a template, built-in ones too."""
    return await service.update_template(db, user, template_id, body)


@router.delete("/admin/canvas-templates/{template_id}", status_code=204)
async def admin_delete_canvas_template(template_id: UUID, user: CurrentUser, db: Db) -> Response:
    """Only templates added by an administrator; built-in ones are hidden instead."""
    await service.delete_template(db, user, template_id)
    return Response(status_code=204)
