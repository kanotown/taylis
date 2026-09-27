import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.channels.models import Channel, ChannelMember
from app.modules.users.models import User  # read-only (ARCHITECTURE.md §5)


async def get_channel(db: AsyncSession, channel_id: uuid.UUID) -> Channel | None:
    return await db.get(Channel, channel_id)


async def get_channel_by_name(db: AsyncSession, name: str) -> Channel | None:
    result = await db.execute(select(Channel).where(Channel.name == name))
    return result.scalar_one_or_none()


async def get_by_dm_key(db: AsyncSession, dm_key: str) -> Channel | None:
    result = await db.execute(select(Channel).where(Channel.dm_key == dm_key))
    return result.scalar_one_or_none()


async def get_membership(
    db: AsyncSession, channel_id: uuid.UUID, user_id: uuid.UUID
) -> ChannelMember | None:
    return await db.get(ChannelMember, (channel_id, user_id))


async def list_user_channels(
    db: AsyncSession, user_id: uuid.UUID
) -> list[tuple[Channel, ChannelMember]]:
    stmt = (
        select(Channel, ChannelMember)
        .join(ChannelMember, ChannelMember.channel_id == Channel.id)
        .where(ChannelMember.user_id == user_id)
        .order_by(Channel.type, Channel.name, Channel.created_at)
    )
    return [(row[0], row[1]) for row in (await db.execute(stmt)).all()]


async def member_counts_for_channels(
    db: AsyncSession, channel_ids: list[uuid.UUID]
) -> dict[uuid.UUID, int]:
    if not channel_ids:
        return {}
    stmt = (
        select(ChannelMember.channel_id, func.count())
        .where(ChannelMember.channel_id.in_(channel_ids))
        .group_by(ChannelMember.channel_id)
    )
    return {row[0]: int(row[1]) for row in (await db.execute(stmt)).all()}


async def list_public_channels_not_member(db: AsyncSession, user_id: uuid.UUID) -> list[Channel]:
    member_of = select(ChannelMember.channel_id).where(ChannelMember.user_id == user_id)
    stmt = (
        select(Channel)
        .where(
            Channel.type == "public",
            Channel.archived_at.is_(None),
            Channel.id.not_in(member_of),
        )
        .order_by(Channel.name)
    )
    return list((await db.execute(stmt)).scalars().all())


async def list_members(db: AsyncSession, channel_id: uuid.UUID) -> list[ChannelMember]:
    stmt = (
        select(ChannelMember)
        .where(ChannelMember.channel_id == channel_id)
        .order_by(ChannelMember.joined_at)
    )
    return list((await db.execute(stmt)).scalars().all())


async def member_ids_for_channels(
    db: AsyncSession, channel_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[uuid.UUID]]:
    if not channel_ids:
        return {}
    stmt = select(ChannelMember.channel_id, ChannelMember.user_id).where(
        ChannelMember.channel_id.in_(channel_ids)
    )
    out: dict[uuid.UUID, list[uuid.UUID]] = {}
    for channel_id, user_id in (await db.execute(stmt)).all():
        out.setdefault(channel_id, []).append(user_id)
    for ids in out.values():
        ids.sort()
    return out


async def non_guest_user_ids(db: AsyncSession) -> list[uuid.UUID]:
    """Read-only users access (ARCHITECTURE.md §5): the audience of a public channel's creation."""
    stmt = select(User.id).where(User.role != "guest", User.deactivated_at.is_(None))
    return list((await db.execute(stmt)).scalars().all())
