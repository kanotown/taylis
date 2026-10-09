"""workflows.confirm, whether running a workflow asks first (docs/WORKFLOWS.md §11)

Revision ID: 0112
Revises: 0111
Create Date: 2026-10-09

- workflows.confirm: true (every existing row, and the default) = running it opens the form with
  its preview and 投稿, as before; false = a workflow without fields posts as soon as it is chosen
  (one with fields still opens its form).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0112"
down_revision: str | None = "0111"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "workflows",
        sa.Column("confirm", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )


def downgrade() -> None:
    op.drop_column("workflows", "confirm")
