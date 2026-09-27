"""drafts shared by my devices (M15d)

Revision ID: 0030
Revises: 0029
Create Date: 2026-09-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0030"
down_revision: str | None = "0029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "drafts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("channel_id", sa.Uuid(), sa.ForeignKey("channels.id"), nullable=False),
        sa.Column(
            "parent_id", sa.Uuid(), sa.ForeignKey("messages.id", ondelete="CASCADE"), nullable=True
        ),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index(
        "drafts_user_composer_uniq",
        "drafts",
        ["user_id", "channel_id", "parent_id"],
        unique=True,
        postgresql_nulls_not_distinct=True,
    )


def downgrade() -> None:
    op.drop_index("drafts_user_composer_uniq", table_name="drafts")
    op.drop_table("drafts")
