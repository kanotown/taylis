"""Events emitted by the reads module (SYNC_PROTOCOL.md §6, §10)."""

from app.modules.reads.schemas import ReadUpdatedData

READ_UPDATED = "read.updated"

__all__ = ["READ_UPDATED", "ReadUpdatedData"]
