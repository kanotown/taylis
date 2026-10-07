"""Attendance: the time of the last applied change, apart from `since` (docs/PRESENCE.md §6)

Revision ID: 0104
Revises: 0103
Create Date: 2026-10-07

- attendance_current.changed_at: when the last change that was taken (state or note) happened.
  `since` only moves when the state changes, so comparing a late change with it let an older
  note overwrite a newer one (review v0.1.43 #8). The inbound API now compares with this.
- Backfill: the newest logged change of the person (the log's `at` is the moment the change was
  applied), never earlier than `since` (the log may have been purged).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0104"
down_revision: str | None = "0103"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

BACKFILL = sa.text(
    """
    UPDATE attendance_current c
    SET changed_at = GREATEST(
        c.since,
        COALESCE((SELECT max(l.at) FROM attendance_log l WHERE l.user_id = c.user_id), c.since)
    )
    """
)


def upgrade() -> None:
    op.add_column(
        "attendance_current", sa.Column("changed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.execute(BACKFILL)
    op.alter_column("attendance_current", "changed_at", nullable=False)


def downgrade() -> None:
    op.drop_column("attendance_current", "changed_at")
