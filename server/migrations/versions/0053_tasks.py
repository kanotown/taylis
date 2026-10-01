"""M55: tasks, task_assignees, task_due_alarms and users.notify_tasks (TASKS.md §1, §5)

Revision ID: 0053
Revises: 0052
Create Date: 2026-10-01

- tasks: a channel's board (channel_id set) or someone's own list (channel_id NULL). Three fixed
  columns (status todo / doing / done) ordered by a double `position`; due_on is a date only.
  A task made from a message keeps the link (SET NULL if the row ever goes), the message's channel
  and a one-line excerpt (refreshed when the message is edited, cleared with the link when it is
  deleted). completed_at is set exactly when the status is done (CHECK).
  client_task_id is the creator's idempotency key (unique per owner).
- task_assignees: (task_id, user_id); members of the task's channel only, none on a personal task.
- task_due_alarms: one row per task and person to notify at 8:00 of due_on in their zone, with the
  time it works out to and pending / fired / cancelled (the calendar alarms' pattern), so a
  notification goes out once.
- users.notify_tasks: pushes for task assignments and due dates (default on).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0053"
down_revision: str | None = "0052"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    uid = postgresql.UUID(as_uuid=True)
    op.create_table(
        "tasks",
        sa.Column("id", uid, primary_key=True),
        sa.Column("channel_id", uid, sa.ForeignKey("channels.id"), nullable=True),
        sa.Column("owner_id", uid, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("status", sa.String(8), nullable=False, server_default="todo"),
        sa.Column("position", sa.Double(), nullable=False),
        sa.Column("due_on", sa.Date(), nullable=True),
        sa.Column(
            "source_message_id",
            uid,
            sa.ForeignKey("messages.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("source_channel_id", uid, nullable=True),
        sa.Column("source_excerpt", sa.Text(), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_by", uid, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("client_task_id", sa.String(64), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("char_length(title) BETWEEN 1 AND 200", name="title_length"),
        sa.CheckConstraint("notes IS NULL OR char_length(notes) <= 4000", name="notes_length"),
        sa.CheckConstraint("status IN ('todo', 'doing', 'done')", name="status_values"),
        sa.CheckConstraint(
            "(status = 'done') = (completed_at IS NOT NULL)", name="completed_when_done"
        ),
    )
    op.execute(
        "CREATE INDEX tasks_board_idx ON tasks (channel_id, status, position) "
        "WHERE channel_id IS NOT NULL AND deleted_at IS NULL"
    )
    op.execute(
        "CREATE INDEX tasks_personal_idx ON tasks (owner_id, status, position) "
        "WHERE channel_id IS NULL AND deleted_at IS NULL"
    )
    op.execute(
        "CREATE INDEX tasks_source_idx ON tasks (source_message_id) "
        "WHERE source_message_id IS NOT NULL"
    )
    op.execute(
        "CREATE INDEX tasks_due_idx ON tasks (due_on) "
        "WHERE due_on IS NOT NULL AND deleted_at IS NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX tasks_client_uniq ON tasks (owner_id, client_task_id) "
        "WHERE client_task_id IS NOT NULL"
    )

    op.create_table(
        "task_assignees",
        sa.Column("task_id", uid, sa.ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", uid, sa.ForeignKey("users.id"), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("task_assignees_user_idx", "task_assignees", ["user_id"])

    op.create_table(
        "task_due_alarms",
        sa.Column("task_id", uid, sa.ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", uid, sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("tz", sa.String(64), nullable=False),
        sa.Column("fire_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("status IN ('pending', 'fired', 'cancelled')", name="status_values"),
    )
    op.execute(
        "CREATE INDEX task_due_alarms_due_idx ON task_due_alarms (fire_at) WHERE status = 'pending'"
    )

    op.add_column(
        "users", sa.Column("notify_tasks", sa.Boolean(), nullable=False, server_default="true")
    )


def downgrade() -> None:
    op.drop_column("users", "notify_tasks")
    op.drop_table("task_due_alarms")
    op.drop_table("task_assignees")
    op.drop_table("tasks")
