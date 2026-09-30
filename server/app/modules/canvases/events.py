"""Events emitted by the canvases module (SYNC_PROTOCOL.md §6, §14): audience channel, no seq.

They carry the canvas's metadata, never its body (CANVAS.md §4.6)."""

from app.modules.canvases.schemas import CanvasCreatedData, CanvasDeletedData, CanvasUpdatedData

CANVAS_CREATED = "canvas.created"
CANVAS_UPDATED = "canvas.updated"
CANVAS_DELETED = "canvas.deleted"

__all__ = [
    "CANVAS_CREATED",
    "CANVAS_DELETED",
    "CANVAS_UPDATED",
    "CanvasCreatedData",
    "CanvasDeletedData",
    "CanvasUpdatedData",
]
