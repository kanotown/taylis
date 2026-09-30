"""M50: users.quick_reactions, my own long-press quick reactions

Revision ID: 0050
Revises: 0049
Create Date: 2026-10-01

- users.quick_reactions text[]: 1-6 plain emoji in the order the sheet shows them. NULL (every
  existing user) keeps the clients' rule: the ones I used last, then the defaults.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0050"
down_revision: str | None = "0049"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("quick_reactions", postgresql.ARRAY(sa.Text()), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "quick_reactions")
