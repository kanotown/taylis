"""Events emitted by the ai module (SYNC_PROTOCOL.md §6, docs/AI.md §5): no seq.

ai.run_updated goes to the person who asked for a summary (all their devices) whenever its state
changes (running, done, failed). Mention runs emit nothing: their reply is an ordinary message."""

from app.modules.ai.schemas import AiRunUpdatedData

AI_RUN_UPDATED = "ai.run_updated"

__all__ = ["AI_RUN_UPDATED", "AiRunUpdatedData"]
