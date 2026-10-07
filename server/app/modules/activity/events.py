"""Events of the activity module (SYNC_PROTOCOL.md §6): audience user, no seq."""

from app.modules.activity.schemas import (
    ActivityItemsReadData,
    ActivityReadData,
    ActivityUpdatedData,
    ReactionAddedData,
)

ACTIVITY_READ = "activity.read"
# 2026-10-07 (MOBILE_UI.md §6.4): items opened one by one.
ACTIVITY_ITEMS_READ = "activity.items_read"
ACTIVITY_UPDATED = "activity.updated"
REACTION_ADDED = "reaction.added"

__all__ = [
    "ACTIVITY_ITEMS_READ",
    "ACTIVITY_READ",
    "ACTIVITY_UPDATED",
    "REACTION_ADDED",
    "ActivityItemsReadData",
    "ActivityReadData",
    "ActivityUpdatedData",
    "ReactionAddedData",
]
