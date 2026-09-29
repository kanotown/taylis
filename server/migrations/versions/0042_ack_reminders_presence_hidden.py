"""L4 (M31): reminders sent for an acknowledgement, and hiding one's presence

Revision ID: 0042
Revises: 0041
Create Date: 2026-09-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0042"
down_revision: str | None = "0041"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # "personal" (set by the owner, M12e) or "ack" (the author asked the members who have
    # not acknowledged).
    op.add_column(
        "reminders", sa.Column("kind", sa.String(16), nullable=False, server_default="personal")
    )
    op.create_index("reminders_message_kind_idx", "reminders", ["message_id", "kind", "created_at"])
    op.add_column(
        "users",
        sa.Column("presence_hidden", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("users", "presence_hidden")
    op.drop_index("reminders_message_kind_idx", table_name="reminders")
    op.drop_column("reminders", "kind")
