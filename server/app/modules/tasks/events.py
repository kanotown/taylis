"""Events emitted by the tasks module (SYNC_PROTOCOL.md §6, TASKS.md §4): no seq.

task.updated / task.deleted go to the channel's members (a personal task: its owner);
task.assigned and task.due to the one person they concern (they carry the pushes of §5)."""

from app.modules.tasks.schemas import (
    TaskAssignedData,
    TaskDeletedData,
    TaskDueData,
    TaskUpdatedData,
)

TASK_UPDATED = "task.updated"
TASK_DELETED = "task.deleted"
TASK_ASSIGNED = "task.assigned"
TASK_DUE = "task.due"

__all__ = [
    "TASK_ASSIGNED",
    "TASK_DELETED",
    "TASK_DUE",
    "TASK_UPDATED",
    "TaskAssignedData",
    "TaskDeletedData",
    "TaskDueData",
    "TaskUpdatedData",
]
