"""操作ボタンの状態 (action status, M143, docs/ACTIONS.md §12)

Revision ID: 0107
Revises: 0106
Create Date: 2026-10-08

- actions.provides_status: the button whose relay is asked for the state of its group (at most one
  per group label, checked by the server).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0107"
down_revision: str | None = "0106"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "actions",
        sa.Column("provides_status", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    op.drop_column("actions", "provides_status")
