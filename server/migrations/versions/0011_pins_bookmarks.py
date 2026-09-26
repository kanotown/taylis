"""pins and bookmarks (M11c)

Revision ID: 0011
Revises: 0010
Create Date: 2026-09-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "messages", sa.Column("pinned_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=True)
    )
    op.create_index(
        "messages_pinned_idx",
        "messages",
        ["channel_id", "pinned_at"],
        postgresql_where=sa.text("pinned_at IS NOT NULL"),
    )
    op.create_table(
        "bookmarks",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("message_id", sa.Uuid(), sa.ForeignKey("messages.id"), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("bookmarks_user_idx", "bookmarks", ["user_id", "created_at"])


def downgrade() -> None:
    op.drop_index("bookmarks_user_idx", table_name="bookmarks")
    op.drop_table("bookmarks")
    op.drop_index("messages_pinned_idx", table_name="messages")
    op.drop_column("messages", "pinned_by")
    op.drop_column("messages", "pinned_at")
