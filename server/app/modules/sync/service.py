"""Bootstrap: everything a client needs after connecting (SYNC_PROTOCOL.md §4.1)."""

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments.service import MAX_ATTACHMENTS_PER_MESSAGE
from app.modules.channels import service as channels
from app.modules.messages.schemas import MAX_BODY_LENGTH
from app.modules.notifications import service as notifications
from app.modules.reads import service as reads
from app.modules.sync.schemas import BootstrapOut, Limits
from app.modules.threads import service as threads
from app.modules.users import service as users
from app.modules.users.models import User
from app.modules.users.schemas import to_user_me, to_user_public


async def bootstrap(db: AsyncSession, actor: User, settings: Settings) -> BootstrapOut:
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
        users=[to_user_public(u) for u in await users.list_users(db)],
        channels=with_prefs,
        threads=await threads.summary_for(db, actor.id),
        limits=Limits(
            max_message_length=MAX_BODY_LENGTH,
            max_attachment_bytes=settings.attachment_max_bytes,
            max_attachments_per_message=MAX_ATTACHMENTS_PER_MESSAGE,
        ),
    )
