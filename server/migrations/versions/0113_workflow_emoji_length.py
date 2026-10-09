"""workflows.emoji takes the :name: of any custom emoji (docs/WORKFLOWS.md §11)

Revision ID: 0113
Revises: 0112
Create Date: 2026-10-09

- workflows.emoji: varchar(32) → varchar(34). A custom emoji's name is up to 32 characters
  (emoji.service.NAME), so its :name: is up to 34, and the editor's picker offers every one of them.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0113"
down_revision: str | None = "0112"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "workflows",
        "emoji",
        existing_type=sa.String(32),
        type_=sa.String(34),
        existing_nullable=True,
    )


def downgrade() -> None:
    # A 33- or 34-character :name: would not fit; those workflows go back to ⚡.
    op.execute("UPDATE workflows SET emoji = NULL WHERE length(emoji) > 32")
    op.alter_column(
        "workflows",
        "emoji",
        existing_type=sa.String(34),
        type_=sa.String(32),
        existing_nullable=True,
    )
