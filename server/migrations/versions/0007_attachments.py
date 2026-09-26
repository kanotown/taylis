"""attachments (M9a)

Revision ID: 0007
Revises: 0006
Create Date: 2026-09-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "attachments",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "uploader_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", name="fk_attachments_uploader_id_users"),
            nullable=False,
        ),
        sa.Column(
            "message_id",
            sa.Uuid(),
            sa.ForeignKey("messages.id", name="fk_attachments_message_id_messages"),
            nullable=True,
        ),
        sa.Column(
            "channel_id",
            sa.Uuid(),
            sa.ForeignKey("channels.id", name="fk_attachments_channel_id_channels"),
            nullable=True,
        ),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("filename", sa.Text(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.LargeBinary(), nullable=True),
        sa.Column("storage_key", sa.Text(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("thumbnail_key", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("attached_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("attachments_message_idx", "attachments", ["message_id"])
    op.create_index("attachments_gc_idx", "attachments", ["status", "created_at"])


def downgrade() -> None:
    op.drop_index("attachments_gc_idx", table_name="attachments")
    op.drop_index("attachments_message_idx", table_name="attachments")
    op.drop_table("attachments")
