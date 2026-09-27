from typing import Literal
from uuid import UUID

from pydantic import BaseModel


class ServerInfoOut(BaseModel):
    # Always "chikuwachat": the add-workspace dialog tells our server from any other site.
    product: Literal["chikuwachat"] = "chikuwachat"
    # Also in every push payload, so a notification opens the right workspace.
    workspace_id: UUID
    # The name for the switcher (WORKSPACE_NAME, else the application name).
    name: str
    api_version: str
