"""Events about user accounts (emitted by the users and admin modules)."""

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.outbox import write_outbox
from app.modules.users.models import User
from app.modules.users.schemas import UserPublic, to_user_public

USER_CREATED = "user.created"
USER_UPDATED = "user.updated"
USER_DEACTIVATED = "user.deactivated"


class UserEventData(BaseModel):
    user: UserPublic


async def emit_user_event(db: AsyncSession, event_type: str, user: User) -> None:
    payload = UserEventData(user=to_user_public(user)).model_dump(mode="json")
    await write_outbox(db, event_type=event_type, audience_type="all", payload=payload)
