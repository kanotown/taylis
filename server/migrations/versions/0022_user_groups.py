"""user groups for @group mentions (M12k)

Revision ID: 0022
Revises: 0021
Create Date: 2026-09-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_groups",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", postgresql.CITEXT(), nullable=False, unique=True),
        sa.Column("description", sa.String(200), nullable=True),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_table(
        "user_group_members",
        sa.Column(
            "group_id",
            sa.Uuid(),
            sa.ForeignKey("user_groups.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column(
            "added_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("user_group_members_user_idx", "user_group_members", ["user_id"])


def downgrade() -> None:
    op.drop_index("user_group_members_user_idx", table_name="user_group_members")
    op.drop_table("user_group_members")
    op.drop_table("user_groups")
