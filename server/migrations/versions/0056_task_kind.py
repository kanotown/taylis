"""M63: tasks.kind for review requests (REVIEWS.md §2-§3, L9)

Revision ID: 0056
Revises: 0055
Create Date: 2026-10-02

A task made with 「レビューを依頼」 is kind "review": the chip under its message and the pushes say
レビュー依頼 instead of タスク. Every task so far is "task". (A message's tasks are read through the
existing tasks_source_idx.)
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0056"
down_revision: str | None = "0055"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("kind", sa.String(8), nullable=False, server_default="task"))
    op.create_check_constraint("kind_values", "tasks", "kind IN ('task', 'review')")


def downgrade() -> None:
    op.drop_constraint("kind_values", "tasks", type_="check")
    op.drop_column("tasks", "kind")
