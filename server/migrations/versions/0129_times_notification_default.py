"""One setting for every other person's times (users.times_notification_default)

Revision ID: 0129
Revises: 0128
Create Date: 2026-10-30

What someone else's times without a level of its own notifies me of: 'mentions' (the rule since
M24, so nothing changes for anyone) or 'all' (every new post, and it counts as normal unread
instead of quiet unread). PUSH_NOTIFICATIONS.md §4, SYNC_PROTOCOL.md §10.5.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0129"
down_revision: str | None = "0128"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "times_notification_default",
            sa.String(16),
            nullable=False,
            server_default="mentions",
        ),
    )


def downgrade() -> None:
    # An older server notifies of mentions only in others' times: the choice is simply forgotten.
    op.drop_column("users", "times_notification_default")
