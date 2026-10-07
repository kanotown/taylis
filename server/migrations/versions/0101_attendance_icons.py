"""在室状況: icons for the states (docs/PRESENCE.md §2.1, 2026-10-07)

Revision ID: 0101
Revises: 0100
Create Date: 2026-10-07

- attendance_states.icon: a key of apps/shared/attendance-icons.json (NULL = none; clients then
  show the emoji, which stays as the fallback for clients without the catalogue).
- Backfill: a workspace state (owner_id NULL) that still has its kind's default emoji (the ones
  0100's first enabling made: 🟢 in_room, 🏫 on_site, 🚶 off_site, 🏠 gone) gets that default
  state's icon. Matched by kind and emoji, not by name, so a renamed default (or one made in
  another language) is still found, while a state whose emoji an administrator changed (or
  removed) is left alone. Personal states are never touched. Colours are not changed (the new
  defaults, purple 学外 / red 帰宅, only apply to workspaces that enable the board from now on).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0101"
down_revision: str | None = "0100"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# A default state's kind and emoji (app/modules/attendance/service.py DEFAULT_STATES) -> its icon
# (the icon key is the kind's name). tests/test_attendance.py runs this on a test database.
BACKFILL = sa.text(
    "UPDATE attendance_states SET icon = kind "
    "WHERE owner_id IS NULL AND icon IS NULL AND (kind, emoji) IN "
    "(('in_room', '🟢'), ('on_site', '🏫'), ('off_site', '🚶'), ('gone', '🏠'))"
)


def upgrade() -> None:
    op.add_column("attendance_states", sa.Column("icon", sa.String(32), nullable=True))
    op.execute(BACKFILL)


def downgrade() -> None:
    op.drop_column("attendance_states", "icon")
