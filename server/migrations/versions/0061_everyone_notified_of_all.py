"""Existing people switch to 「すべてのメッセージ」 too (users.notification_default 'all')

Revision ID: 0061
Revises: 0060
Create Date: 2026-10-02

The user decided (2026-10-02) that everyone, not only new accounts (0060), is notified of every
message by default. People on "mentions" move to "all"; "none" stays (a deliberate choice), and bots
are left alone. Since 0060 a reply only in a thread reaches its followers and mentions, so "all"
does not mean every thread chat. Devices pick the value up with their next bootstrap.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0061"
down_revision: str | None = "0060"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "UPDATE users SET notification_default = 'all', updated_at = now() "
        "WHERE notification_default = 'mentions' AND role <> 'bot'"
    )


def downgrade() -> None:
    pass  # who had "mentions" before is not recorded; the value stays
