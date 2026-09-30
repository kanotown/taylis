"""M39: the activity read position and reaction notifications per person

Revision ID: 0045
Revises: 0044
Create Date: 2026-09-30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0045"
down_revision: str | None = "0044"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Everything before the migration counts as read (the feed is new; its history is not news).
    op.add_column(
        "users",
        sa.Column(
            "activity_read_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    # A push when someone reacts to my message (the activity shows it either way); off unless
    # chosen.
    op.add_column(
        "users", sa.Column("notify_reactions", sa.Boolean(), nullable=False, server_default="false")
    )


def downgrade() -> None:
    op.drop_column("users", "notify_reactions")
    op.drop_column("users", "activity_read_at")
