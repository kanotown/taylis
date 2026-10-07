"""Events emitted by the DM closes module (SYNC_PROTOCOL.md §6): audience user, no seq."""

from app.modules.dm_closes.schemas import DmCloseUpdatedData

DM_CLOSE_UPDATED = "dm_close.updated"

__all__ = ["DM_CLOSE_UPDATED", "DmCloseUpdatedData"]
