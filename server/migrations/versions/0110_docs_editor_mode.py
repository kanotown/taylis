"""users.docs_editor_mode, how Desktop / Web edits Docs pages (WYSIWYG or Markdown, M150)

Revision ID: 0110
Revises: 0109
Create Date: 2026-10-08

- users.docs_editor_mode: "wysiwyg" (見たまま: the page editor that writes the same Markdown,
  docs/WIKI.md §22.6) or "markdown" (the text area with the preview beside it); NULL (every
  existing row) = never chosen, the clients' default ("wysiwyg"). Set through PATCH /users/me
  {docs_editor_mode}. The phones ignore it (M153 later).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0110"
down_revision: str | None = "0109"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("docs_editor_mode", sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "docs_editor_mode")
