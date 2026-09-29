"""M35: an overall notification setting per person, and channels muted until unmuted

Revision ID: 0044
Revises: 0043
Create Date: 2026-09-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0044"
down_revision: str | None = "0043"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # What a channel without a level of its own notifies of (PUSH_NOTIFICATIONS.md §4).
    op.add_column(
        "users",
        sa.Column("notification_default", sa.String(16), nullable=False, server_default="mentions"),
    )
    # NULL = the person's overall setting; a channel muted until it is unmuted.
    op.alter_column("notification_preferences", "level", existing_type=sa.String(16), nullable=True)
    op.add_column(
        "notification_preferences",
        sa.Column("muted", sa.Boolean(), nullable=False, server_default="false"),
    )
    # A level equal to the old default of its channel type (a timed mute kept the current level,
    # so most rows are these) follows the overall setting from now on, which starts as that default.
    op.execute(
        """
        UPDATE notification_preferences AS p SET level = NULL
        FROM channels AS c
        WHERE c.id = p.channel_id
          AND ((c.type IN ('dm', 'group_dm') AND p.level = 'all')
               OR (c.type NOT IN ('dm', 'group_dm') AND p.level = 'mentions'))
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE notification_preferences AS p
        SET level = CASE WHEN c.type IN ('dm', 'group_dm') THEN 'all' ELSE 'mentions' END
        FROM channels AS c
        WHERE c.id = p.channel_id AND p.level IS NULL
        """
    )
    op.drop_column("notification_preferences", "muted")
    op.alter_column(
        "notification_preferences", "level", existing_type=sa.String(16), nullable=False
    )
    op.drop_column("users", "notification_default")
