"""Events emitted by the reservations module (SYNC_PROTOCOL.md §6): audience channel, no seq."""

from app.modules.reservations.schemas import ReservationUpdatedData

RESERVATION_UPDATED = "reservation.updated"

__all__ = ["RESERVATION_UPDATED", "ReservationUpdatedData"]
