"""Events emitted by the DM pins module (SYNC_PROTOCOL.md §6): audience user, no seq."""

from app.modules.dm_pins.schemas import DmPinUpdatedData

DM_PIN_UPDATED = "dm_pin.updated"

__all__ = ["DM_PIN_UPDATED", "DmPinUpdatedData"]
