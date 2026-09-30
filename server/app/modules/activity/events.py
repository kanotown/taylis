"""Events of the activity module (SYNC_PROTOCOL.md §6): audience user, no seq."""

from app.modules.activity.schemas import ActivityReadData, ReactionAddedData

ACTIVITY_READ = "activity.read"
REACTION_ADDED = "reaction.added"

__all__ = ["ACTIVITY_READ", "REACTION_ADDED", "ActivityReadData", "ReactionAddedData"]
