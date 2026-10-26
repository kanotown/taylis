"""備品 (equipment lending) L3: the notices and the watches (M169, docs/LENDING.md §4.1, §8)

Revision ID: 0125
Revises: 0124
Create Date: 2026-10-26

lending_notices (activity items of kind lending, one per person and key, like
reservation_notices) and lending_watches (「返却されたら知らせる」).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0125"
down_revision: str | None = "0124"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "lending_notices",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "item_id",
            sa.Uuid(),
            sa.ForeignKey("lending_items.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "loan_id",
            sa.Uuid(),
            sa.ForeignKey("lending_loans.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("key", sa.String(200), nullable=False),
        sa.Column("role", sa.String(12), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "done_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.UniqueConstraint("user_id", "key", name="lending_notices_user_key_uniq"),
        sa.CheckConstraint(
            "role IN ('borrower', 'approver', 'keeper', 'watcher')", name="lending_notices_role"
        ),
    )
    op.create_index("lending_notices_user_idx", "lending_notices", ["user_id", sa.text("at DESC")])
    op.create_table(
        "lending_watches",
        sa.Column(
            "item_id",
            sa.Uuid(),
            sa.ForeignKey("lending_items.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )


def downgrade() -> None:
    op.drop_table("lending_watches")
    op.drop_index("lending_notices_user_idx", table_name="lending_notices")
    op.drop_table("lending_notices")
