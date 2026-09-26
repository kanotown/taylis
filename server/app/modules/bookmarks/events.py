"""Events emitted by the bookmarks module (SYNC_PROTOCOL.md §6): audience user, no seq."""

from app.modules.bookmarks.schemas import BookmarkUpdatedData

BOOKMARK_UPDATED = "bookmark.updated"

__all__ = ["BOOKMARK_UPDATED", "BookmarkUpdatedData"]
