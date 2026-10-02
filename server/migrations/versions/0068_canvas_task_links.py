"""Checklist items and their tasks, both ways (M80)

Revision ID: 0068
Revises: 0067
Create Date: 2026-10-02

docs/CANVAS.md §22: a task made from a checklist item puts a hidden marker
(` <!--task:<id>-->`) at the end of that line, and the server keeps the box and the task's
completion the same. Two schema changes:

- canvas_revisions.kind takes 'task': the version the server makes for a task (the marker
  written in, a box ticked because the task was completed or reopened).
- canvases_search_idx is built on the body without the markers (regexp_replace), so a search
  for 「task」 or a piece of an id finds no linked item. The search builds the same expression
  (search/repository.py canvas_document).
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0068"
down_revision: str | None = "0067"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# app/modules/canvases/markers.py MARKER_SQL (copied: a migration does not import the app).
MARKER_SQL = " ?<!--task:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-->"


def upgrade() -> None:
    op.execute("ALTER TABLE canvas_revisions DROP CONSTRAINT ck_canvas_revisions_kind_values")
    op.execute(
        "ALTER TABLE canvas_revisions ADD CONSTRAINT ck_canvas_revisions_kind_values CHECK "
        "(kind IN ('create', 'save', 'merge', 'side', 'restore', 'erased', 'task'))"
    )
    op.execute("DROP INDEX IF EXISTS canvases_search_idx")
    op.execute(
        "CREATE INDEX canvases_search_idx ON canvases USING pgroonga "
        f"((ARRAY[title::text, regexp_replace(body, '{MARKER_SQL}', '', 'g')]))"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS canvases_search_idx")
    op.execute(
        "CREATE INDEX canvases_search_idx ON canvases USING pgroonga ((ARRAY[title::text, body]))"
    )
    op.execute("UPDATE canvas_revisions SET kind = 'save' WHERE kind = 'task'")
    op.execute("ALTER TABLE canvas_revisions DROP CONSTRAINT ck_canvas_revisions_kind_values")
    op.execute(
        "ALTER TABLE canvas_revisions ADD CONSTRAINT ck_canvas_revisions_kind_values CHECK "
        "(kind IN ('create', 'save', 'merge', 'side', 'restore', 'erased'))"
    )
