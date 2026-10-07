"""The lab roster (M23, DATA_MODEL.md lab_profiles): who is faculty, which grade a student is in,
who supervises them and what they research.

Administrators put people on the roster; people edit their own research topic and reading. The
roster orders the member lists of all clients and keeps the managed groups (@b4, @m1, @m2, @d,
@faculty, @students, @alumni) in the groups module. It never grants anything: roles stay admin /
member / guest.
"""

import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, conflict, forbidden, not_found
from app.core.roles import has_capability
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.audit import service as audit
from app.modules.channels import service as channels
from app.modules.groups import service as groups
from app.modules.lab import repository as repo
from app.modules.lab.events import ROSTER_UPDATED, RosterUpdatedData
from app.modules.lab.models import LabProfile
from app.modules.lab.schemas import (
    LabProfileOut,
    LabProfilePut,
    MyLabProfileUpdate,
    to_profile_out,
)
from app.modules.users import service as users
from app.modules.users.models import User

# Roster order (the same on the three clients): faculty by rank, students from D3 down to B3, the
# others, then alumni. Unknown values go last within their step.
AFFILIATION_ORDER = ("faculty", "student", "other", "alumni")
RANK_ORDER = ("professor", "associate_professor", "lecturer", "assistant_professor")
GRADE_ORDER = ("D3", "D2", "D1", "M2", "M1", "B4", "B3")


@dataclass(frozen=True)
class ManagedGroup:
    key: str
    description: str
    includes: Callable[[LabProfile], bool]


MANAGED_GROUPS = (
    ManagedGroup("faculty", "教員 (名簿から自動)", lambda p: p.affiliation == "faculty"),
    ManagedGroup("students", "学生 (名簿から自動)", lambda p: p.affiliation == "student"),
    ManagedGroup("alumni", "卒業生 (名簿から自動)", lambda p: p.affiliation == "alumni"),
    ManagedGroup("b4", "B4 (名簿から自動)", lambda p: p.grade == "B4"),
    ManagedGroup("m1", "M1 (名簿から自動)", lambda p: p.grade == "M1"),
    ManagedGroup("m2", "M2 (名簿から自動)", lambda p: p.grade == "M2"),
    ManagedGroup("d", "博士課程 (名簿から自動)", lambda p: p.grade in ("D1", "D2", "D3")),
)


def _index(values: Sequence[str], value: str | None) -> int:
    return values.index(value) if value in values else len(values)


def roster_key(profile: LabProfileOut, user: User | None) -> tuple[int, int, str, str]:
    """Where a line sorts in the roster (DATA_MODEL.md lab_profiles 「名簿順」)."""
    step = (
        _index(RANK_ORDER, profile.rank)
        if profile.affiliation == "faculty"
        else _index(GRADE_ORDER, profile.grade)
        if profile.affiliation == "student"
        else 0
    )
    name = profile.reading or (user.display_name if user else "")
    return (
        _index(AFFILIATION_ORDER, profile.affiliation),
        step,
        name,
        user.username if user else "",
    )


async def roster(db: AsyncSession, visible: set[uuid.UUID] | None) -> list[LabProfileOut]:
    """Every line in roster order; for a guest (`visible` = the people it shares a channel with)
    only those people's (M13e)."""
    rows = [to_profile_out(r) for r in await repo.list_all(db)]
    if visible is not None:
        rows = [r for r in rows if r.user_id in visible]
    people = await users.get_users(db, [r.user_id for r in rows])
    return sorted(rows, key=lambda r: roster_key(r, people.get(r.user_id)))


async def _check_target(db: AsyncSession, actor: User, user_id: uuid.UUID) -> None:
    """M142 (docs/ROLES.md §4.2): a manager (roster.manage without users.manage) changes neither
    their own line (the managed groups would let them read what is shared with, say, @faculty)
    nor an administrator's."""
    if has_capability(actor, "users.manage"):
        return
    if user_id == actor.id:
        raise conflict("cannot_modify_self", "Ask an administrator to change your own line")
    target = await users.get_user(db, user_id)
    if target is not None and target.is_admin:
        raise forbidden("admin_required", "Only an administrator changes an administrator's line")


async def put(
    db: AsyncSession, actor: User, user_id: uuid.UUID, data: LabProfilePut
) -> LabProfileOut:
    """An administrator or a manager puts someone on the roster or changes their line."""
    await _check_target(db, actor, user_id)
    out = await put_in_tx(db, actor, user_id, data)
    await db.commit()
    return out


