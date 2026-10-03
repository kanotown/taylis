"""Default channels set by the administrator (M90)

Revision ID: 0073
Revises: 0072
Create Date: 2026-10-03

docs/MEMBERSHIP.md §6: `workspace_settings.default_channel_ids`, the public channels every new
non-guest account joins, in order. NULL means "never set": the server then keeps M48's
`SSO_DEFAULT_CHANNELS` (names) for accounts made by Google sign-in. Once an administrator saves
the list (even an empty one) the setting wins. No data is written: existing deployments keep
their behaviour until an administrator chooses channels.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0073"
down_revision: str | None = "0072"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "workspace_settings",
        sa.Column("default_channel_ids", postgresql.ARRAY(sa.Uuid()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("workspace_settings", "default_channel_ids")
