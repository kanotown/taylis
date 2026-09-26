"""Events emitted by the reminders module (SYNC_PROTOCOL.md §6): audience user, no seq."""

from app.modules.reminders.schemas import ReminderUpdatedData

REMINDER_UPDATED = "reminder.updated"

__all__ = ["REMINDER_UPDATED", "ReminderUpdatedData"]
