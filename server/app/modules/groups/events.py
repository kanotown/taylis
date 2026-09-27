"""Events emitted by the groups module (SYNC_PROTOCOL.md §6): audience all, no seq."""

from app.modules.groups.schemas import GroupUpdatedData

GROUP_UPDATED = "group.updated"

__all__ = ["GROUP_UPDATED", "GroupUpdatedData"]
