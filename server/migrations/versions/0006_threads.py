"""threads (M8c): parent_id, reply_count, last_reply_at

Revision ID: 0006
Revises: 0005
Create Date: 2026-09-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column(
            "parent_id",
            sa.Uuid(),
            sa.ForeignKey("messages.id", name="fk_messages_parent_id_messages"),
            nullable=True,
        ),
    )
    op.add_column(
        "messages", sa.Column("reply_count", sa.Integer(), nullable=False, server_default="0")
    )
    op.add_column("messages", sa.Column("last_reply_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index(
        "messages_parent_idx",
        "messages",
        ["parent_id", "seq"],
        postgresql_where=sa.text("parent_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("messages_parent_idx", table_name="messages")
    op.drop_column("messages", "last_reply_at")
    op.drop_column("messages", "reply_count")
    op.drop_column("messages", "parent_id")
