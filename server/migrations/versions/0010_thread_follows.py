"""thread follows (THREADS.md)

Revision ID: 0010
Revises: 0009
Create Date: 2026-09-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "thread_follows",
        sa.Column("parent_id", sa.Uuid(), sa.ForeignKey("messages.id"), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("following", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("last_read_seq", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("thread_follows_user_idx", "thread_follows", ["user_id", "following"])


def downgrade() -> None:
    op.drop_index("thread_follows_user_idx", table_name="thread_follows")
    op.drop_table("thread_follows")
