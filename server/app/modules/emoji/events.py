"""Events emitted by the emoji module (SYNC_PROTOCOL.md §6): audience all, no seq."""

from app.modules.emoji.schemas import EmojiPackUpdatedData, EmojiUpdatedData

EMOJI_UPDATED = "emoji.updated"
# M100: a pack was created, renamed, reordered, got a new tab icon, or was deleted (its emoji
# stay, each announced by emoji.updated with pack_id null).
EMOJI_PACK_UPDATED = "emoji_pack.updated"

__all__ = ["EMOJI_PACK_UPDATED", "EMOJI_UPDATED", "EmojiPackUpdatedData", "EmojiUpdatedData"]
