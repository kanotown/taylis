"""times channels (M24): whose times a channel is

Revision ID: 0039
Revises: 0038
Create Date: 2026-09-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0039"
down_revision: str | None = "0038"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("channels", sa.Column("times_owner_id", sa.Uuid(), sa.ForeignKey("users.id")))
    # One times per person.
    op.create_index(
        "channels_times_owner_uniq",
        "channels",
        ["times_owner_id"],
        unique=True,
        postgresql_where=sa.text("times_owner_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("channels_times_owner_uniq", table_name="channels")
    op.drop_column("channels", "times_owner_id")
