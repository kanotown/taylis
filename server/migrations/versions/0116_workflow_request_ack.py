"""workflows.request_ack and workflows.priority, what a workflow's post asks for (WORKFLOWS.md §12)

Revision ID: 0116
Revises: 0115
Create Date: 2026-10-12

- workflows.request_ack: false (every existing row, and the default) = the post is an ordinary
  message, as before; true = the post asks the channel's members to acknowledge it
  (messages.ack_requested, M15e).
- workflows.priority: NULL (every existing row, and the default) or 'important' / 'urgent', the
  post's priority label (messages.priority, M15e).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0116"
down_revision: str | None = "0115"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "workflows",
        sa.Column("request_ack", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column("workflows", sa.Column("priority", sa.String(16), nullable=True))
    op.create_check_constraint(
        "priority_values",
        "workflows",
        "priority IS NULL OR priority IN ('important', 'urgent')",
    )


def downgrade() -> None:
    op.drop_constraint("priority_values", "workflows", type_="check")
    op.drop_column("workflows", "priority")
    op.drop_column("workflows", "request_ack")
