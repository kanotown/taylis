import hashlib
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Header, Query, Request, Response

from app.core.db import Db
from app.core.errors import rate_limited
from app.modules.auth.deps import CurrentUser
from app.modules.users.models import User
from app.modules.wiki import service
from app.modules.wiki.schemas import (
    AccessOut,
    AccessUpdate,
    AdminPageOut,
    ChangesOut,
    ContentSave,
    MoveOut,
    PageConflictResponse,
    PageCreate,
    PageItem,
    PageMeta,
    PageMove,
    PageOut,
    PageRef,
    PageUpdate,
    ResolveIn,
    RevisionMeta,
    RevisionOut,
    RevisionPage,
    RevisionRestore,
    RevisionUpdate,
    SaveOut,
    TreeOut,
)

router = APIRouter(tags=["wiki"])

# docs/WIKI.md §11.2. Every page path answers 404 page_not_found for a page the caller cannot
# read (access.require_level), whether or not it exists.


def _limit_saves(request: Request, user: User) -> None:
    """The same budget as canvases: 120 saves per user per minute (CANVAS.md §4.3)."""
    limiter = request.app.state.limiters["canvas_save"]
    key = str(user.id)
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))


def _matches(if_none_match: str | None, etag: str) -> bool:
    return if_none_match is not None and etag in [t.strip() for t in if_none_match.split(",")]


@router.get(
    "/wiki/tree",
    response_model=TreeOut,
    responses={304: {"description": "If-None-Match matched (ETag)"}},
)
async def wiki_tree(
    user: CurrentUser,
    db: Db,
    response: Response,
    if_none_match: str | None = Header(default=None),
) -> TreeOut | Response:
    """Every page I can read (not database rows) with my level, and the change feed's cursor.
    The ETag is a hash of the answer."""
    out = await service.tree(db, user)
    etag = '"' + hashlib.sha256(out.model_dump_json().encode()).hexdigest()[:32] + '"'
    if _matches(if_none_match, etag):
        return Response(status_code=304, headers={"ETag": etag})
    response.headers["ETag"] = etag
    return out


@router.get("/wiki/changes", response_model=ChangesOut)
async def wiki_changes(
    user: CurrentUser, db: Db, since: int = Query(ge=0, description="The last cursor")
) -> ChangesOut:
    """The tree's changes after `since` (SYNC_PROTOCOL.md §17): pages I can read that changed,
    and ids to drop. `reset`: read GET /wiki/tree again."""
    return await service.changes(db, user, since)


@router.get("/wiki/trash", response_model=list[PageMeta])
async def wiki_trash(user: CurrentUser, db: Db) -> list[PageMeta]:
    """Pages in the trash (as the root of what went together) that I have full access to."""
    return await service.list_trash(db, user)


@router.post(
    "/wiki/pages",
    response_model=PageOut,
    status_code=201,
    responses={200: {"model": PageOut, "description": "A retry: the page made before"}},
)
async def create_page(
    user: CurrentUser, body: PageCreate, db: Db, request: Request, response: Response
) -> PageOut:
    """A new page: under a page I can edit, or (not guests) at the top level with `access`."""
    _limit_saves(request, user)
    page, created = await service.create(db, user, body)
    response.status_code = 201 if created else 200
    return page


@router.post("/wiki/pages/resolve", response_model=list[PageRef])
async def resolve_pages(user: CurrentUser, body: ResolveIn, db: Db) -> list[PageRef]:
    """Titles for `page:` links: only the pages I can read (the others: 「表示できないページ」)."""
    return await service.resolve_refs(db, user, body.ids)


@router.get("/wiki/pages/lookup", response_model=list[PageRef])
async def lookup_pages(
    user: CurrentUser,
    db: Db,
    q: str = Query(default="", max_length=200),
    limit: int = Query(default=20, ge=1, le=50),
) -> list[PageRef]:
    """The `[[` suggestions: pages I can read whose title contains `q`."""
    return await service.lookup(db, user, q, limit)


@router.get(
    "/wiki/pages/{page_id}",
    response_model=PageOut,
    responses={304: {"description": "If-None-Match matched the version (ETag)"}},
)
async def get_page(
    page_id: UUID,
    user: CurrentUser,
    db: Db,
    response: Response,
    if_none_match: str | None = Header(default=None),
) -> PageOut | Response:
    """The page with its body, head_rev_id, my level, breadcrumbs and child pages. ETag is the
    version and my level."""
    page = await service.get_page(db, user, page_id)
    etag = f'"v{page.version}-{page.my_level}"'
    if _matches(if_none_match, etag):
        return Response(status_code=304, headers={"ETag": etag})
    response.headers["ETag"] = etag
    return page


@router.put(
    "/wiki/pages/{page_id}/content",
    response_model=SaveOut,
    responses={409: {"model": PageConflictResponse}},
)
async def save_page_content(
    page_id: UUID, user: CurrentUser, body: ContentSave, db: Db, request: Request
) -> SaveOut:
    """Save the whole body written on `base_rev_id` (as a canvas, CANVAS.md §4.4); edit level.
    409 page_conflict / page_base_expired."""
    _limit_saves(request, user)
    return await service.save_content(db, user, page_id, body)


@router.patch("/wiki/pages/{page_id}", response_model=PageOut)
async def update_page(page_id: UUID, user: CurrentUser, body: PageUpdate, db: Db) -> PageOut:
    """Title and icon (edit level)."""
    return await service.update(db, user, page_id, body)


