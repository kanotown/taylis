"""The yearly rollover (L7, LAB.md I): at the end of March an administrator moves each student up a
grade, keeps them where they are, or lets them graduate, in one transaction.

A graduate becomes alumni on the roster (the managed groups follow), their times is archived
(read-only, still searchable), they may become a guest, and they leave every public and private
channel except the ones kept for them and the channels every graduate stays in (the OB/OG and the
all-hands ones), which they join. Leaving matters: a
guest sees what they belong to, so changing the role alone would keep the lab's channels in view.
DMs stay. What each person was before is kept, so a rollover can be undone; the same year cannot
be applied twice while it is in force.
"""

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, conflict, not_found
from app.core.time import utcnow
from app.modules.audit import service as audit
from app.modules.channels import service as channels
from app.modules.lab import repository as repo
from app.modules.lab import service as lab
from app.modules.lab.models import LabProfile, LabRollover
from app.modules.lab.schemas import (
    RolloverApply,
    RolloverChannelOut,
    RolloverOut,
    RolloverPreviewItem,
    RolloverPreviewOut,
    to_profile_out,
)
from app.modules.users import service as users
from app.modules.users.models import User

NEXT_GRADE = {"B3": "B4", "B4": "M1", "M1": "M2", "M2": "D1", "D1": "D2", "D2": "D3"}
# The proposal per grade (LAB.md I): most move up; a master's second year and a third-year doctor
# finish. B4 → M1 or graduation is the admin's call per person; moving up is proposed.
DEFAULT_ACTION = {
    "B3": "advance",
    "B4": "advance",
    "M1": "advance",
    "M2": "graduate",
    "D1": "advance",
    "D2": "advance",
    "D3": "graduate",
}


def _counts(before: dict[str, Any]) -> dict[str, int]:
    items = before.get("items", [])
    return {
        action: sum(1 for i in items if i["action"] == action)
        for action in ("advance", "stay", "graduate")
    }


def to_out(row: LabRollover) -> RolloverOut:
    counts = _counts(row.before)
    return RolloverOut(
        academic_year=row.academic_year,
        applied_by=row.applied_by,
        applied_at=row.applied_at,
        undone_at=row.undone_at,
        advanced=counts["advance"],
        stayed=counts["stay"],
        graduated=counts["graduate"],
    )


async def preview(db: AsyncSession, academic_year: int) -> RolloverPreviewOut:
    rollover = await repo.get_rollover(db, academic_year)
    items: list[RolloverPreviewItem] = []
    for row in await repo.list_all(db):
        if row.affiliation != "student":
            continue
        times = await channels.times_of(db, row.user_id)
        conversations = await channels.conversations_of(db, row.user_id)
        items.append(
            RolloverPreviewItem(
                user_id=row.user_id,
                grade=row.grade,  # type: ignore[arg-type]
                action=DEFAULT_ACTION.get(row.grade or "", "stay"),  # type: ignore[arg-type]
                next_grade=NEXT_GRADE.get(row.grade or ""),  # type: ignore[arg-type]
                times_channel_id=times.id if times else None,
                channels=[
                    RolloverChannelOut(id=c.id, name=c.name, type=c.type)
                    for c, _ in conversations
                    if c.times_owner_id != row.user_id
                ],
            )
        )
    items.sort(key=lambda i: lab.GRADE_ORDER.index(i.grade) if i.grade in lab.GRADE_ORDER else 99)
    return RolloverPreviewOut(
        academic_year=academic_year,
        applied_at=rollover.applied_at if rollover and rollover.undone_at is None else None,
        items=items,
    )


def _line(row: LabProfile) -> dict[str, Any]:
    return {
        "affiliation": row.affiliation,
        "rank": row.rank,
        "grade": row.grade,
        "supervisor_id": str(row.supervisor_id) if row.supervisor_id else None,
    }


async def apply(
    db: AsyncSession, actor: User, data: RolloverApply
) -> tuple[RolloverOut, list[uuid.UUID]]:
    """Returns the rollover and the people whose role changed (their connections restart, so a new
    guest's view narrows at once)."""
    await repo.lock_roster(db)
    existing = await repo.get_rollover(db, data.academic_year)
    if existing is not None and existing.undone_at is None:
        raise conflict("rollover_applied", "This year's rollover has been applied already")
    if existing is not None:
        await db.delete(existing)  # undone: this one takes its place (the audit log keeps both)
        await db.flush()
    stay: list[Any] = []
    for channel_id in dict.fromkeys(
        ([data.alumni_channel_id] if data.alumni_channel_id else []) + data.stay_channel_ids
    ):
        channel = await channels.find_channel(db, channel_id)
        if channel is None or channel.is_dm or channel.is_archived:
            raise AppError(422, "invalid_alumni_channel", "Pick live public or private channels")
        stay.append(channel)
    if len({i.user_id for i in data.items}) != len(data.items):
        raise AppError(422, "rollover_duplicate", "Each person appears once")
    records: list[dict[str, Any]] = []
    role_changed: list[uuid.UUID] = []
    for item in data.items:
        row = await repo.get(db, item.user_id)
        if row is None or row.affiliation != "student":
            raise AppError(422, "rollover_not_student", "Only students on the roster roll over")
        record: dict[str, Any] = {
            "user_id": str(item.user_id),
            "action": item.action,
            "profile": _line(row),
            "role": None,
            "left": [],
            "joined": [],
            "archived_times": None,
        }
        if item.action == "advance":
            next_grade = NEXT_GRADE.get(row.grade or "")
            if next_grade is None:
                raise AppError(422, "rollover_cannot_advance", f"{row.grade} has no next grade")
            row.grade = next_grade
        elif item.action == "graduate":
            await _graduate(
                db, actor, item.user_id, row, item.guest, set(item.keep_channel_ids), stay, record
            )
            if record["role"] is not None:
                role_changed.append(item.user_id)
        row.updated_at = utcnow()
        records.append(record)
    await db.flush()
    await _announce(db, actor, [uuid.UUID(r["user_id"]) for r in records])
    before = {"stay_channel_ids": [str(c.id) for c in stay], "items": records}
    rollover = LabRollover(academic_year=data.academic_year, applied_by=actor.id, before=before)
    db.add(rollover)
    await db.flush()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="lab.rollover_applied",
        target_type="lab_rollover",
        target_id=str(data.academic_year),
        details={"academic_year": data.academic_year, **_counts(before)},
    )
    await db.commit()
    return to_out(rollover), role_changed


