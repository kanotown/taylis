"""Workflows: forms that post a message (M94)

Revision ID: 0075
Revises: 0074
Create Date: 2026-10-04

docs/WORKFLOWS.md §3: `workflows` (name, emoji, description, target channel, the channels whose
menu offers it, the form's fields as JSON, the message template, enabled, soft delete; names are
unique among the live ones, case-insensitively), and on `messages` the workflow that posted a
message and its name then (`workflow_id`, `workflow_name`; NULL on other posts).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0075"
down_revision: str | None = "0074"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "workflows",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(40), nullable=False),
        sa.Column("emoji", sa.String(32), nullable=True),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("channel_id", sa.Uuid(), sa.ForeignKey("channels.id"), nullable=False),
        sa.Column(
            "offered_channel_ids",
            postgresql.ARRAY(sa.Uuid()),
            nullable=False,
            server_default=sa.text("'{}'::uuid[]"),
        ),
        sa.Column(
            "fields",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("template", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("char_length(name) BETWEEN 1 AND 40", name="name_length"),
        sa.CheckConstraint("char_length(template) BETWEEN 1 AND 4000", name="template_length"),
        sa.CheckConstraint("char_length(description) <= 200", name="description_length"),
    )
    op.create_index(
        "workflows_name_uniq",
        "workflows",
        [sa.text("lower(name)")],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )
    op.create_index(
        "workflows_offered_idx",
        "workflows",
        ["offered_channel_ids"],
        postgresql_using="gin",
        postgresql_where=sa.text("deleted_at IS NULL"),
    )
    op.add_column(
        "messages",
        sa.Column("workflow_id", sa.Uuid(), sa.ForeignKey("workflows.id"), nullable=True),
    )
    op.add_column("messages", sa.Column("workflow_name", sa.String(40), nullable=True))


def downgrade() -> None:
    op.drop_column("messages", "workflow_name")
    op.drop_column("messages", "workflow_id")
    op.drop_index("workflows_offered_idx", table_name="workflows")
    op.drop_index("workflows_name_uniq", table_name="workflows")
    op.drop_table("workflows")