async def put_in_tx(
    db: AsyncSession, actor: User | None, user_id: uuid.UUID, data: LabProfilePut
) -> LabProfileOut:
    """The same without committing: also an invite's preset on acceptance (L7), where `actor` is
    the issuing admin."""
    await repo.lock_roster(db)
    await users.require_user(db, user_id)
    if data.supervisor_id is not None:
        await _require_supervisor(db, data.supervisor_id, user_id)
    row = await repo.get(db, user_id)
    if row is None:
        row = LabProfile(user_id=user_id)
        db.add(row)
    new_supervisor = data.supervisor_id is not None and data.supervisor_id != row.supervisor_id
    row.affiliation = data.affiliation
    row.rank = data.rank
    row.grade = data.grade
    row.supervisor_id = data.supervisor_id
    if new_supervisor and data.supervisor_id is not None:
        # M24: a supervisor follows their student's times (and one made later, supervisor_ids_for).
        await channels.follow_times_in_tx(db, user_id, data.supervisor_id)
    if "research_topic" in data.model_fields_set:
        row.research_topic = _clean(data.research_topic)
    if "reading" in data.model_fields_set:
        row.reading = _clean(data.reading)
    row.updated_at = utcnow()
    await db.flush()
    out = to_profile_out(row)
    await _changed(db, actor, user_id, out)
    await audit.record_in_tx(
        db,
        actor_id=actor.id if actor else None,
        action="admin.roster_updated",
        target_type="user",
        target_id=user_id,
        details=data.model_dump(exclude={"research_topic", "reading"}, mode="json"),
    )
    return out


async def update_mine(db: AsyncSession, actor: User, data: MyLabProfileUpdate) -> LabProfileOut:
    """People edit the research topic and reading of their own line (not their place in it)."""
    await repo.lock_roster(db)
    row = await repo.get(db, actor.id)
    if row is None:
        raise not_found("roster_entry_not_found", "You are not on the roster")
    if "research_topic" in data.model_fields_set:
        row.research_topic = _clean(data.research_topic)
    if "reading" in data.model_fields_set:
        row.reading = _clean(data.reading)
    row.updated_at = utcnow()
    await db.flush()
    out = to_profile_out(row)
    await _emit(db, actor.id, out)  # the groups do not depend on these fields
    await db.commit()
    return out


async def remove(db: AsyncSession, actor: User, user_id: uuid.UUID) -> None:
    """An administrator or a manager takes someone off the roster (the account stays)."""
    await _check_target(db, actor, user_id)
    await repo.lock_roster(db)
    if not await repo.remove(db, user_id):
        raise not_found("roster_entry_not_found", "Not on the roster")
    await _changed(db, actor, user_id, None)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="admin.roster_removed",
        target_type="user",
        target_id=user_id,
    )
    await db.commit()


async def supervisor_ids_for(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    """Who joins a new times of this person (M24, injected into channels by main.py)."""
    row = await repo.get(db, user_id)
    return [row.supervisor_id] if row is not None and row.supervisor_id is not None else []


async def forget_in_tx(db: AsyncSession, actor: User | None, user_id: uuid.UUID) -> None:
    """For the admin module: anonymizing a person drops their line too (research topic included)."""
    await repo.lock_roster(db)
    if await repo.remove(db, user_id):
        await _changed(db, actor, user_id, None)


async def check_supervisor(db: AsyncSession, supervisor_id: uuid.UUID) -> None:
    """For invites (L7): a preset's supervisor must be faculty on the roster."""
    row = await repo.get(db, supervisor_id)
    if row is None or row.affiliation != "faculty":
        raise AppError(422, "invalid_supervisor", "The supervisor must be faculty on the roster")


async def _require_supervisor(
    db: AsyncSession, supervisor_id: uuid.UUID, user_id: uuid.UUID
) -> None:
    row = await repo.get(db, supervisor_id)
    if supervisor_id == user_id or row is None or row.affiliation != "faculty":
        raise AppError(422, "invalid_supervisor", "The supervisor must be faculty on the roster")


def _clean(value: str | None) -> str | None:
    return (value or "").strip() or None


async def _changed(
    db: AsyncSession, actor: User | None, user_id: uuid.UUID, profile: LabProfileOut | None
) -> None:
    await _emit(db, user_id, profile)
    await sync_managed_groups(db, actor)


async def sync_managed_groups(db: AsyncSession, actor: User | None) -> None:
    """The managed groups from the whole roster (also once after a rollover, L7)."""
    rows = await repo.list_all(db)
    for group in MANAGED_GROUPS:
        members = [r.user_id for r in rows if group.includes(r)]
        await groups.sync_managed_in_tx(db, actor, group.key, group.description, members)


async def emit_line(db: AsyncSession, user_id: uuid.UUID, profile: LabProfileOut | None) -> None:
    """roster.updated for one person (L7's rollover changes many, then syncs the groups once)."""
    await _emit(db, user_id, profile)


async def _emit(db: AsyncSession, user_id: uuid.UUID, profile: LabProfileOut | None) -> None:
    await write_outbox(
        db,
        event_type=ROSTER_UPDATED,
        audience_type="all",
        payload=RosterUpdatedData(user_id=user_id, profile=profile).model_dump(mode="json"),
    )
