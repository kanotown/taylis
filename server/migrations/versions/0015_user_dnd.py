"""do not disturb and quiet hours (M12c)

Revision ID: 0015
Revises: 0014
Create Date: 2026-09-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("dnd_until", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("quiet_hours_start", sa.SmallInteger(), nullable=True))
    op.add_column("users", sa.Column("quiet_hours_end", sa.SmallInteger(), nullable=True))
    op.add_column(
        "users",
        sa.Column("quiet_hours_days", postgresql.ARRAY(sa.SmallInteger()), nullable=True),
    )
    op.add_column("users", sa.Column("quiet_hours_tz", sa.Text(), nullable=True))


def downgrade() -> None:
    for column in (
        "quiet_hours_tz",
        "quiet_hours_days",
        "quiet_hours_end",
        "quiet_hours_start",
        "dnd_until",
    ):
        op.drop_column("users", column)
