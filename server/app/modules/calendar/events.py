"""Events emitted by the calendar module (SYNC_PROTOCOL.md §6, CALENDAR.md §5): no seq.

calendar.event.* go to the channel's members (a personal event: its owner), calendar.alarm.updated
to the person whose alarm it is."""

from app.modules.calendar.schemas import (
    CalendarAlarmUpdatedData,
    CalendarEventDeletedData,
    CalendarEventUpdatedData,
)

CALENDAR_EVENT_UPDATED = "calendar.event.updated"
CALENDAR_EVENT_DELETED = "calendar.event.deleted"
CALENDAR_ALARM_UPDATED = "calendar.alarm.updated"

__all__ = [
    "CALENDAR_ALARM_UPDATED",
    "CALENDAR_EVENT_DELETED",
    "CALENDAR_EVENT_UPDATED",
    "CalendarAlarmUpdatedData",
    "CalendarEventDeletedData",
    "CalendarEventUpdatedData",
]
