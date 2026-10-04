"""Events emitted by the moderation module (SYNC_PROTOCOL.md §6): audience user, no seq."""

from app.modules.moderation.schemas import BlockUpdatedData

BLOCK_UPDATED = "block.updated"

__all__ = ["BLOCK_UPDATED", "BlockUpdatedData"]
