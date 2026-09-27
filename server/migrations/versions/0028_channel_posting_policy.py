"""announcement channels (M15a)

Revision ID: 0028
Revises: 0027
Create Date: 2026-09-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0028"
down_revision: str | None = "0027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "channels",
        sa.Column("posting_policy", sa.String(16), nullable=False, server_default="everyone"),
    )
    op.create_check_constraint(
        "posting_policy_values", "channels", "posting_policy IN ('everyone', 'owners')"
    )


def downgrade() -> None:
    op.drop_constraint("posting_policy_values", "channels", type_="check")
    op.drop_column("channels", "posting_policy")
