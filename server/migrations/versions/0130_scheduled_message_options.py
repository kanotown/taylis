"""Scheduled messages keep the composer's options (also_in_channel, priority, ack_requested)

Revision ID: 0130
Revises: 0129
Create Date: 2026-10-31

Functional review v0.1.84 #1: a scheduled post lost 「重要 / 緊急」, 「確認を求める」 and a reply's
「チャンネルにも送信」. The row now keeps them and the send applies them (DATA_MODEL.md).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0130"
down_revision: str | None = "0129"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "scheduled_messages",
        sa.Column("also_in_channel", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column("scheduled_messages", sa.Column("priority", sa.String(16), nullable=True))
    op.add_column(
        "scheduled_messages",
        sa.Column("ack_requested", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    # An older server posts pending rows without the options (the behaviour before this).
    op.drop_column("scheduled_messages", "ack_requested")
    op.drop_column("scheduled_messages", "priority")
    op.drop_column("scheduled_messages", "also_in_channel")
