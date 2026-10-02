"""New users are notified of every message by default (users.notification_default 'all')

Revision ID: 0060
Revises: 0059
Create Date: 2026-10-02

The user asked for 「すべてのメッセージ」 as the default; replies only in a thread reach just its
followers (planner), so "all" no longer means every thread chat. Existing users keep their value.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0060"
down_revision: str | None = "0059"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("users", "notification_default", server_default="all")


def downgrade() -> None:
    op.alter_column("users", "notification_default", server_default="mentions")
