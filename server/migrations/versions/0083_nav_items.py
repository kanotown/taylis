"""M111: users.nav_items, my sidebar items / home tiles

Revision ID: 0083
Revises: 0082
Create Date: 2026-10-05

- users.nav_items jsonb: the sidebar's menu items (desktop / Web) and the home's tiles (phones) in
  my order, each with whether it shows: [{"key": "threads", "visible": true}, ...]. NULL (every
  existing row) = not customised, the clients' defaults (apps/shared/nav-items.json). Keys the
  server does not know are kept as sent (clients ignore the ones they do not implement).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0083"
down_revision: str | None = "0082"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("nav_items", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "nav_items")
