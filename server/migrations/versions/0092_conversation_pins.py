"""conversation_pins: DMs kept at the top of my DM list (M118)

Revision ID: 0092
Revises: 0091
Create Date: 2026-10-06

DATA_MODEL.md conversation_pins: personal like channel_favorites (no channel seq), only for DMs
and group DMs I belong to. The pin order is the order of `created_at` (oldest pin first).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0092"
down_revision: str | None = "0091"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "conversation_pins",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("channel_id", sa.Uuid(), sa.ForeignKey("channels.id"), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("conversation_pins_user_idx", "conversation_pins", ["user_id", "created_at"])


def downgrade() -> None:
    op.drop_index("conversation_pins_user_idx", table_name="conversation_pins")
    op.drop_table("conversation_pins")
