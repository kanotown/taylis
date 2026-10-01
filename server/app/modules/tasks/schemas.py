from datetime import date, datetime
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.tasks.models import MAX_CLIENT_ID_LENGTH, MAX_NOTES_LENGTH, MAX_TITLE_LENGTH

TaskStatus = Literal["todo", "doing", "done"]
# L9: "review" is a review request made from a message (REVIEWS.md).
TaskKind = Literal["task", "review"]
# A shared task's assignees at most (a channel of several dozen people).
MAX_ASSIGNEES = 50


def _clean_title(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = " ".join(value.split())
    if not cleaned:
        raise ValueError("A title cannot be blank")
    return cleaned


def _clean_notes(value: str | None) -> str | None:
    """Blank becomes null (no notes)."""
    if value is None:
        return None
    cleaned = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    return cleaned or None


def _valid_zone(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("Unknown time zone") from exc
    return value


def _distinct(value: list[UUID] | None) -> list[UUID] | None:
    if value is None:
        return None
    return list(dict.fromkeys(value))


class TaskSourceOut(BaseModel):
    """The message a task was made from (TASKS.md §1), with its text as one line (the DM list's
    and the notifications' rule), kept up to date with edits. When the message is deleted the task
    stays: message_id and excerpt become null (「元のメッセージは削除されました」)."""

    message_id: UUID | None
    channel_id: UUID
    excerpt: str | None


class TaskData(BaseModel):
    """A task as everyone who sees it sees it: task.updated carries this (can_delete, which
    differs per person, is in TaskOut)."""

    id: UUID
    # null: the owner's own list. Else the channel's board.
    channel_id: UUID | None
    channel_name: str | None
    # Who made it (the only one who sees a personal task).
    owner_id: UUID
    kind: TaskKind = "task"
    title: str
    # Markdown (the messages' syntax).
    notes: str | None
    status: TaskStatus
    # Order within the column, smaller first. Only the order means anything.
    position: float
    # The due date (no time).
    due_on: date | None
    # Members of the channel; always empty on a personal task (it is its owner's).
    assignee_ids: list[UUID]
    source: TaskSourceOut | None
    completed_at: datetime | None
    completed_by: UUID | None
    created_at: datetime
    updated_at: datetime


class TaskOut(TaskData):
    # I may delete it: a personal task's owner; on a board (not archived) its creator, its
    # assignees, the channel's owners and administrators.
    can_delete: bool


class TaskCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Left out: my own list. Else a public or private channel I can post in (not a DM).
    channel_id: UUID | None = None
    title: str = Field(max_length=MAX_TITLE_LENGTH)
    notes: str | None = Field(default=None, max_length=MAX_NOTES_LENGTH)
    status: TaskStatus = "todo"
    due_on: date | None = None
    # Members of the channel; must be empty (or left out) for a personal task.
    assignee_ids: list[UUID] = Field(default_factory=list, max_length=MAX_ASSIGNEES)
    # A message I can see. A shared task's must be in the same channel. L9: a DM's task (shared
    # with its members) must come from one of its messages.
    source_message_id: UUID | None = None
    # L9: "review" (「レビューを依頼」) changes the wording of its chip and pushes.
    kind: TaskKind = "task"
    # Idempotency key: a retry returns the task made by the first request (200).
    client_task_id: str | None = Field(default=None, min_length=1, max_length=MAX_CLIENT_ID_LENGTH)
    # The device's IANA zone: my due-date notification goes out at 8:00 in it. Left out: my
    # quiet-hours zone, else Asia/Tokyo.
    tz: str | None = Field(default=None, max_length=64)

    _title = field_validator("title")(_clean_title)
    _notes = field_validator("notes")(_clean_notes)
    _assignees = field_validator("assignee_ids")(_distinct)
    _tz = field_validator("tz")(_valid_zone)


class TaskUpdate(BaseModel):
    """Only the fields sent change; `assignee_ids` replaces the whole list. A task cannot move
    to another board."""

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=MAX_TITLE_LENGTH)
    # null (or blank) clears.
    notes: str | None = Field(default=None, max_length=MAX_NOTES_LENGTH)
    # A new column: the task goes to the bottom of todo / doing, to the top of done.
    status: TaskStatus | None = None
    # null clears.
    due_on: date | None = None
    assignee_ids: list[UUID] | None = Field(default=None, max_length=MAX_ASSIGNEES)
    tz: str | None = Field(default=None, max_length=64)

    _title = field_validator("title")(_clean_title)
    _notes = field_validator("notes")(_clean_notes)
    _assignees = field_validator("assignee_ids")(_distinct)
    _tz = field_validator("tz")(_valid_zone)


class TaskMove(BaseModel):
    """Into a column and between two cards there (the server picks the position). `after_id` is
    the card that ends up just above, `before_id` the one just below; either is enough. Neither:
    the bottom of todo / doing, the top of done. A neighbour that is no longer in that column is
    ignored."""

    model_config = ConfigDict(extra="forbid")

    status: TaskStatus
    before_id: UUID | None = None
    after_id: UUID | None = None


class TaskUpdatedData(BaseModel):
    """task.updated: a new, changed or moved task, to those who see it."""

    task: TaskData
    # Who may delete it now (can_delete is `my id in deleter_ids`): the creator (if still a
    # member), the assignees, the channel's owners and the administrators among its members;
    # nobody in an archived channel; a personal task's owner.
    deleter_ids: list[UUID]


class TaskDeletedData(BaseModel):
    id: UUID
    channel_id: UUID | None


class TaskAssignedData(BaseModel):
    """task.assigned: someone else added me to a task's assignees (the push of TASKS.md §5)."""

    task_id: UUID
    channel_id: UUID
    channel_name: str
    title: str
    by_user_id: UUID
    # L9: "review": the push says a review was requested.
    kind: TaskKind = "task"


class TaskReviewDoneData(BaseModel):
    """task.review_done: an assignee completed my review request (L9, REVIEWS.md §4)."""

    task_id: UUID
    channel_id: UUID
    channel_name: str
    title: str
    by_user_id: UUID


class TaskDueData(BaseModel):
    """task.due: one of my open tasks is due today (8:00 in my zone); sent once."""

    task_id: UUID
    channel_id: UUID | None
    channel_name: str | None
    title: str
    due_on: date
