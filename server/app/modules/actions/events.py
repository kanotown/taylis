"""Events of the 操作ボタン (M143, docs/ACTIONS.md §8): audience all but guests, no seq."""

from app.modules.actions.schemas import ActionsUpdatedData

ACTIONS_UPDATED = "actions.updated"

__all__ = ["ACTIONS_UPDATED", "ActionsUpdatedData"]
