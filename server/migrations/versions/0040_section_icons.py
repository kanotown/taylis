"""sidebar sections (M26): an icon and a collapsed state

Revision ID: 0040
Revises: 0039
Create Date: 2026-09-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0040"
down_revision: str | None = "0039"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("sidebar_sections", sa.Column("emoji", sa.String(64)))
    op.add_column(
        "sidebar_sections",
        sa.Column("collapsed", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("sidebar_sections", "collapsed")
    op.drop_column("sidebar_sections", "emoji")
