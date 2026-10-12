"""Quiet hours on by default: 22:00 → 07:00 every day, Asia/Tokyo (PUSH_NOTIFICATIONS.md §4)

Revision ID: 0117
Revises: 0116
Create Date: 2026-10-13

Every person without a quiet-hours window gets 22:00 → 07:00 every day in Asia/Tokyo; new accounts
get the same in code (app.modules.users.dnd.apply_default_quiet_hours). Bots are left alone (they
receive no pushes). Before this, "no window" and "turned it off" were the same NULLs, so someone who
had switched quiet hours off gets them back and can switch them off again. The downgrade does not
undo it: after the upgrade a window that happens to equal the default cannot be told apart from
one the person chose.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0117"
down_revision: str | None = "0116"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE users
           SET quiet_hours_start = 1320,
               quiet_hours_end = 420,
               quiet_hours_days = NULL,
               quiet_hours_tz = 'Asia/Tokyo',
               updated_at = now()
         WHERE quiet_hours_start IS NULL
           AND role <> 'bot'
           AND bot_kind IS NULL
        """
    )


def downgrade() -> None:
    pass
