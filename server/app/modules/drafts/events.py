"""Events emitted by the drafts module (SYNC_PROTOCOL.md §6): audience user, no seq."""

from app.modules.drafts.schemas import DraftUpdatedData

DRAFT_UPDATED = "draft.updated"

__all__ = ["DRAFT_UPDATED", "DraftUpdatedData"]
