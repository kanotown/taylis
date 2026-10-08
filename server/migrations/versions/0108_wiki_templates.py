"""ドキュメントのテンプレート (wiki templates, M145, docs/WIKI.md §22.3)

Revision ID: 0108
Revises: 0107
Create Date: 2026-10-08

- wiki_pages.is_template: a page template (a top-level page, kept out of the tree, search and
  backlinks; listed by GET /wiki/templates) or a database's row template (kept out of its query,
  count, CSV and relation candidates). Only pages and rows can be templates.
- wiki_databases.default_template_id: the row template 「新規」 starts from (NULL: none; a
  purged template clears it).
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0108"
down_revision: str | None = "0107"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE wiki_pages ADD COLUMN is_template boolean NOT NULL DEFAULT false")
    op.execute(
        "ALTER TABLE wiki_pages ADD CONSTRAINT ck_wiki_pages_template_kind "
        "CHECK (NOT is_template OR kind IN ('page', 'row'))"
    )
    op.execute(
        "CREATE INDEX wiki_pages_templates_idx ON wiki_pages (parent_id, created_at) "
        "WHERE is_template AND deleted_at IS NULL"
    )
    op.execute(
        "ALTER TABLE wiki_databases ADD COLUMN default_template_id uuid "
        "REFERENCES wiki_pages(id) ON DELETE SET NULL"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE wiki_databases DROP COLUMN IF EXISTS default_template_id")
    op.execute("DROP INDEX IF EXISTS wiki_pages_templates_idx")
    op.execute("ALTER TABLE wiki_pages DROP CONSTRAINT IF EXISTS ck_wiki_pages_template_kind")
    op.execute("ALTER TABLE wiki_pages DROP COLUMN IF EXISTS is_template")
