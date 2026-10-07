"""Calls: why a connection was closed (docs/CALLS.md §3.3)

Revision ID: 0105
Revises: 0104
Create Date: 2026-10-07

- call_participants.left_reason: 'left' (LiveKit's participant_left, or the person hung up),
  'reconciled' (the reconcile did not find it in LiveKit's list) or 'ended' (the call ended).
  A connection only the reconcile closed is opened again when a later reconcile finds it in
  LiveKit after all; a confirmed leave never is (review v0.1.43 #5).
- Rows closed before this migration keep NULL and are treated as confirmed (never reopened).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0105"
down_revision: str | None = "0104"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("call_participants", sa.Column("left_reason", sa.Text(), nullable=True))
    op.create_check_constraint(
        "call_participants_left_reason_check",
        "call_participants",
        "left_reason IS NULL OR left_reason IN ('left', 'reconciled', 'ended')",
    )


def downgrade() -> None:
    op.drop_constraint("call_participants_left_reason_check", "call_participants", type_="check")
    op.drop_column("call_participants", "left_reason")
