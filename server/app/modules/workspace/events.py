from pydantic import BaseModel

from app.modules.workspace.schemas import WorkspaceSettingsOut

# M88: an administrator changed the workspace settings; every signed-in device (guests too: the
# settings say how channels look to everyone).
WORKSPACE_SETTINGS_UPDATED = "workspace.settings_updated"


class WorkspaceSettingsUpdatedData(BaseModel):
    settings: WorkspaceSettingsOut
