"""Events of the 操作ボタン (M143, docs/ACTIONS.md §8): audience all but guests, no seq."""

from app.modules.actions.schemas import ActionStatusUpdatedData, ActionsUpdatedData

ACTIONS_UPDATED = "actions.updated"
# §12: a group's state (audience: who may press something in the group), no seq.
ACTIONS_STATUS_UPDATED = "actions.status_updated"

__all__ = [
    "ACTIONS_STATUS_UPDATED",
    "ACTIONS_UPDATED",
    "ActionStatusUpdatedData",
    "ActionsUpdatedData",
]
