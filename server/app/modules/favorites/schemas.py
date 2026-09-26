from uuid import UUID

from pydantic import BaseModel


class FavoriteStateOut(BaseModel):
    channel_id: UUID
    favorite: bool


class FavoriteUpdatedData(BaseModel):
    channel_id: UUID
    favorite: bool
