"""read states (M8b): per user and channel read position

Revision ID: 0005
Revises: 0004
Create Date: 2026-09-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "read_states",
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", name="fk_read_states_user_id_users"),
            primary_key=True,
        ),
        sa.Column(
            "channel_id",
            sa.Uuid(),
            sa.ForeignKey("channels.id", name="fk_read_states_channel_id_channels"),
            primary_key=True,
        ),
        sa.Column("last_read_seq", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    # Existing members start fully read: nothing they already saw becomes unread at upgrade time.
    op.execute(
        """
        INSERT INTO read_states (user_id, channel_id, last_read_seq)
        SELECT cm.user_id, cm.channel_id, c.last_seq
        FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
        ON CONFLICT DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_table("read_states")
