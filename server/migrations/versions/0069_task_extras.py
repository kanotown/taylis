"""Task extras: due times, subtasks, repeats and board columns (M81)

Revision ID: 0069
Revises: 0068
Create Date: 2026-10-02

docs/TASKS.md §11.2:

- `tasks.due_at` / `tasks.due_tz`: a due time (due_on stays the date, in due_tz).
- `tasks.subtasks`: the checklist inside a task (jsonb array, in order).
- `tasks.rrule` / `tasks.next_task_id`: the repeat rule and the occurrence made on completion.
- `task_columns` and `tasks.column_id`: columns added to a channel's board (NULL: the built-in
  column of the task's status).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0069"
down_revision: str | None = "0068"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    uid = postgresql.UUID(as_uuid=True)
    op.create_table(
        "task_columns",
        sa.Column("id", uid, primary_key=True),
        sa.Column("channel_id", uid, sa.ForeignKey("channels.id"), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("status", sa.String(8), nullable=False),
        sa.Column("builtin", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("position", sa.Double(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("char_length(name) BETWEEN 1 AND 50", name="name_length"),
        sa.CheckConstraint("status IN ('todo', 'doing', 'done')", name="status_values"),
    )
    op.create_index("task_columns_board_idx", "task_columns", ["channel_id", "position"])
    op.create_index(
        "task_columns_builtin_uniq",
        "task_columns",
        ["channel_id", "status"],
        unique=True,
        postgresql_where=sa.text("builtin"),
    )

    op.add_column("tasks", sa.Column("due_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("tasks", sa.Column("due_tz", sa.String(64), nullable=True))
    op.add_column(
        "tasks",
        sa.Column(
            "subtasks",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.add_column("tasks", sa.Column("rrule", sa.Text(), nullable=True))
    op.add_column("tasks", sa.Column("next_task_id", uid, nullable=True))
    op.add_column("tasks", sa.Column("column_id", uid, nullable=True))
    op.create_foreign_key(
        "tasks_column_id_fkey", "tasks", "task_columns", ["column_id"], ["id"], ondelete="SET NULL"
    )
    op.create_check_constraint("due_time_zone", "tasks", "(due_at IS NULL) = (due_tz IS NULL)")
    op.create_check_constraint("due_time_has_date", "tasks", "due_at IS NULL OR due_on IS NOT NULL")
    op.create_check_constraint("rrule_has_due", "tasks", "rrule IS NULL OR due_on IS NOT NULL")
    op.create_index(
        "tasks_column_idx",
        "tasks",
        ["column_id"],
        postgresql_where=sa.text("column_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("tasks_column_idx", table_name="tasks")
    op.drop_constraint("rrule_has_due", "tasks", type_="check")
    op.drop_constraint("due_time_has_date", "tasks", type_="check")
    op.drop_constraint("due_time_zone", "tasks", type_="check")
    op.drop_constraint("tasks_column_id_fkey", "tasks", type_="foreignkey")
    op.drop_column("tasks", "column_id")
    op.drop_column("tasks", "next_task_id")
    op.drop_column("tasks", "rrule")
    op.drop_column("tasks", "subtasks")
    op.drop_column("tasks", "due_tz")
    op.drop_column("tasks", "due_at")
    op.drop_index("task_columns_builtin_uniq", table_name="task_columns")
    op.drop_index("task_columns_board_idx", table_name="task_columns")
    op.drop_table("task_columns")
