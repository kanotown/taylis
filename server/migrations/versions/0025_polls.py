"""polls on messages (M14b)

Revision ID: 0025
Revises: 0024
Create Date: 2026-09-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0025"
down_revision: str | None = "0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("poll", postgresql.JSONB(), nullable=True))
    op.create_table(
        "poll_votes",
        sa.Column("message_id", sa.Uuid(), sa.ForeignKey("messages.id"), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("option_index", sa.SmallInteger(), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )


def downgrade() -> None:
    op.drop_table("poll_votes")
    op.drop_column("messages", "poll")
