"""profile pictures (M14a)

Revision ID: 0024
Revises: 0023
Create Date: 2026-09-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0024"
down_revision: str | None = "0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("avatar_key", sa.Text(), nullable=True))
    op.add_column(
        "users", sa.Column("avatar_updated_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("users", "avatar_updated_at")
    op.drop_column("users", "avatar_key")
