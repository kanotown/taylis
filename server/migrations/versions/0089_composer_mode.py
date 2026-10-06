"""users.composer_mode, the desktop / Web composer's mode (rich text or Markdown)

Revision ID: 0089
Revises: 0088
Create Date: 2026-10-06

- users.composer_mode: "rich" (a WYSIWYG editor that writes the same Markdown) or "markdown"
  (the plain text area); NULL (every existing row) = never chosen, the clients' default ("rich").
  Set through PATCH /users/me {composer_mode}. The phones ignore it for now.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0089"
down_revision: str | None = "0088"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("composer_mode", sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "composer_mode")
