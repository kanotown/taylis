"""備品 (equipment lending) L2: the loans (M168, docs/LENDING.md §4.1)

Revision ID: 0124
Revises: 0123
Create Date: 2026-10-26

lending_loans (at most one active loan per item: lending_loans_active_uniq; a retry with the same
client_request_id is the same row: lending_loans_request_uniq), and the foreign keys 0123 left out:
lending_items.current_loan_id (DEFERRABLE INITIALLY DEFERRED) and lending_item_events.loan_id.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0124"
down_revision: str | None = "0123"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _now() -> sa.TextClause:
    return sa.text("now()")


def upgrade() -> None:
    op.create_table(
        "lending_loans",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "item_id",
            sa.Uuid(),
            sa.ForeignKey("lending_items.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("borrower_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("client_request_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("borrowed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("due_on", sa.Date(), nullable=False),
        sa.Column("original_due_on", sa.Date(), nullable=False),
        sa.Column("extension_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("purpose", sa.String(200), nullable=False),
        sa.Column("permission_required", sa.Boolean(), nullable=False),
        sa.Column("approver_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("permission_state", sa.String(16), nullable=True),
        sa.Column("permission_decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("permission_note", sa.String(200), nullable=True),
        sa.Column("returned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("returned_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("return_condition", sa.String(8), nullable=True),
        sa.Column("return_note", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        sa.CheckConstraint("status IN ('active', 'returned')", name="lending_loans_status"),
        sa.CheckConstraint(
            "(status = 'returned') = (returned_at IS NOT NULL)", name="lending_loans_returned"
        ),
        sa.CheckConstraint(
            "permission_required = (permission_state IS NOT NULL)",
            name="lending_loans_permission",
        ),
        sa.CheckConstraint(
            "(permission_state IS NULL) = (approver_id IS NULL)", name="lending_loans_approver"
        ),
        sa.CheckConstraint(
            "return_condition IS NULL OR return_condition IN ('ok', 'issue')",
            name="lending_loans_condition",
        ),
    )
    # One active loan per item (the last guard behind the item row's lock, §7.1).
    op.create_index(
        "lending_loans_active_uniq",
        "lending_loans",
        ["item_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )
    # A retry is the same row (§7.2).
    op.create_index(
        "lending_loans_request_uniq",
        "lending_loans",
        ["borrower_id", "client_request_id"],
        unique=True,
    )
    op.create_index(
        "lending_loans_borrower_idx", "lending_loans", ["borrower_id", "status", "due_on"]
    )
    op.create_index(
        "lending_loans_due_idx",
        "lending_loans",
        ["due_on"],
        postgresql_where=sa.text("status = 'active'"),
    )
    op.create_index(
        "lending_loans_item_idx", "lending_loans", ["item_id", sa.text("borrowed_at DESC")]
    )
    op.create_foreign_key(
        "lending_items_current_loan_id_fkey",
        "lending_items",
        "lending_loans",
        ["current_loan_id"],
        ["id"],
        deferrable=True,
        initially="DEFERRED",
    )
    op.create_foreign_key(
        "lending_item_events_loan_id_fkey",
        "lending_item_events",
        "lending_loans",
        ["loan_id"],
        ["id"],
    )


def downgrade() -> None:
    # Without the loans nothing is on loan any more: the items go back to available (0123's CHECK
    # holds either way). The history keeps its loan_id values, as plain ids again.
    op.drop_constraint(
        "lending_item_events_loan_id_fkey", "lending_item_events", type_="foreignkey"
    )
    op.drop_constraint("lending_items_current_loan_id_fkey", "lending_items", type_="foreignkey")
    op.execute(
        "UPDATE lending_items SET status = 'available', current_loan_id = NULL "
        "WHERE status = 'on_loan'"
    )
    op.drop_index("lending_loans_item_idx", table_name="lending_loans")
    op.drop_index("lending_loans_due_idx", table_name="lending_loans")
    op.drop_index("lending_loans_borrower_idx", table_name="lending_loans")
    op.drop_index("lending_loans_request_uniq", table_name="lending_loans")
    op.drop_index("lending_loans_active_uniq", table_name="lending_loans")
    op.drop_table("lending_loans")
