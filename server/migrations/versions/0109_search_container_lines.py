"""検索の索引からコールアウト・トグルの囲みの行を外す (M149, docs/WIKI.md §22.5)

Revision ID: 0109
Revises: 0108
Create Date: 2026-10-08

- canvases_search_idx and wiki_pages_search_idx are built on the body without the task markers
  (0068, 0095) and now also without the container lines of the dialect: the `::: callout` /
  `::: toggle` keyword of an opener (its icon or title stays: it is content) and a bare `:::`
  close. So 「callout」 or 「toggle」 finds no page, and the content still does. One
  regexp_replace with the flags 'gn' (newline-sensitive: ^ and $ match at each line).
- The expressions must stay equal to app/modules/search/repository.py canvas_document() and
  page_document() (else the queries do not use the indexes; tests EXPLAIN them).
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0109"
down_revision: str | None = "0108"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# app/core/doctext/markers.py MARKER_SQL and blocks.py BODY_SQL (written out: a migration does
# not import the app).
MARKER_SQL = " ?<!--task:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-->"
BODY_SQL = MARKER_SQL + r"|^:::[ \t]*(callout|toggle)(?=[ \t]|$)|^:::[ \t]*$"


def _create(body_sql: str, flags: str) -> None:
    op.execute(
        "CREATE INDEX canvases_search_idx ON canvases USING pgroonga "
        f"((ARRAY[title::text, regexp_replace(body, '{body_sql}', '', '{flags}')]))"
    )
    op.execute(
        "CREATE INDEX wiki_pages_search_idx ON wiki_pages USING pgroonga "
        f"((ARRAY[title::text, regexp_replace(body, '{body_sql}', '', '{flags}'), "
        "coalesce(props_text, '')]))"
    )


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS canvases_search_idx")
    op.execute("DROP INDEX IF EXISTS wiki_pages_search_idx")
    _create(BODY_SQL, "gn")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS canvases_search_idx")
    op.execute("DROP INDEX IF EXISTS wiki_pages_search_idx")
    _create(MARKER_SQL, "g")
