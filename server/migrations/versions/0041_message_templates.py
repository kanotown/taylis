"""post templates (M30): the workspace's and each person's, with 日報 and 週報 to start with

Revision ID: 0041
Revises: 0040
Create Date: 2026-09-29
"""

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0041"
down_revision: str | None = "0040"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# LAB.md C: the examples, for the workspace (admins may change or delete them).
# {date} / {week} are put in by the client when a template is inserted
# (DATA_MODEL.md message_templates).
DEFAULTS = [
    (
        "日報",
        "times",
        "**日報 {date}**\n\n今日やったこと\n- \n\n明日やること\n- \n\n困っていること\n- ",
    ),
    (
        "週報",
        "any",
        "**週報 {week}**\n\n今週の進捗\n- \n\n来週の予定\n- \n\n"
        "相談したいこと\n- \n\n論文・学会の状況\n- ",
    ),
]


def upgrade() -> None:
    op.create_table(
        "message_templates",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("scope", sa.String(16), nullable=False),
        sa.Column(
            "owner_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("name", sa.String(20), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("suggest_in", sa.String(8), nullable=False, server_default="any"),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "(scope = 'workspace' AND owner_id IS NULL)"
            " OR (scope = 'user' AND owner_id IS NOT NULL)",
            name="message_templates_scope_owner",
        ),
        sa.CheckConstraint("suggest_in IN ('any', 'times')", name="message_templates_suggest_in"),
    )
    op.execute(
        "CREATE UNIQUE INDEX message_templates_workspace_name ON message_templates (lower(name)) "
        "WHERE scope = 'workspace'"
    )
    op.execute(
        "CREATE UNIQUE INDEX message_templates_user_name"
        " ON message_templates (owner_id, lower(name)) "
        "WHERE scope = 'user'"
    )
    table = sa.table(
        "message_templates",
        sa.column("id", postgresql.UUID(as_uuid=True)),
        sa.column("scope", sa.String),
        sa.column("name", sa.String),
        sa.column("body", sa.Text),
        sa.column("suggest_in", sa.String),
        sa.column("position", sa.Integer),
    )
    op.bulk_insert(
        table,
        [
            {
                "id": uuid.uuid4(),
                "scope": "workspace",
                "name": name,
                "body": body,
                "suggest_in": suggest,
                "position": i,
            }
            for i, (name, suggest, body) in enumerate(DEFAULTS)
        ],
    )


def downgrade() -> None:
    op.drop_table("message_templates")
