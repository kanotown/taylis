"""Bootstrap: everything a client needs after connecting (SYNC_PROTOCOL.md §4.1)."""

import uuid
from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments.service import MAX_ATTACHMENTS_PER_MESSAGE
from app.modules.bookmarks import service as bookmarks
from app.modules.channels import service as channels
from app.modules.drafts import service as drafts
from app.modules.emoji import service as emoji
from app.modules.favorites import service as favorites
from app.modules.groups import service as groups
from app.modules.messages.schemas import MAX_BODY_LENGTH
from app.modules.notifications import service as notifications
from app.modules.reads import service as reads
from app.modules.sidebar import service as sidebar
from app.modules.sync.schemas import BootstrapOut, Limits, PresenceEntry
from app.modules.threads import service as threads
from app.modules.users import service as users
from app.modules.users.models import User
from app.modules.users.schemas import to_user_me, to_user_public


async def _visible_users(db: AsyncSession, actor: User) -> list[User]:
    rows = await users.list_users(db)
    if not actor.is_guest:
        return rows
    visible = await channels.shared_member_ids(db, actor.id)  # M13e
    return [u for u in rows if u.id in visible]


async def bootstrap(
    db: AsyncSession,
    actor: User,
    settings: Settings,
    presence: Sequence[tuple[uuid.UUID, str]] = (),
) -> BootstrapOut:
    listed = await channels.list_channels(db, actor, include_public=False)
    prefs = await notifications.preferences_for(db, actor.id)
    read_states = await reads.states_for_user(db, actor.id, [c.id for c in listed])
    with_prefs = [
        c.model_copy(
            update={
                "notification": notifications.to_out(
                    c.id, prefs.get(c.id), "all" if c.type in ("dm", "group_dm") else "mentions"
                ),
                "read_state": read_states.get(c.id),
            }
        )
        for c in listed
    ]
    return BootstrapOut(
        server_time=utcnow(),
        me=to_user_me(actor),
        users=[to_user_public(u) for u in await _visible_users(db, actor)],
        channels=with_prefs,
        threads=await threads.summary_for(db, actor.id),
        bookmarks=await bookmarks.ids_for(db, actor.id),
        favorites=await favorites.ids_for(db, actor.id),
        custom_emoji=await emoji.list_all(db),
        groups=await groups.list_all(db),
        sidebar_sections=await sidebar.list_for(db, actor.id),
        drafts=await drafts.list_for(db, actor.id),
        presence=[
            PresenceEntry(user_id=user_id, status=status)  # type: ignore[arg-type]
            for user_id, status in presence
        ],
        limits=Limits(
            max_message_length=MAX_BODY_LENGTH,
            max_attachment_bytes=settings.attachment_max_bytes,
            max_attachments_per_message=MAX_ATTACHMENTS_PER_MESSAGE,
        ),
    )
