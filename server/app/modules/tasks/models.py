import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Double,
    ForeignKey,
    Index,
    SmallInteger,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow

# TASKS.md §1: the three fixed columns of a board.
STATUSES = ("todo", "doing", "done")
MAX_TITLE_LENGTH = 200
MAX_NOTES_LENGTH = 4000
MAX_CLIENT_ID_LENGTH = 64
# M81 (TASKS.md §11): a task's checklist and a board's columns.
MAX_SUBTASKS = 50
MAX_COLUMN_NAME_LENGTH = 50
MAX_COLUMNS_PER_BOARD = 20
# M85 (DEADLINES.md): a deadline's advance notices, as days before it (0 = the day itself).
DEFAULT_NOTICE_DAYS = (7, 3, 1, 0)
MAX_NOTICES = 6
MAX_NOTICE_DAYS_BEFORE = 60


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
    # M85 (DEADLINES.md): "deadline" = a channel's deadline (the header chip, 「締切」, the bot's
    # advance notices in the channel).
    kind: Mapped[str] = mapped_column(String(8), default="task", server_default="task")
    position: Mapped[float] = mapped_column(Double)
    due_on: Mapped[date | None] = mapped_column(Date)
    # M81 (§11.2): a due time. due_on is then due_at's date in due_tz (the wall clock a repeat
    # keeps). NULL: due_on alone (the whole day).
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    due_tz: Mapped[str | None] = mapped_column(String(64))
    # M81: the checklist inside the task, in order: [{"id", "title", "done"}].
    subtasks: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    # M81: the repeat rule (calendar/recurrence.py's subset, normalized) and the occurrence made
    # when this one was completed (set once: completing again makes no second one).
    rrule: Mapped[str | None] = mapped_column(Text)
    next_task_id: Mapped[uuid.UUID | None] = mapped_column()
    # M81: a column added to the board; NULL is the built-in column of its status.
    column_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("task_columns.id", ondelete="SET NULL")
    )
    # M85: a deadline's advance notices (days before, largest first) and the zone whose 9:00 they
    # go out at (due_tz when it has a due time). Both NULL unless kind = deadline.
    notice_days: Mapped[list[int] | None] = mapped_column(ARRAY(SmallInteger))
    notice_tz: Mapped[str | None] = mapped_column(String(64))
    # Made from a message: the link, its channel and a one-line excerpt. An edit of the message
    # refreshes the excerpt; its deletion clears the link and the excerpt (no copy of a deleted
    # body is kept). The task itself outlives the message.
    source_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL")
    )
    source_channel_id: Mapped[uuid.UUID | None] = mapped_column()
    source_excerpt: Mapped[str | None] = mapped_column(Text)
    # M72 (CANVAS.md §18.3): made from a canvas's checklist item: the canvas (NULL once it is purged
    # from the trash) and the item's text as one line, copied when made (a one-way link).
    source_canvas_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("canvases.id", ondelete="SET NULL")
    )
    source_canvas_excerpt: Mapped[str | None] = mapped_column(Text)
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
        CheckConstraint("kind IN ('task', 'review', 'deadline')", name="kind_values"),
        CheckConstraint(
            "(kind = 'deadline') = (notice_days IS NOT NULL)", name="deadline_notice_days"
        ),
        CheckConstraint("(notice_days IS NULL) = (notice_tz IS NULL)", name="deadline_notice_tz"),
        CheckConstraint(
            "kind <> 'deadline' OR (channel_id IS NOT NULL AND due_on IS NOT NULL)",
            name="deadline_has_channel_and_date",
        ),
        CheckConstraint(
            "(status = 'done') = (completed_at IS NOT NULL)", name="completed_when_done"
        ),
        CheckConstraint("(due_at IS NULL) = (due_tz IS NULL)", name="due_time_zone"),
        CheckConstraint("due_at IS NULL OR due_on IS NOT NULL", name="due_time_has_date"),
        CheckConstraint("rrule IS NULL OR due_on IS NOT NULL", name="rrule_has_due"),
        # The cards of a column added to a board (moved out when it is deleted).
        Index(
            "tasks_column_idx",
            "column_id",
            postgresql_where=text("column_id IS NOT NULL"),
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
        # A canvas purged from the trash clears its tasks' link (ON DELETE SET NULL).
        Index(
            "tasks_source_canvas_idx",
            "source_canvas_id",
            postgresql_where=text("source_canvas_id IS NOT NULL"),
        ),
        # M85: GET /tasks/deadlines (「締切」).
        Index(
            "tasks_deadline_idx",
            "channel_id",
            "due_on",
            postgresql_where=text("kind = 'deadline' AND deleted_at IS NULL"),
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


class TaskColumn(Base):
    """A column of a channel's board (M81, TASKS.md §11.2). Each belongs to one of the three
    statuses; the cards of a "done" one are completed. The three built-in columns (one per status)
    have fixed ids (uuid5 of the channel and the status) and get rows only once the board's layout
    changes; a task in one has column_id NULL."""

    __tablename__ = "task_columns"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"))
    name: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(8))
    builtin: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    position: Mapped[float] = mapped_column(Double)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            f"char_length(name) BETWEEN 1 AND {MAX_COLUMN_NAME_LENGTH}", name="name_length"
        ),
        CheckConstraint("status IN ('todo', 'doing', 'done')", name="status_values"),
        Index("task_columns_board_idx", "channel_id", "position"),
        Index(
            "task_columns_builtin_uniq",
            "channel_id",
            "status",
            unique=True,
            postgresql_where=text("builtin"),
        ),
    )


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


class TaskDeadlineNotice(Base):
    """M85 (DEADLINES.md §3): one advance notice of a deadline, posted by the deadline bot in its
    channel. The key holds the time it was planned for, so moving the deadline plans new rows
    (and posts again for the new date) while a time already posted is never posted twice.

    pending → fired (the message it posted) or cancelled (moved, completed, deleted, the channel
    archived, the deadline passed, or the time had passed when planned)."""

    __tablename__ = "task_deadline_notices"

    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True
    )
    days_before: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    fire_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("status IN ('pending', 'fired', 'cancelled')", name="status_values"),
        Index(
            "task_deadline_notices_due_idx",
            "fire_at",
            postgresql_where=text("status = 'pending'"),
        ),
    )


class SystemBot(Base):
    """M85: a bot account the server posts as on its own (key "deadlines": the deadline bot,
    「締切」), made the first time it is needed."""

    __tablename__ = "system_bots"

    key: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
