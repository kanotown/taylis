"""Notification preferences (per user and channel)."""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.events.outbox import write_outbox
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.notifications import repository as repo
from app.modules.notifications.events import (
    NOTIFICATION_PREFERENCE_UPDATED,
    NotificationPreferenceUpdatedData,
)
from app.modules.notifications.models import NotificationPreference
from app.modules.notifications.schemas import NotificationPreferenceIn, NotificationPreferenceOut
from app.modules.users.models import User


def default_level(channel: Channel) -> str:
    return "all" if channel.is_dm else "mentions"


def to_out(
    channel_id: uuid.UUID, pref: NotificationPreference | None, default: str
) -> NotificationPreferenceOut:
    return NotificationPreferenceOut(
        channel_id=channel_id,
        level=pref.level if pref else default,  # type: ignore[arg-type]
        muted_until=pref.muted_until if pref else None,
    )


async def preferences_for(
    db: AsyncSession, user_id: uuid.UUID
) -> dict[uuid.UUID, NotificationPreference]:
    return await repo.preferences_for_user(db, user_id)


async def set_preference(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, data: NotificationPreferenceIn
) -> NotificationPreferenceOut:
    channel, _ = await channels.require_member(db, actor.id, channel_id)
    pref = await repo.get_preference(db, actor.id, channel_id)
    if pref is None:
        pref = NotificationPreference(user_id=actor.id, channel_id=channel_id, level=data.level)
        db.add(pref)
    pref.level = data.level
    pref.muted_until = data.muted_until
    await db.flush()
    out = to_out(channel_id, pref, default_level(channel))
    await write_outbox(
        db,
        event_type=NOTIFICATION_PREFERENCE_UPDATED,
        audience_type="user",
        audience_id=actor.id,
        channel_id=channel_id,
        payload=NotificationPreferenceUpdatedData(
            channel_id=str(channel_id),
            level=out.level,
            muted_until=out.muted_until.isoformat() if out.muted_until else None,
        ).model_dump(mode="json"),
    )
    await db.commit()
    return out
