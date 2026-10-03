"""Events of the activity module (SYNC_PROTOCOL.md §6): audience user, no seq."""

from app.modules.activity.schemas import ActivityReadData, ActivityUpdatedData, ReactionAddedData

ACTIVITY_READ = "activity.read"
ACTIVITY_UPDATED = "activity.updated"
REACTION_ADDED = "reaction.added"

__all__ = [
    "ACTIVITY_READ",
    "ACTIVITY_UPDATED",
    "REACTION_ADDED",
    "ActivityReadData",
    "ActivityUpdatedData",
    "ReactionAddedData",
]
