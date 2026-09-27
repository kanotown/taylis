"""release fixes: read-only thread rows, reminders without body copies

Revision ID: 0033
Revises: 0032
Create Date: 2026-09-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0033"
down_revision: str | None = "0032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Reading a thread no longer follows it: a row with following=false is either "read, never
    # followed" (auto-follow may still turn it on) or an explicit unfollow (unfollowed_at set).
    op.add_column(
        "thread_follows", sa.Column("unfollowed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.execute("UPDATE thread_follows SET unfollowed_at = updated_at WHERE NOT following")
    # Reminder previews are read from the live message now; drop the copies of old bodies.
    op.execute("UPDATE reminders SET preview = ''")


def downgrade() -> None:
    op.drop_column("thread_follows", "unfollowed_at")
