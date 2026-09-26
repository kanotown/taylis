"""scheduled messages (M12d)

Revision ID: 0016
Revises: 0015
Create Date: 2026-09-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "scheduled_messages",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("channel_id", sa.Uuid(), sa.ForeignKey("channels.id"), nullable=False),
        sa.Column("parent_id", sa.Uuid(), sa.ForeignKey("messages.id"), nullable=True),
        sa.Column("client_msg_id", sa.Uuid(), nullable=False, unique=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("attachment_ids", postgresql.ARRAY(sa.Uuid()), nullable=True),
        sa.Column("send_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("sent_message_id", sa.Uuid(), sa.ForeignKey("messages.id"), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("scheduled_messages_due_idx", "scheduled_messages", ["status", "send_at"])
    op.create_index("scheduled_messages_user_idx", "scheduled_messages", ["user_id", "send_at"])


def downgrade() -> None:
    op.drop_index("scheduled_messages_user_idx", table_name="scheduled_messages")
    op.drop_index("scheduled_messages_due_idx", table_name="scheduled_messages")
    op.drop_table("scheduled_messages")
