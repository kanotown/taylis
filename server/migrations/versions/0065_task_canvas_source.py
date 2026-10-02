"""Tasks made from a canvas's checklist item (M72)

Revision ID: 0065
Revises: 0064
Create Date: 2026-10-02

docs/CANVAS.md §18.3:

- `tasks.source_canvas_id`: the canvas the task was made from (NULL once the canvas is purged
  from the trash: ON DELETE SET NULL).
- `tasks.source_canvas_excerpt`: the item's text as one plain line, copied when the task was
  made (a one-way link: it does not follow later edits of the canvas).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0065"
down_revision: str | None = "0064"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("source_canvas_id", postgresql.UUID(), nullable=True))
    op.add_column("tasks", sa.Column("source_canvas_excerpt", sa.Text(), nullable=True))
    op.create_foreign_key(
        "tasks_source_canvas_id_fkey",
        "tasks",
        "canvases",
        ["source_canvas_id"],
        ["id"],
        ondelete="SET NULL",
    )
    # A purged canvas sets its tasks' link to NULL: found by this index, not a scan of tasks.
    op.create_index(
        "tasks_source_canvas_idx",
        "tasks",
        ["source_canvas_id"],
        postgresql_where=sa.text("source_canvas_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("tasks_source_canvas_idx", table_name="tasks")
    op.drop_constraint("tasks_source_canvas_id_fkey", "tasks", type_="foreignkey")
    op.drop_column("tasks", "source_canvas_excerpt")
    op.drop_column("tasks", "source_canvas_id")
