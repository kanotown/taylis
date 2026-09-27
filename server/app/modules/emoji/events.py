"""Events emitted by the emoji module (SYNC_PROTOCOL.md §6): audience all, no seq."""

from app.modules.emoji.schemas import EmojiUpdatedData

EMOJI_UPDATED = "emoji.updated"

__all__ = ["EMOJI_UPDATED", "EmojiUpdatedData"]
