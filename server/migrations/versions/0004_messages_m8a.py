"""messages M8a: mentions, message type, reactions

Revision ID: 0004
Revises: 0003
Create Date: 2026-09-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "messages", sa.Column("type", sa.String(16), nullable=False, server_default="user")
    )
    op.add_column(
        "messages",
        sa.Column(
            "mentioned_user_ids",
            postgresql.ARRAY(sa.Uuid()),
            nullable=False,
            server_default=sa.text("'{}'::uuid[]"),
        ),
    )
    op.add_column(
        "messages",
        sa.Column("mention_all", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_table(
        "reactions",
        sa.Column(
            "message_id",
            sa.Uuid(),
            sa.ForeignKey("messages.id", name="fk_reactions_message_id_messages"),
            primary_key=True,
        ),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", name="fk_reactions_user_id_users"),
            primary_key=True,
        ),
        sa.Column("emoji", sa.Text(), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )


def downgrade() -> None:
    op.drop_table("reactions")
    op.drop_column("messages", "mention_all")
    op.drop_column("messages", "mentioned_user_ids")
    op.drop_column("messages", "type")
