"""Events emitted by the 備品 module (docs/LENDING.md §9, SYNC_PROTOCOL.md §6): no seq."""

from app.modules.lending.schemas import LendingUpdatedData

LENDING_UPDATED = "lending.updated"  # audience all

__all__ = ["LENDING_UPDATED", "LendingUpdatedData"]
