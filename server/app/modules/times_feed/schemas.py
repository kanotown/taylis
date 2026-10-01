from pydantic import BaseModel

from app.modules.messages.schemas import MessageOut


class TimesFeedOut(BaseModel):
    items: list[MessageOut]
    # The last item's (created_at, id) as "<ISO 8601>_<uuid>": pass it back as `cursor` for the
    # next page (null: no more). Opaque to clients.
    next_cursor: str | None
