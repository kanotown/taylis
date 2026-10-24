"""Reservation pools: whether a pool takes walk-ins (「今すぐ」, the queue) (2026-10-24,
docs/RESERVATIONS.md §1)

Revision ID: 0120
Revises: 0119
Create Date: 2026-10-24

reservation_pools.walkins_enabled. The pools that exist keep taking walk-ins (true, no change in
behaviour); a pool made afterwards is booking-only unless its creator turns it on (the column's
default and the API's are false).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0120"
down_revision: str | None = "0119"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Filled with true for the existing rows, then the default for new rows is false.
    op.add_column(
        "reservation_pools",
        sa.Column("walkins_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.alter_column("reservation_pools", "walkins_enabled", server_default=sa.false())


def downgrade() -> None:
    op.drop_column("reservation_pools", "walkins_enabled")
