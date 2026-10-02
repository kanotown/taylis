"""Events emitted by the canvases module (SYNC_PROTOCOL.md §6, §14): audience channel, no seq.

They carry the canvas's metadata, never its body (CANVAS.md §4.6). canvas.mentioned (M72,
CANVAS.md §18.1) goes to one person each."""

from app.modules.canvases.schemas import (
    CanvasCreatedData,
    CanvasDeletedData,
    CanvasMentionedData,
    CanvasUpdatedData,
)

CANVAS_CREATED = "canvas.created"
CANVAS_UPDATED = "canvas.updated"
CANVAS_DELETED = "canvas.deleted"
CANVAS_MENTIONED = "canvas.mentioned"

__all__ = [
    "CANVAS_CREATED",
    "CANVAS_DELETED",
    "CANVAS_MENTIONED",
    "CANVAS_UPDATED",
    "CanvasCreatedData",
    "CanvasDeletedData",
    "CanvasMentionedData",
    "CanvasUpdatedData",
]
