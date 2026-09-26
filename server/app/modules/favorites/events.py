"""Events emitted by the favorites module (SYNC_PROTOCOL.md §6): audience user, no seq."""

from app.modules.favorites.schemas import FavoriteUpdatedData

FAVORITE_UPDATED = "favorite.updated"

__all__ = ["FAVORITE_UPDATED", "FavoriteUpdatedData"]
