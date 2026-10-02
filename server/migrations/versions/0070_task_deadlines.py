"""Deadlines on top of tasks (M85, L5)

Revision ID: 0070
Revises: 0069
Create Date: 2026-10-02

docs/DEADLINES.md §3:

- `tasks.kind` gains `deadline` (a channel's deadline: the header chip, 「締切」, the bot's
  notices).
- `tasks.notice_days` / `tasks.notice_tz`: a deadline's advance notices (days before) and the zone
  whose 9:00 they go out at.
- `task_deadline_notices`: one row per planned notice (task, days before, the time planned) —
  the record that keeps the bot from posting the same notice twice.
- `system_bots`: bot accounts the server posts as by itself (`deadlines`: 「締切」).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0070"
down_revision: str | None = "0069"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    uid = postgresql.UUID(as_uuid=True)
    op.drop_constraint("kind_values", "tasks", type_="check")
    op.create_check_constraint("kind_values", "tasks", "kind IN ('task', 'review', 'deadline')")
    op.add_column("tasks", sa.Column("notice_days", postgresql.ARRAY(sa.SmallInteger())))
    op.add_column("tasks", sa.Column("notice_tz", sa.String(64)))
    op.create_check_constraint(
        "deadline_notice_days", "tasks", "(kind = 'deadline') = (notice_days IS NOT NULL)"
    )
    op.create_check_constraint(
        "deadline_notice_tz", "tasks", "(notice_days IS NULL) = (notice_tz IS NULL)"
    )
    op.create_check_constraint(
        "deadline_has_channel_and_date",
        "tasks",
        "kind <> 'deadline' OR (channel_id IS NOT NULL AND due_on IS NOT NULL)",
    )

    op.create_table(
        "task_deadline_notices",
        sa.Column("task_id", uid, sa.ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("days_before", sa.SmallInteger(), primary_key=True),
        sa.Column("fire_at", sa.DateTime(timezone=True), primary_key=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("message_id", uid, sa.ForeignKey("messages.id", ondelete="SET NULL")),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("status IN ('pending', 'fired', 'cancelled')", name="status_values"),
    )
    op.create_index(
        "task_deadline_notices_due_idx",
        "task_deadline_notices",
        ["fire_at"],
        postgresql_where=sa.text("status = 'pending'"),
    )
    # 「締切」 lists the deadlines of my channels.
    op.create_index(
        "tasks_deadline_idx",
        "tasks",
        ["channel_id", "due_on"],
        postgresql_where=sa.text("kind = 'deadline' AND deleted_at IS NULL"),
    )

    op.create_table(
        "system_bots",
        sa.Column("key", sa.String(32), primary_key=True),
        sa.Column("user_id", uid, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )


def downgrade() -> None:
    op.drop_table("system_bots")
    op.drop_index("tasks_deadline_idx", table_name="tasks")
    op.drop_index("task_deadline_notices_due_idx", table_name="task_deadline_notices")
    op.drop_table("task_deadline_notices")
    op.drop_constraint("deadline_has_channel_and_date", "tasks", type_="check")
    op.drop_constraint("deadline_notice_tz", "tasks", type_="check")
    op.drop_constraint("deadline_notice_days", "tasks", type_="check")
    op.drop_column("tasks", "notice_tz")
    op.drop_column("tasks", "notice_days")
    op.execute("UPDATE tasks SET kind = 'task' WHERE kind = 'deadline'")
    op.drop_constraint("kind_values", "tasks", type_="check")
    op.create_check_constraint("kind_values", "tasks", "kind IN ('task', 'review')")
