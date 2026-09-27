"""custom sidebar sections (M14f)

Revision ID: 0027
Revises: 0026
Create Date: 2026-09-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0027"
down_revision: str | None = "0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sidebar_sections",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(40), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("sidebar_sections_user_idx", "sidebar_sections", ["user_id", "position"])
    op.create_table(
        "sidebar_section_channels",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("channel_id", sa.Uuid(), sa.ForeignKey("channels.id"), primary_key=True),
        sa.Column(
            "section_id",
            sa.Uuid(),
            sa.ForeignKey("sidebar_sections.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "added_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index(
        "sidebar_section_channels_section_idx", "sidebar_section_channels", ["section_id"]
    )


def downgrade() -> None:
    op.drop_index("sidebar_section_channels_section_idx", table_name="sidebar_section_channels")
    op.drop_table("sidebar_section_channels")
    op.drop_index("sidebar_sections_user_idx", table_name="sidebar_sections")
    op.drop_table("sidebar_sections")
