"""Events emitted by the sidebar module (SYNC_PROTOCOL.md §6): audience user, no seq."""

from app.modules.sidebar.schemas import SidebarUpdatedData

SIDEBAR_UPDATED = "sidebar.updated"

__all__ = ["SIDEBAR_UPDATED", "SidebarUpdatedData"]
