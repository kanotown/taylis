"""channel favorites (M12a)

Revision ID: 0014
Revises: 0013
Create Date: 2026-09-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "channel_favorites",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("channel_id", sa.Uuid(), sa.ForeignKey("channels.id"), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("channel_favorites_user_idx", "channel_favorites", ["user_id", "created_at"])


def downgrade() -> None:
    op.drop_index("channel_favorites_user_idx", table_name="channel_favorites")
    op.drop_table("channel_favorites")
