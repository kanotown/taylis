import uuid

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.groups.models import UserGroup, UserGroupMember
from app.modules.users.models import User  # read-only (ARCHITECTURE.md §5 exception)


async def get(
    db: AsyncSession, group_id: uuid.UUID, *, for_update: bool = False
) -> UserGroup | None:
    stmt = select(UserGroup).where(UserGroup.id == group_id)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_managed(db: AsyncSession, key: str) -> UserGroup | None:
    stmt = select(UserGroup).where(UserGroup.managed_key == key).with_for_update()
    return (await db.execute(stmt.execution_options(populate_existing=True))).scalar_one_or_none()


async def get_by_name(db: AsyncSession, name: str) -> UserGroup | None:
    stmt = select(UserGroup).where(UserGroup.name == name).with_for_update()
    return (await db.execute(stmt.execution_options(populate_existing=True))).scalar_one_or_none()


async def list_all(db: AsyncSession) -> list[UserGroup]:
    return list((await db.execute(select(UserGroup).order_by(UserGroup.name))).scalars().all())


async def name_taken(db: AsyncSession, name: str, *, except_id: uuid.UUID | None = None) -> bool:
    stmt = select(UserGroup.id).where(UserGroup.name == name)
    if except_id is not None:
        stmt = stmt.where(UserGroup.id != except_id)
    return (await db.scalar(stmt)) is not None


async def member_ids_for(
    db: AsyncSession, group_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[uuid.UUID]]:
    result: dict[uuid.UUID, list[uuid.UUID]] = {gid: [] for gid in group_ids}
    if not group_ids:
        return result
    stmt = (
        select(UserGroupMember.group_id, UserGroupMember.user_id)
        .where(UserGroupMember.group_id.in_(group_ids))
        .order_by(UserGroupMember.added_at, UserGroupMember.user_id)
    )
    for group_id, user_id in (await db.execute(stmt)).all():
        result.setdefault(group_id, []).append(user_id)
    return result


async def active_member_ids(db: AsyncSession, group_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    """Members of the given groups that can still be notified (not deactivated), deduplicated."""
    if not group_ids:
        return []
    stmt = (
        select(UserGroupMember.user_id)
        .join(User, User.id == UserGroupMember.user_id)
        .where(UserGroupMember.group_id.in_(group_ids), User.deactivated_at.is_(None))
        .distinct()
    )
    return list((await db.execute(stmt)).scalars().all())


async def set_members(db: AsyncSession, group_id: uuid.UUID, user_ids: list[uuid.UUID]) -> None:
    await db.execute(delete(UserGroupMember).where(UserGroupMember.group_id == group_id))
    for user_id in dict.fromkeys(user_ids):
        db.add(UserGroupMember(group_id=group_id, user_id=user_id))
    await db.flush()


async def remove(db: AsyncSession, group_id: uuid.UUID) -> None:
    await db.execute(delete(UserGroupMember).where(UserGroupMember.group_id == group_id))
    await db.execute(delete(UserGroup).where(UserGroup.id == group_id))
