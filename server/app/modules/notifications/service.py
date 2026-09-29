"""Notification preferences (per user and channel)."""

import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.events.outbox import write_outbox
from app.modules.channels import service as channels
from app.modules.notifications import repository as repo
from app.modules.notifications.events import (
    NOTIFICATION_PREFERENCE_UPDATED,
    NotificationPreferenceUpdatedData,
)
from app.modules.notifications.models import NotificationPreference
from app.modules.notifications.schemas import NotificationPreferenceIn, NotificationPreferenceOut
from app.modules.users.models import User


def push_level(own: str | None, *, is_dm: bool, others_times: bool, overall: str) -> str:
    """PUSH_NOTIFICATIONS.md §4 (M35): what a conversation notifies me of. Its own level if it has
    one; else nothing when my overall setting is "none", every message of a DM, mentions in someone
    else's times (M24: work logs stay quiet), and my overall setting in any other channel."""
    if own is not None:
        return own
    if overall == "none":
        return "none"
    if is_dm:
        return "all"
    if others_times:
        return "mentions"
    return overall


def is_muted(pref: NotificationPreference | None, now: datetime) -> bool:
    """Muted until unmuted, or a timed mute still running (M35)."""
    if pref is None:
        return False
    return pref.muted or (pref.muted_until is not None and pref.muted_until > now)


def to_out(
    channel_id: uuid.UUID,
    pref: NotificationPreference | None,
    *,
    is_dm: bool,
    others_times: bool,
    overall: str,
) -> NotificationPreferenceOut:
    own = pref.level if pref else None
    return NotificationPreferenceOut(
        channel_id=channel_id,
        level=push_level(own, is_dm=is_dm, others_times=others_times, overall=overall),  # type: ignore[arg-type]
        muted_until=pref.muted_until if pref else None,
        follows_default=own is None,
        muted=pref.muted if pref else False,
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
    if data.muted is not None:
        pref.muted = data.muted
    await db.flush()
    out = to_out(
        channel_id,
        pref,
        is_dm=channel.is_dm,
        others_times=channel.times_owner_id is not None and channel.times_owner_id != actor.id,
        overall=actor.notification_default,
    )
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
            follows_default=out.follows_default,
            muted=out.muted,
        ).model_dump(mode="json"),
    )
    await db.commit()
    return out
