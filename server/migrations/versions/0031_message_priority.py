"""message priority and acknowledgements (M15e)

Revision ID: 0031
Revises: 0030
Create Date: 2026-09-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0031"
down_revision: str | None = "0030"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("priority", sa.String(16), nullable=True))
    op.add_column(
        "messages",
        sa.Column("ack_requested", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_check_constraint(
        "priority_values", "messages", "priority IS NULL OR priority IN ('important', 'urgent')"
    )
    op.create_check_constraint(
        "priority_top_level",
        "messages",
        "parent_id IS NULL OR (priority IS NULL AND NOT ack_requested)",
    )
    op.create_table(
        "message_acks",
        sa.Column(
            "message_id",
            sa.Uuid(),
            sa.ForeignKey("messages.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column(
            "acked_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )


def downgrade() -> None:
    op.drop_table("message_acks")
    op.drop_constraint("priority_top_level", "messages", type_="check")
    op.drop_constraint("priority_values", "messages", type_="check")
    op.drop_column("messages", "ack_requested")
    op.drop_column("messages", "priority")
