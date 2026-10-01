import uuid
from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    Double,
    ForeignKey,
    Index,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow

# TASKS.md §1: the three fixed columns of a board.
STATUSES = ("todo", "doing", "done")
MAX_TITLE_LENGTH = 200
MAX_NOTES_LENGTH = 4000
MAX_CLIENT_ID_LENGTH = 64


class Task(Base):
    """A task on a channel's board (channel_id set) or in someone's own list (channel_id NULL,
    only owner_id sees it). DATA_MODEL.md tasks, TASKS.md §1. It does not use the channel's seq.

    `position` orders a column (smaller is higher); a move takes the value between its new
    neighbours, and the column is renumbered when the gap gets too small."""

    __tablename__ = "tasks"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    channel_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("channels.id"))
    # Who made it; the only one who sees a personal task.
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    title: Mapped[str] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(8), default="todo", server_default="todo")
    # L9 (REVIEWS.md): "review" = a review request made from a message (its chip and pushes say so).
    kind: Mapped[str] = mapped_column(String(8), default="task", server_default="task")
    position: Mapped[float] = mapped_column(Double)
    due_on: Mapped[date | None] = mapped_column(Date)
    # Made from a message: the link, its channel and a one-line excerpt. An edit of the message
    # refreshes the excerpt; its deletion clears the link and the excerpt (no copy of a deleted
    # body is kept). The task itself outlives the message.
    source_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL")
    )
    source_channel_id: Mapped[uuid.UUID | None] = mapped_column()
    source_excerpt: Mapped[str | None] = mapped_column(Text)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    # Idempotency key of the POST that made it (unique per creator; a retry returns this task).
    client_task_id: Mapped[str | None] = mapped_column(String(MAX_CLIENT_ID_LENGTH))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            f"char_length(title) BETWEEN 1 AND {MAX_TITLE_LENGTH}", name="title_length"
        ),
        CheckConstraint(
            f"notes IS NULL OR char_length(notes) <= {MAX_NOTES_LENGTH}", name="notes_length"
        ),
        CheckConstraint("status IN ('todo', 'doing', 'done')", name="status_values"),
        CheckConstraint("kind IN ('task', 'review')", name="kind_values"),
        CheckConstraint(
            "(status = 'done') = (completed_at IS NOT NULL)", name="completed_when_done"
        ),
        # A board's column in order.
        Index(
            "tasks_board_idx",
            "channel_id",
            "status",
            "position",
            postgresql_where=text("channel_id IS NOT NULL AND deleted_at IS NULL"),
        ),
        Index(
            "tasks_personal_idx",
            "owner_id",
            "status",
            "position",
            postgresql_where=text("channel_id IS NULL AND deleted_at IS NULL"),
        ),
        # A message edited or deleted: its tasks' excerpts follow (TaskSourceHandler).
        Index(
            "tasks_source_idx",
            "source_message_id",
            postgresql_where=text("source_message_id IS NOT NULL"),
        ),
        # GET /tasks/due (the calendar).
        Index(
            "tasks_due_idx",
            "due_on",
            postgresql_where=text("due_on IS NOT NULL AND deleted_at IS NULL"),
        ),
        Index(
            "tasks_client_uniq",
            "owner_id",
            "client_task_id",
            unique=True,
            postgresql_where=text("client_task_id IS NOT NULL"),
        ),
    )

    @property
    def is_deleted(self) -> bool:
        return self.deleted_at is not None


class TaskAssignee(Base):
    """Who a shared task is assigned to (TASKS.md §1): members of its channel only; a personal
    task has none (it is always its owner's)."""

    __tablename__ = "task_assignees"

    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (Index("task_assignees_user_idx", "user_id"),)


class TaskDueAlarm(Base):
    """The due-date notification of one person on one task (TASKS.md §5): 8:00 of due_on in
    their zone, for an open task's assignees (a personal task: its owner).

    pending → fired once, or cancelled (done, deleted, no longer theirs, or the time had passed
    when worked out). Rows are kept, so a change that leaves fire_at alone never sends it twice.
    """

    __tablename__ = "task_due_alarms"

    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    tz: Mapped[str] = mapped_column(String(64))
    fire_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("status IN ('pending', 'fired', 'cancelled')", name="status_values"),
        Index("task_due_alarms_due_idx", "fire_at", postgresql_where=text("status = 'pending'")),
    )
