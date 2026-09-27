"""thread replies also shown in the channel (M15c)

Revision ID: 0029
Revises: 0028
Create Date: 2026-09-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0029"
down_revision: str | None = "0028"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("also_in_channel", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_check_constraint(
        "also_in_channel_needs_parent", "messages", "NOT also_in_channel OR parent_id IS NOT NULL"
    )


def downgrade() -> None:
    op.drop_constraint("also_in_channel_needs_parent", "messages", type_="check")
    op.drop_column("messages", "also_in_channel")