@router.post("/wiki/pages/{page_id}/move", response_model=MoveOut)
async def move_page(page_id: UUID, user: CurrentUser, body: PageMove, db: Db) -> MoveOut:
    """Move under another page or to the top level (full here, edit there). `dry_run` says who
    would gain or lose access; `keep_access` keeps it as it is."""
    return await service.move(db, user, page_id, body)


@router.delete("/wiki/pages/{page_id}", status_code=204)
async def trash_page(page_id: UUID, user: CurrentUser, db: Db) -> Response:
    """To the trash with everything below it (full access; 30 days)."""
    await service.trash(db, user, page_id)
    return Response(status_code=204)


@router.post("/wiki/pages/{page_id}/restore", response_model=PageOut)
async def restore_page(page_id: UUID, user: CurrentUser, db: Db) -> PageOut:
    """Back from the trash with what went with it (full access)."""
    return await service.restore(db, user, page_id)


@router.get("/wiki/pages/{page_id}/access", response_model=AccessOut)
async def get_page_access(page_id: UUID, user: CurrentUser, db: Db) -> AccessOut:
    """Who has access: the page's own entries and the effective ones with where they come from."""
    return await service.get_access(db, user, page_id)


@router.put("/wiki/pages/{page_id}/access", response_model=AccessOut)
async def set_page_access(
    page_id: UUID, user: CurrentUser, body: AccessUpdate, db: Db
) -> AccessOut:
    """Replace the page's own entries and inherit_access (full access, not guests). 409
    page_last_manager when nobody could manage it afterwards."""
    return await service.set_access(db, user, page_id, body)


@router.get("/wiki/pages/{page_id}/backlinks", response_model=list[PageItem])
async def page_backlinks(page_id: UUID, user: CurrentUser, db: Db) -> list[PageItem]:
    """Pages I can read whose body links here."""
    return await service.backlinks(db, user, page_id)


@router.get(
    "/wiki/pages/{page_id}/export",
    response_class=Response,
    responses={
        200: {
            "content": {"text/markdown": {}, "application/zip": {}},
            "description": "The page as Markdown, or with subtree=true a ZIP",
        }
    },
)
async def export_page(
    page_id: UUID,
    user: CurrentUser,
    db: Db,
    subtree: bool = Query(default=False, description="A ZIP with the pages below I can read"),
) -> Response:
    content, media_type, name = await service.export(db, user, page_id, subtree=subtree)
    return Response(
        content,
        media_type=media_type,
        headers={
            "Content-Disposition": (
                f"attachment; filename=\"export\"; filename*=UTF-8''{quote(name)}"
            ),
            "Cache-Control": "private, no-store",
        },
    )


@router.get("/wiki/pages/{page_id}/revisions", response_model=RevisionPage)
async def list_page_revisions(
    page_id: UUID,
    user: CurrentUser,
    db: Db,
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
) -> RevisionPage:
    return await service.list_revisions(db, user, page_id, cursor=cursor, limit=limit)


@router.get("/wiki/pages/{page_id}/revisions/{revision_id}", response_model=RevisionOut)
async def get_page_revision(
    page_id: UUID, revision_id: UUID, user: CurrentUser, db: Db
) -> RevisionOut:
    return await service.get_revision(db, user, page_id, revision_id)


@router.post("/wiki/pages/{page_id}/revisions/{revision_id}/restore", response_model=PageOut)
async def restore_page_revision(
    page_id: UUID,
    revision_id: UUID,
    user: CurrentUser,
    body: RevisionRestore,
    db: Db,
    request: Request,
) -> PageOut:
    """That version's body as a new version (edit level)."""
    _limit_saves(request, user)
    return await service.restore_revision(db, user, page_id, revision_id, body)


@router.patch("/wiki/pages/{page_id}/revisions/{revision_id}", response_model=RevisionMeta)
async def label_page_revision(
    page_id: UUID, revision_id: UUID, user: CurrentUser, body: RevisionUpdate, db: Db
) -> RevisionMeta:
    return await service.label_revision(db, user, page_id, revision_id, body)


@router.delete("/wiki/pages/{page_id}/revisions/{revision_id}", response_model=RevisionMeta)
async def erase_page_revision(
    page_id: UUID, revision_id: UUID, user: CurrentUser, db: Db
) -> RevisionMeta:
    """Erase a version's body (full access). Audited."""
    return await service.erase_revision(db, user, page_id, revision_id)


@router.get("/admin/wiki/pages", response_model=list[AdminPageOut])
async def admin_list_pages(user: CurrentUser, db: Db) -> list[AdminPageOut]:
    """Administrators: every page's title and who has access (no bodies), the trash too."""
    return await service.admin_list(db, user)


@router.post(
    "/admin/wiki/pages/{page_id}/takeover",
    response_model=PageOut | None,
)
async def admin_takeover_page(page_id: UUID, user: CurrentUser, db: Db) -> PageOut | None:
    """Administrators: give myself full access to the page (audited as wiki.access_takeover).
    null when the page is in the trash."""
    return await service.takeover(db, user, page_id)


@router.delete("/admin/wiki/pages/{page_id}", status_code=204)
async def admin_purge_page(page_id: UUID, user: CurrentUser, db: Db) -> Response:
    """Administrators: empty a page in the trash (with what went with it) now. Audited."""
    await service.admin_purge(db, user, page_id)
    return Response(status_code=204)
