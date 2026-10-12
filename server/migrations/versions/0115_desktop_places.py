"""users.desktop_places, where Desktop / Web puts each place (docs/MOBILE_UI.md §18.2)

Revision ID: 0115
Revises: 0114
Create Date: 2026-10-12

- users.desktop_places (jsonb): {"rail": bool, "items": [{"key", "place"}]}, place one of
  "rail" (the places rail's icon), "sidebar" (a row near the sidebar's top) or "hidden" (only
  under 「その他」). NULL (every existing row) = never chosen, the clients' defaults. Set through
  PATCH /users/me {desktop_places}. Kept apart from users.nav_items so the phones' tiles are no
  longer shown or hidden by the desktop's placement; the phones ignore it.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0115"
down_revision: str | None = "0114"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("desktop_places", JSONB, nullable=True))


def downgrade() -> None:
    op.drop_column("users", "desktop_places")
