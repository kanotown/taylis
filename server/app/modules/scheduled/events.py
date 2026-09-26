"""Events emitted by the scheduled module (SYNC_PROTOCOL.md §6): audience user, no seq."""

from app.modules.scheduled.schemas import ScheduledUpdatedData

SCHEDULED_UPDATED = "scheduled.updated"

__all__ = ["SCHEDULED_UPDATED", "ScheduledUpdatedData"]
