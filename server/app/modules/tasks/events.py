"""Events emitted by the tasks module (SYNC_PROTOCOL.md §6, TASKS.md §4): no seq.

task.updated / task.deleted go to the channel's members (a personal task: its owner);
task.assigned and task.due to the one person they concern (they carry the pushes of §5)."""

from app.modules.tasks.schemas import (
    TaskAssignedData,
    TaskColumnsUpdatedData,
    TaskDeletedData,
    TaskDueData,
    TaskReviewDoneData,
    TaskUpdatedData,
)

TASK_UPDATED = "task.updated"
TASK_DELETED = "task.deleted"
TASK_ASSIGNED = "task.assigned"
TASK_DUE = "task.due"
# L9: to the requester when an assignee completes a review request.
TASK_REVIEW_DONE = "task.review_done"
# M81: a board's columns changed (all of them), to the channel's members.
TASK_COLUMNS_UPDATED = "task.columns.updated"

__all__ = [
    "TASK_ASSIGNED",
    "TASK_COLUMNS_UPDATED",
    "TASK_DELETED",
    "TASK_DUE",
    "TASK_REVIEW_DONE",
    "TASK_UPDATED",
    "TaskAssignedData",
    "TaskColumnsUpdatedData",
    "TaskDeletedData",
    "TaskDueData",
    "TaskReviewDoneData",
    "TaskUpdatedData",
]