async def _graduate(
    db: AsyncSession,
    actor: User,
    user_id: uuid.UUID,
    row: LabProfile,
    guest: bool,
    keep: set[uuid.UUID],
    stay: list[Any],
    record: dict[str, Any],
) -> None:
    row.affiliation = "alumni"
    row.grade = None
    row.rank = None
    times = await channels.times_of(db, user_id)
    if times is not None and await channels.set_archived_in_tx(db, times, True):
        record["archived_times"] = str(times.id)
    for channel, role in await channels.conversations_of(db, user_id):
        if channel.id in keep or any(channel.id == c.id for c in stay):
            continue
        if channel.times_owner_id == user_id:
            continue  # their own times stays theirs, archived
        if await channels.remove_member_in_tx(db, channel, user_id):
            record["left"].append({"channel_id": str(channel.id), "role": role})
    for channel in stay:
        if await channels.add_member_in_tx(db, channel, user_id):
            record["joined"].append(str(channel.id))
    if guest:
        user = await users.require_user(db, user_id)
        if user.id == actor.id:
            raise conflict("cannot_modify_self", "Administrators cannot change their own account")
        if user.role != "guest":
            record["role"] = user.role
            await users.set_role_in_tx(db, user, "guest")


async def _announce(db: AsyncSession, actor: User, user_ids: list[uuid.UUID]) -> None:
    for user_id in user_ids:
        row = await repo.get(db, user_id)
        await lab.emit_line(db, user_id, to_profile_out(row) if row else None)
    await lab.sync_managed_groups(db, actor)


async def list_rollovers(db: AsyncSession) -> list[RolloverOut]:
    return [to_out(r) for r in await repo.list_rollovers(db)]


async def undo(
    db: AsyncSession, actor: User, academic_year: int
) -> tuple[RolloverOut, list[uuid.UUID]]:
    """Put everyone back as they were before this year's rollover (grades, alumni, roles, the
    channels left or joined, the archived times)."""
    await repo.lock_roster(db)
    rollover = await repo.get_rollover(db, academic_year)
    if rollover is None:
        raise not_found("rollover_not_found", "No rollover for this year")
    if rollover.undone_at is not None:
        raise conflict("rollover_undone", "This rollover has been undone already")
    role_changed: list[uuid.UUID] = []
    touched: list[uuid.UUID] = []
    for record in reversed(rollover.before.get("items", [])):
        user_id = uuid.UUID(record["user_id"])
        user = await users.get_user(db, user_id)
        if user is None:
            continue  # anonymised or gone since
        row = await repo.get(db, user_id)
        if row is None:
            row = LabProfile(user_id=user_id)
            db.add(row)
        line = record["profile"]
        row.affiliation = line["affiliation"]
        row.rank = line["rank"]
        row.grade = line["grade"]
        row.supervisor_id = uuid.UUID(line["supervisor_id"]) if line["supervisor_id"] else None
        row.updated_at = utcnow()
        touched.append(user_id)
        if record["role"] is not None and user.role != record["role"]:
            await users.set_role_in_tx(db, user, record["role"])
            role_changed.append(user_id)
        for joined in record["joined"]:
            channel = await channels.find_channel(db, uuid.UUID(joined))
            if channel is not None:
                await channels.remove_member_in_tx(db, channel, user_id)
        for left in record["left"]:
            channel = await channels.find_channel(db, uuid.UUID(left["channel_id"]))
            if channel is None or channel.is_dm:
                continue
            await channels.add_member_in_tx(db, channel, user_id)
            if left["role"] == "owner":
                await channels.set_member_role_in_tx(db, channel, user_id, "owner")
        if record["archived_times"]:
            times = await channels.find_channel(db, uuid.UUID(record["archived_times"]))
            if times is not None:
                await channels.set_archived_in_tx(db, times, False)
    await db.flush()
    await _announce(db, actor, touched)
    rollover.undone_at = utcnow()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="lab.rollover_undone",
        target_type="lab_rollover",
        target_id=str(academic_year),
        details={"academic_year": academic_year},
    )
    await db.commit()
    return to_out(rollover), role_changed
