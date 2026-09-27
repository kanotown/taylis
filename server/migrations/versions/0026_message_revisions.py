"""message edit history (M14c)

Revision ID: 0026
Revises: 0025
Create Date: 2026-09-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0026"
down_revision: str | None = "0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "message_revisions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("message_id", sa.Uuid(), sa.ForeignKey("messages.id"), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("written_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("replaced_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "message_revisions_message_idx", "message_revisions", ["message_id", "replaced_at"]
    )


def downgrade() -> None:
    op.drop_index("message_revisions_message_idx", table_name="message_revisions")
    op.drop_table("message_revisions")
