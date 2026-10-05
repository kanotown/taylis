"""Events emitted by the reservations module (SYNC_PROTOCOL.md §6): no seq."""

from app.modules.reservations.schemas import ReservationNoticeData, ReservationUpdatedData

RESERVATION_UPDATED = "reservation.updated"  # audience all
RESERVATION_NOTICE = "reservation.notice"  # audience user

__all__ = [
    "RESERVATION_NOTICE",
    "RESERVATION_UPDATED",
    "ReservationNoticeData",
    "ReservationUpdatedData",
]
