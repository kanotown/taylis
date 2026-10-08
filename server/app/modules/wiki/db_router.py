"""Wiki databases (docs/WIKI.md §5, §11.2; M123). Every path answers 404 page_not_found for a
database or row the caller cannot read (access.require_level), whether or not it exists."""

from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Query, Request, Response

from app.core.db import Db
from app.core.errors import request_locale
from app.modules.auth.deps import CurrentUser
from app.modules.wiki import databases
from app.modules.wiki.db_schemas import (
    DatabaseOut,
    DefaultTemplateIn,
    RowCreate,
    RowDetailOut,
    RowPropsUpdate,
    RowQuery,
    RowQueryOut,
    RowRef,
    RowWithRefs,
    SchemaChange,
    ViewIn,
)
from app.modules.wiki.router import _limit_saves, files

router = APIRouter(tags=["wiki"])


@router.get("/wiki/databases/{database_id}", response_model=DatabaseOut)
async def get_database(database_id: UUID, user: CurrentUser, db: Db) -> DatabaseOut:
    """The schema (properties in order) and the saved views, my level and the row count. A
    relation to a database I cannot read has no database id or title."""
    return await databases.get_database(db, user, database_id)


@router.patch("/wiki/databases/{database_id}/schema", response_model=DatabaseOut)
async def change_schema(
    database_id: UUID, user: CurrentUser, body: SchemaChange, db: Db
) -> DatabaseOut:
    """Add, rename, retype (the values are converted), reorder or delete properties. Edit access
    adds, renames and reorders properties, adds options and changes their names and colours and a
    number's format; deleting a property or an option, changing a type and a two-way relation need
    full access (403 page_manage_restricted). 409 wiki_schema_conflict when written on an older
    schema_version."""
    return await databases.change_schema(db, user, database_id, body)


@router.put("/wiki/databases/{database_id}/views/{view_id}", response_model=DatabaseOut)
async def put_view(
    database_id: UUID, view_id: str, user: CurrentUser, body: ViewIn, db: Db
) -> DatabaseOut:
    """Save a view under the client's id (create or replace; edit access)."""
    return await databases.put_view(db, user, database_id, view_id, body)


@router.delete("/wiki/databases/{database_id}/views/{view_id}", response_model=DatabaseOut)
async def delete_view(database_id: UUID, view_id: str, user: CurrentUser, db: Db) -> DatabaseOut:
    """Delete a view (edit access; the last one stays: 409 wiki_last_view)."""
    return await databases.delete_view(db, user, database_id, view_id)


@router.put("/wiki/databases/{database_id}/default-template", response_model=DatabaseOut)
async def set_default_template(
    database_id: UUID, user: CurrentUser, body: DefaultTemplateIn, db: Db
) -> DatabaseOut:
    """M145: the row template a new row starts from (edit access; null: none)."""
    return await databases.set_default_template(db, user, database_id, body)


@router.post("/wiki/databases/{database_id}/query", response_model=RowQueryOut)
async def query_rows(database_id: UUID, user: CurrentUser, body: RowQuery, db: Db) -> RowQueryOut:
    """The rows (without bodies) sorted and filtered by the server: a saved view's, or the
    given sort / filter; `range` for a calendar month. Cursor pages of `limit`."""
    return await databases.query(db, user, database_id, body)


@router.post(
    "/wiki/databases/{database_id}/rows",
    response_model=RowWithRefs,
    status_code=201,
    responses={200: {"model": RowWithRefs, "description": "A retry: the row made before"}},
)
async def create_row(
    database_id: UUID,
    user: CurrentUser,
    body: RowCreate,
    db: Db,
    request: Request,
    response: Response,
) -> RowWithRefs:
    """A new row at the end (edit access). 409 wiki_too_many_rows past 5,000. M145: from
    `template_id` (404 template_not_found), else unless `blank` from the database's default
    template; `is_template` makes a row template."""
    _limit_saves(request, user)
    row, created = await databases.create_row(db, user, database_id, body, files=files(request))
    response.status_code = 201 if created else 200
    return row


@router.get(
    "/wiki/databases/{database_id}/properties/{prop_id}/candidates",
    response_model=list[RowRef],
)
async def relation_candidates(
    database_id: UUID,
    prop_id: str,
    user: CurrentUser,
    db: Db,
    q: str = Query(default="", max_length=200),
    limit: int = Query(default=20, ge=1, le=50),
) -> list[RowRef]:
    """Rows a relation cell may link to: rows of the related database I can read."""
    return await databases.candidates(db, user, database_id, prop_id, q, limit)


@router.get(
    "/wiki/databases/{database_id}/export.csv",
    response_class=Response,
    responses={200: {"content": {"text/csv": {}}, "description": "UTF-8 with a BOM"}},
)
async def export_csv(
    database_id: UUID,
    user: CurrentUser,
    db: Db,
    request: Request,
    view_id: str | None = Query(default=None, max_length=24),
) -> Response:
    """The view's rows and columns as CSV (WIKI.md §5.6)."""
    content, name = await databases.export_csv(
        db, user, database_id, view_id, request_locale(request)
    )
    return Response(
        content,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": (
                f"attachment; filename=\"export.csv\"; filename*=UTF-8''{quote(name)}"
            ),
            "Cache-Control": "private, no-store",
        },
    )


@router.get("/wiki/rows/{row_id}", response_model=RowDetailOut)
async def get_row(row_id: UUID, user: CurrentUser, db: Db) -> RowDetailOut:
    """A row's cells with its database's schema, and the rows I can read that link here
    one-way (the body: GET /wiki/pages/{id})."""
    return await databases.get_row(db, user, row_id)


@router.patch("/wiki/rows/{row_id}/props", response_model=RowWithRefs)
async def update_row_props(
    row_id: UUID, user: CurrentUser, body: RowPropsUpdate, db: Db, request: Request
) -> RowWithRefs:
    """Set cells (edit access); the last write wins per cell. `client_op_id` makes a retry
    harmless."""
    _limit_saves(request, user)
    return await databases.update_props(db, user, row_id, body)
