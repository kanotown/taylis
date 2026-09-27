"""workspace identity: the id clients use to route pushes between workspaces

Revision ID: 0034
Revises: 0033
Create Date: 2026-09-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0034"
down_revision: str | None = "0033"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # One row (WORKSPACES.md §3). A random id: it only has to differ between deployments.
    op.create_table(
        "workspace_identity",
        sa.Column("singleton", sa.Boolean(), primary_key=True, server_default=sa.true()),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("singleton", name="workspace_identity_singleton"),
    )
    op.execute("INSERT INTO workspace_identity (singleton, id) VALUES (true, gen_random_uuid())")


def downgrade() -> None:
    op.drop_table("workspace_identity")
