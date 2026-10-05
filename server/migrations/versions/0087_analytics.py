"""users.last_login_at / last_active_at, user_activity_hours (M116)

Revision ID: 0087
Revises: 0086
Create Date: 2026-10-06

docs/ANALYTICS.md: administrators see when each person last signed in and last used an app, and a
few workspace numbers. Backfill: the last sign-in is the newest session's start; the last activity
is the newest of the sessions' last use and the devices' last_seen_at (sessions and devices are
purged 30 / 90 days after they end, so people gone longer stay NULL, shown as 「記録なし」).
Posts are not used: imported history (Mattermost, Slack) would date people by the old system. The
hourly activity rows start empty (the series fills from now on). The counts over messages use the
existing messages_created_idx (0037, created_at WHERE deleted_at IS NULL).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0087"
down_revision: str | None = "0086"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("last_active_at", sa.DateTime(timezone=True), nullable=True))
    op.create_table(
        "user_activity_hours",
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("hour", sa.DateTime(timezone=True), primary_key=True),
    )
    op.create_index("user_activity_hours_hour_idx", "user_activity_hours", ["hour"])
    op.execute(
        """
        UPDATE users u SET last_login_at = s.created
        FROM (SELECT user_id, max(created_at) AS created FROM sessions GROUP BY user_id) s
        WHERE s.user_id = u.id
        """
    )
    op.execute(
        """
        UPDATE users u SET last_active_at = a.at
        FROM (
          SELECT user_id, max(at) AS at FROM (
            SELECT user_id, last_used_at AS at FROM sessions
            UNION ALL
            SELECT user_id, last_seen_at FROM devices WHERE last_seen_at IS NOT NULL
          ) t GROUP BY user_id
        ) a
        WHERE a.user_id = u.id AND u.role <> 'bot'
        """
    )


def downgrade() -> None:
    op.drop_index("user_activity_hours_hour_idx", table_name="user_activity_hours")
    op.drop_table("user_activity_hours")
    op.drop_column("users", "last_active_at")
    op.drop_column("users", "last_login_at")
