"""L7 (M32): a lab preset on invite links, and the yearly rollovers (with what they changed)

Revision ID: 0043
Revises: 0042
Create Date: 2026-09-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0043"
down_revision: str | None = "0042"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The roster line (and whether to make a times) an invitee gets on acceptance.
    op.add_column("invites", sa.Column("lab_preset", postgresql.JSONB(), nullable=True))
    op.create_table(
        "lab_rollovers",
        sa.Column("academic_year", sa.SmallInteger(), primary_key=True),
        sa.Column(
            "applied_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column(
            "applied_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        # What each person was before (roster line, role, memberships left, times archived),
        # for undo.
        sa.Column("before", postgresql.JSONB(), nullable=False),
        sa.Column("undone_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("lab_rollovers")
    op.drop_column("invites", "lab_preset")
