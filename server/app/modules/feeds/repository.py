import uuid
from datetime import datetime

from sqlalchemy import exists, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.ai.models import AiAgent
from app.modules.channels.models import ChannelMember
from app.modules.feeds.models import ChannelFeed, ChannelFeedBot
from app.modules.messages.models import Message
from app.modules.recurring.models import RecurringPost
from app.modules.tasks.models import SystemBot
from app.modules.users.models import User
from app.modules.webhooks.models import Webhook


async def get(
    db: AsyncSession, feed_id: uuid.UUID, *, for_update: bool = False
) -> ChannelFeed | None:
    stmt = select(ChannelFeed).where(ChannelFeed.id == feed_id)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


async def list_for_channel(db: AsyncSession, channel_id: uuid.UUID) -> list[ChannelFeed]:
    stmt = (
        select(ChannelFeed)
        .where(ChannelFeed.channel_id == channel_id)
        .order_by(ChannelFeed.created_at.asc(), ChannelFeed.id.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def count_for_channel(db: AsyncSession, channel_id: uuid.UUID) -> int:
    stmt = select(func.count()).select_from(ChannelFeed).where(ChannelFeed.channel_id == channel_id)
    return int((await db.execute(stmt)).scalar_one())


async def count_for_owner(db: AsyncSession, owner_id: uuid.UUID) -> int:
    stmt = select(func.count()).select_from(ChannelFeed).where(ChannelFeed.owner_id == owner_id)
    return int((await db.execute(stmt)).scalar_one())


async def find_by_url(db: AsyncSession, channel_id: uuid.UUID, url: str) -> ChannelFeed | None:
    stmt = select(ChannelFeed).where(ChannelFeed.channel_id == channel_id, ChannelFeed.url == url)
    return (await db.execute(stmt)).scalar_one_or_none()


async def feed_bot_row(
    db: AsyncSession, channel_id: uuid.UUID, *, for_update: bool = False
) -> ChannelFeedBot | None:
    """The bot the channel's feeds post as (they share one), M98."""
    stmt = select(ChannelFeedBot).where(ChannelFeedBot.channel_id == channel_id)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


async def set_feeds_bot(db: AsyncSession, channel_id: uuid.UUID, bot_user_id: uuid.UUID) -> None:
    """Every feed of the channel posts as `bot_user_id` from now on."""
    await db.execute(
        update(ChannelFeed)
        .where(ChannelFeed.channel_id == channel_id)
        .values(bot_user_id=bot_user_id)
        .execution_options(synchronize_session="fetch")
    )


async def bot_candidates(db: AsyncSession, channel_id: uuid.UUID) -> list[User]:
    """M98: the bots an administrator may make the channel's feed bot: members of the channel or
    bots that posted in it (an import's bots are not members), that nothing else posts as (no
    webhook, AI agent, scheduled post, system bot or channel's feeds)."""
    in_channel = exists().where(
        ChannelMember.channel_id == channel_id, ChannelMember.user_id == User.id
    )
    posted = exists().where(Message.channel_id == channel_id, Message.sender_id == User.id)
    used = [
        AiAgent.bot_user_id,
        Webhook.bot_user_id,
        RecurringPost.bot_user_id,
        SystemBot.user_id,
        ChannelFeedBot.bot_user_id,
    ]
    stmt = select(User).where(User.role == "bot", in_channel | posted)
    for column in used:  # (no NULLs in the lists: NOT IN would then match nothing)
        stmt = stmt.where(User.id.not_in(select(column).where(column.is_not(None))))
    stmt = stmt.order_by(User.display_name.asc(), User.username.asc())
    return list((await db.execute(stmt)).scalars().all())


async def bot_in_use(db: AsyncSession, bot_user_id: uuid.UUID, *, besides: uuid.UUID) -> bool:
    stmt = (
        select(ChannelFeed.id)
        .where(ChannelFeed.bot_user_id == bot_user_id, ChannelFeed.id != besides)
        .limit(1)
    )
    return (await db.execute(stmt)).scalar_one_or_none() is not None


async def claim_due(db: AsyncSession, now: datetime, limit: int) -> list[ChannelFeed]:
    """Enabled feeds whose time has come, locked (another worker skips them)."""
    stmt = (
        select(ChannelFeed)
        .where(ChannelFeed.enabled.is_(True), ChannelFeed.next_fetch_at <= now)
        .order_by(ChannelFeed.next_fetch_at.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    return list((await db.execute(stmt)).scalars().all())
