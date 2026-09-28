"""Events emitted by the lab module (SYNC_PROTOCOL.md §6): audience all but guests, no seq."""

from app.modules.lab.schemas import RosterUpdatedData

ROSTER_UPDATED = "roster.updated"

__all__ = ["ROSTER_UPDATED", "RosterUpdatedData"]
