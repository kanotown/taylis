"""備品 (equipment lending) L1: the ledger (M167, docs/LENDING.md §4.1)

Revision ID: 0123
Revises: 0122
Create Date: 2026-10-26

lending_settings (one row; none = off and the defaults), lending_categories, lending_items,
lending_item_events (each item's history) and attachments.lending_item_id (an item's photo). The
loans come in 0124 (current_loan_id and lending_item_events.loan_id get their foreign keys then).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0123"
down_revision: str | None = "0122"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _now() -> sa.TextClause:
    return sa.text("now()")


def upgrade() -> None:
    op.create_table(
        "lending_settings",
        sa.Column("singleton", sa.Boolean(), primary_key=True, server_default=sa.true()),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "keeper_ids",
            postgresql.ARRAY(sa.Uuid()),
            nullable=False,
            server_default=sa.text("'{}'::uuid[]"),
        ),
        sa.Column("default_max_days", sa.Integer(), nullable=False, server_default="14"),
        sa.Column("max_extensions", sa.Integer(), nullable=False, server_default="2"),
        sa.Column("keeper_overdue_days", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("notice_minute", sa.Integer(), nullable=False, server_default="540"),
        sa.Column("tz", sa.String(64), nullable=False, server_default="Asia/Tokyo"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        sa.Column(
            "updated_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.CheckConstraint("singleton", name="lending_settings_singleton"),
    )
    op.create_table(
        "lending_categories",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(40), nullable=False),
        sa.Column("name_key", sa.Text(), nullable=False, unique=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("requires_permission", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("max_days", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
    )
    op.create_table(
        "lending_items",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column(
            "category_id",
            sa.Uuid(),
            sa.ForeignKey("lending_categories.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("code", sa.String(40), nullable=True),
        sa.Column("code_key", sa.Text(), nullable=True),
        sa.Column("location", sa.String(80), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "photo_attachment_id",
            sa.Uuid(),
            sa.ForeignKey("attachments.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("status", sa.String(16), nullable=False, server_default="available"),
        sa.Column("status_note", sa.String(200), nullable=True),
        sa.Column("requires_permission", sa.Boolean(), nullable=True),
        sa.Column("max_days", sa.Integer(), nullable=True),
        sa.Column("current_loan_id", sa.Uuid(), nullable=True),
        sa.Column(
            "created_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        sa.Column(
            "updated_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        sa.CheckConstraint(
            "status IN ('available', 'on_loan', 'in_repair', 'retired')",
            name="lending_items_status",
        ),
        sa.CheckConstraint(
            "(status = 'on_loan') = (current_loan_id IS NOT NULL)", name="lending_items_loan"
        ),
    )
    # The control number is unique among the items that are not retired.
    op.create_index(
        "lending_items_code_uniq",
        "lending_items",
        ["code_key"],
        unique=True,
        postgresql_where=sa.text("code_key IS NOT NULL AND status <> 'retired'"),
    )
    op.create_index("lending_items_category_idx", "lending_items", ["category_id", "name"])
    op.create_table(
        "lending_item_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "item_id",
            sa.Uuid(),
            sa.ForeignKey("lending_items.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("loan_id", sa.Uuid(), nullable=True),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column(
            "actor_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "details",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.create_index(
        "lending_item_events_item_idx", "lending_item_events", ["item_id", sa.text("id DESC")]
    )
    op.add_column("attachments", sa.Column("lending_item_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "attachments_lending_item_id_fkey",
        "attachments",
        "lending_items",
        ["lending_item_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "attachments_lending_item_idx",
        "attachments",
        ["lending_item_id"],
        postgresql_where=sa.text("lending_item_id IS NOT NULL"),
    )


def downgrade() -> None:
    # The photos go with the items: marked deleted, so the attachments' GC removes their bytes and
    # rows as it does for any deleted attachment.
    op.execute(
        "UPDATE attachments SET status = 'deleted', deleted_at = now() "
        "WHERE lending_item_id IS NOT NULL AND status <> 'deleted'"
    )
    op.drop_index("attachments_lending_item_idx", table_name="attachments")
    op.drop_constraint("attachments_lending_item_id_fkey", "attachments", type_="foreignkey")
    op.drop_column("attachments", "lending_item_id")
    op.drop_index("lending_item_events_item_idx", table_name="lending_item_events")
    op.drop_table("lending_item_events")
    op.drop_index("lending_items_category_idx", table_name="lending_items")
    op.drop_index("lending_items_code_uniq", table_name="lending_items")
    op.drop_table("lending_items")
    op.drop_table("lending_categories")
    op.drop_table("lending_settings")
