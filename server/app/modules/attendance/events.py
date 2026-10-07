"""Events of the 在室状況 board (M140, docs/PRESENCE.md §4): audience all but guests, no seq."""

from app.modules.attendance.schemas import AttendanceConfigUpdatedData, AttendanceUpdatedData

ATTENDANCE_UPDATED = "attendance.updated"
ATTENDANCE_CONFIG_UPDATED = "attendance.config_updated"

__all__ = [
    "ATTENDANCE_CONFIG_UPDATED",
    "ATTENDANCE_UPDATED",
    "AttendanceConfigUpdatedData",
    "AttendanceUpdatedData",
]
