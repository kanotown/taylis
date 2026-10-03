"""Workspace icon set by the administrator (M93)

Revision ID: 0074
Revises: 0073
Create Date: 2026-10-04

docs/WORKSPACES.md §3.4: `workspace_settings.icon_key`, the object-store key of the workspace's
icon (a 256px square PNG, like a profile picture). NULL means no icon: clients draw the letter
tile. The icon is public (GET /server/icon), so clients can show it before signing in.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0074"
down_revision: str | None = "0073"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("workspace_settings", sa.Column("icon_key", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("workspace_settings", "icon_key")
