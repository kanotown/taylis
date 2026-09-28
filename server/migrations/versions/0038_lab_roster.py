"""lab roster (M23): profiles and groups kept from it

Revision ID: 0038
Revises: 0037
Create Date: 2026-09-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0038"
down_revision: str | None = "0037"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "lab_profiles",
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("affiliation", sa.Text(), nullable=False),
        sa.Column("rank", sa.Text()),
        sa.Column("grade", sa.Text()),
        sa.Column("supervisor_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("research_topic", sa.String(200)),
        sa.Column("reading", sa.String(80)),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "affiliation IN ('faculty', 'student', 'alumni', 'other')",
            name="lab_profiles_affiliation_check",
        ),
        sa.CheckConstraint(
            "rank IS NULL OR affiliation = 'faculty'", name="lab_profiles_rank_check"
        ),
        sa.CheckConstraint(
            "grade IS NULL OR affiliation = 'student'", name="lab_profiles_grade_check"
        ),
    )
    # Groups whose members follow the roster (b4, m1, …): null for groups made by hand.
    op.add_column("user_groups", sa.Column("managed_key", sa.Text()))
    op.create_unique_constraint("user_groups_managed_key_key", "user_groups", ["managed_key"])


def downgrade() -> None:
    op.drop_constraint("user_groups_managed_key_key", "user_groups", type_="unique")
    op.drop_column("user_groups", "managed_key")
    op.drop_table("lab_profiles")
