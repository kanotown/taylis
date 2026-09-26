from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class LinkPreviewOut(BaseModel):
    url: str
    status: Literal["ok", "failed"]
    title: str | None = None
    description: str | None = None
    image_url: str | None = None
    site_name: str | None = None
    fetched_at: datetime
