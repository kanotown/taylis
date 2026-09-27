"""User groups (M12k): `@name` in a message expands to every member of the group.

Administrators create groups and pick their members; every user sees the list (bootstrap
`groups`, `group.updated` with audience all) so that the composer can offer `@name` and bodies
can render `<@group:id>` as a name. The messages module asks `expand` for the members to add to
`mentioned_user_ids`, so unread mention counts and mentions-level pushes need no further logic.
"""

import uuid

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import conflict, not_found
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.audit import service as audit
from app.modules.groups import repository as repo
from app.modules.groups.events import GROUP_UPDATED, GroupUpdatedData
from app.modules.groups.models import UserGroup
from app.modules.groups.schemas import GroupCreate, GroupOut, GroupUpdate, to_group_out
from app.modules.users import service as users
from app.modules.users.models import User


async def list_visible(db: AsyncSession, visible: set[uuid.UUID] | None) -> list[GroupOut]:
    """For a guest (`visible` = the people it shares a channel with) member lists are trimmed
    to those people; the names stay so that `<@group:id>` in messages still reads."""
    groups = await list_all(db)
    if visible is None:
        return groups
    return [
        g.model_copy(update={"member_ids": [m for m in g.member_ids if m in visible]})
        for g in groups
    ]


async def list_all(db: AsyncSession) -> list[GroupOut]:
    rows = await repo.list_all(db)
    members = await repo.member_ids_for(db, [g.id for g in rows])
    return [to_group_out(g, members.get(g.id, [])) for g in rows]


async def get(db: AsyncSession, group_id: uuid.UUID) -> GroupOut:
    group = await repo.get(db, group_id)
    if group is None:
        raise not_found("group_not_found", "Group not found")
    return to_group_out(group, (await repo.member_ids_for(db, [group.id])).get(group.id, []))


async def name_in_use(db: AsyncSession, name: str) -> bool:
    """For the admin module: a new username must not shadow a group (`@name` would be ambiguous)."""
    return await repo.name_taken(db, name)


async def names_for(db: AsyncSession, group_ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    return {g.id: g.name for g in await repo.list_all(db) if g.id in set(group_ids)}


async def expand(db: AsyncSession, group_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    """The active members of the mentioned groups (messages adds them to mentioned_user_ids)."""
    return await repo.active_member_ids(db, group_ids)


async def _ensure_name_free(
    db: AsyncSession, name: str, *, except_id: uuid.UUID | None = None
) -> None:
    if await repo.name_taken(db, name, except_id=except_id):
        raise conflict("name_taken", "A group with that name already exists")
    if await users.get_by_username(db, name) is not None:
        raise conflict("name_taken", "A user has that name")


async def _valid_members(db: AsyncSession, ids: list[uuid.UUID]) -> list[uuid.UUID]:
    unique = list(dict.fromkeys(ids))
    found = await users.get_users(db, unique)
    if len(found) != len(unique):
        raise not_found("user_not_found", "User not found")
    return unique


async def _emit(
    db: AsyncSession, group: UserGroup, member_ids: list[uuid.UUID], *, deleted: bool
) -> GroupOut:
    out = to_group_out(group, member_ids)
    await write_outbox(
        db,
        event_type=GROUP_UPDATED,
        audience_type="all",
        payload=GroupUpdatedData(group=out, deleted=deleted).model_dump(mode="json"),
    )
    return out


async def create(db: AsyncSession, actor: User, data: GroupCreate) -> GroupOut:
    await _ensure_name_free(db, data.name)
    members = await _valid_members(db, data.member_ids)
    now = utcnow()
    group = UserGroup(
        name=data.name,
        description=(data.description or "").strip() or None,
        created_by=actor.id,
        created_at=now,
        updated_at=now,
    )
    db.add(group)
    try:
        await db.flush()
        await repo.set_members(db, group.id, members)
        out = await _emit(db, group, members, deleted=False)
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="admin.group_created",
            target_type="group",
            target_id=group.id,
            details={"name": group.name, "member_count": len(members)},
        )
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise conflict("name_taken", "A group with that name already exists") from exc
    return out


async def update(db: AsyncSession, actor: User, group_id: uuid.UUID, data: GroupUpdate) -> GroupOut:
    group = await repo.get(db, group_id, for_update=True)
    if group is None:
        raise not_found("group_not_found", "Group not found")
    if data.name is not None and data.name != group.name:
        await _ensure_name_free(db, data.name, except_id=group.id)
        group.name = data.name
    if "description" in data.model_fields_set:
        group.description = (data.description or "").strip() or None
    if data.member_ids is not None:
        await repo.set_members(db, group.id, await _valid_members(db, data.member_ids))
    group.updated_at = utcnow()
    await db.flush()
    members = (await repo.member_ids_for(db, [group.id])).get(group.id, [])
    out = await _emit(db, group, members, deleted=False)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="admin.group_updated",
        target_type="group",
        target_id=group.id,
        details=data.model_dump(exclude_none=True, mode="json"),
    )
    await db.commit()
    return out


async def delete(db: AsyncSession, actor: User, group_id: uuid.UUID) -> None:
    group = await repo.get(db, group_id, for_update=True)
    if group is None:
        raise not_found("group_not_found", "Group not found")
    members = (await repo.member_ids_for(db, [group.id])).get(group.id, [])
    await _emit(db, group, members, deleted=True)
    await repo.remove(db, group.id)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="admin.group_deleted",
        target_type="group",
        target_id=group.id,
        details={"name": group.name},
    )
    await db.commit()
