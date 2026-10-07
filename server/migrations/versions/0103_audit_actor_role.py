"""Roles: the actor's role on each audit row (docs/ROLES.md §6, 2026-10-07)

Revision ID: 0103
Revises: 0102
Create Date: 2026-10-07

- audit_logs.actor_role: the role the actor had when the row was written (NULL without an actor,
  and for rows written before this migration). With the new 「運営」 role (`manager`), what a
  manager did with a right that used to be the administrators' is told apart from an
  administrator's.
- users.role needs no change: it is text without a CHECK constraint (SECURITY.md §3.1); the API
  validates the values (`admin` / `manager` / `member` / `guest`, and `bot` set by the server).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0103"
down_revision: str | None = "0102"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("audit_logs", sa.Column("actor_role", sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column("audit_logs", "actor_role")
