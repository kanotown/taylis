"""users.presence_manual, the manual 離席中 of the quick status menu (docs/PRESENCE.md §11)

Revision ID: 0111
Revises: 0110
Create Date: 2026-10-09

- users.presence_manual: "away" = I chose 離席中 (the hub announces me as away even while I use an
  app); NULL (every existing row) = automatic. 取り込み中 is users.dnd_until (M12c) and
  オフライン表示 is users.presence_hidden (L4), so they need no column of their own. Set through
  PUT /users/me/presence. Other values may come later (the CHECK lists the known ones).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0111"
down_revision: str | None = "0110"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("presence_manual", sa.String(16), nullable=True))
    op.create_check_constraint("presence_manual", "users", "presence_manual IN ('away')")


def downgrade() -> None:
    op.drop_constraint("presence_manual", "users", type_="check")
    op.drop_column("users", "presence_manual")
