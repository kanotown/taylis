"""Copies of files and folders (docs/DRIVE.md §10.3, phase D3).

A copy reads the source and writes in the target folder (any location the actor can write; the
sources need only be readable). Only the current version of each file is copied, as version 1 of
the new file (`source = 'copy'`); its object, thumbnail and ready preview are copied inside the
store (S3 CopyObject: a posix store duplicates the bytes, so the target's quota counts them).

Within the request only (§10.3): at most DRIVE_COPY_MAX_ITEMS items and DRIVE_COPY_MAX_BYTES bytes
per request, else 413 drive_copy_too_large for the whole request (a background job is for later,
if larger copies are wanted).

The order: the snapshot and the checks, a first look at the quota (with the uploads under way
reserved), the objects copied outside any transaction, then one transaction: the target folder
locked, then its location, and each requested item placed in a savepoint (its name settled as
`fail` or `rename`, the depth, the folder's room and the quota checked again). An item that cannot
be placed gets an error in `results` and its copied objects are removed after the commit.

The same request again (`client_op_id`) answers the copies it made: each copy's top item keeps an
op id derived from the request's and the source's ids.
"""

import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, conflict
from app.core.ids import uuid7
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments.blobstore import BlobStore
from app.modules.drive import access as acl
from app.modules.drive import events, names, service, tree
from app.modules.drive import repository as repo
from app.modules.drive.access import item_not_found
from app.modules.drive.models import DriveItem
from app.modules.drive.schemas import DriveCopyIn, DriveCopyResult, DriveCopyResultsOut
from app.modules.drive.versions import ClonedObject, clone_object, drop_objects, version_for
from app.modules.users.models import User

_OP_NAMESPACE = uuid.UUID("5d0e3c43-2f7e-4c8e-9f55-6d72697665d3")


def copy_too_large(settings: Settings) -> AppError:
    return AppError(
        413,
        "drive_copy_too_large",
        f"A copy holds at most {settings.drive_copy_max_items} items and "
        f"{settings.drive_copy_max_bytes} bytes",
        details={
            "limit_bytes": settings.drive_copy_max_bytes,
            "limit_items": settings.drive_copy_max_items,
        },
    )


def op_id(client_op_id: uuid.UUID, source_id: uuid.UUID) -> uuid.UUID:
    return uuid.uuid5(_OP_NAMESPACE, f"{client_op_id}:{source_id}")


@dataclass
class _Plan:
    source_id: uuid.UUID
    root: tree.Node
    op_id: uuid.UUID | None
    clones: dict[uuid.UUID, ClonedObject] = field(default_factory=dict)
    error: str | None = None
    new_id: uuid.UUID | None = None
    # The same request, faster, made this copy meanwhile: ours is dropped.
    reused: bool = False

    @property
    def keys(self) -> list[str]:
        return [key for clone in self.clones.values() for key in clone.keys]


async def copy(
    db: AsyncSession, actor: User, settings: Settings, blobs: BlobStore, data: DriveCopyIn
) -> tuple[DriveCopyResultsOut, bool]:
    """(the results, one per requested item in order; whether any file was copied: the caller
    wakes the media and preview loops then)."""
    target, rights = await service.readable_item(db, actor, data.target_folder_id)
    rights.require_write()
    if target.kind != "folder":
        raise item_not_found()
    target_id, location_id, actor_id = target.id, target.location_id, actor.id
    chain = set(await repo.ancestor_ids(db, target.id))
    wanted = list(dict.fromkeys(data.item_ids))
    results: dict[uuid.UUID, DriveCopyResult] = {}
    plans: list[_Plan] = []
    items_total = bytes_total = 0
    for source_id in wanted:
        try:
            item, _ = await service.readable_item(db, actor, source_id)
            if item.parent_id is None:
                raise service.root_immutable()
            if item.id in chain:
                raise conflict("drive_cycle", "A folder cannot be copied into itself")
            derived = op_id(data.client_op_id, item.id) if data.client_op_id else None
            if derived is not None:
                done = await _made_before(db, actor_id, derived)
                if done is not None:
                    results[source_id] = DriveCopyResult(id=source_id, ok=True, new_id=done)
                    continue
            try:
                root = await tree.snapshot(db, item, cap=settings.drive_copy_max_items)
            except tree.TooLarge:
                raise copy_too_large(settings) from None
        except AppError as exc:
            if exc.code == "drive_copy_too_large":
                raise
            results[source_id] = DriveCopyResult(id=source_id, ok=False, error=exc.code)
            continue
        nodes = root.walk()
        items_total += len(nodes)
        bytes_total += root.size
        too_many = items_total > settings.drive_copy_max_items
        if too_many or bytes_total > settings.drive_copy_max_bytes:
            raise copy_too_large(settings)
        plans.append(_Plan(source_id=source_id, root=root, op_id=derived))
    if not plans:
        await db.commit()
        return DriveCopyResultsOut(results=[results[i] for i in wanted]), False

    # A first look at the quota before copying any byte (checked again when placing).
    location = await service.lock_location(db, location_id)
    await service.check_quota_in_tx(db, settings, location, bytes_total, with_reservations=True)
    await db.commit()

    for plan in plans:
        try:
            for node in plan.root.walk():
                if node.item.kind != "file":
                    continue
                if node.attachment is None or node.version is None:
                    raise item_not_found()
                plan.clones[node.item.id] = await clone_object(
                    blobs,
                    settings,
                    node.attachment,
                    sha256=node.version.sha256,
                    processed=node.version.processed_at is not None,
                    uploader_id=actor_id,
                    filename=node.item.name,
                )
        except Exception:
            plan.error = "drive_item_not_found"
            await drop_objects(blobs, plan.keys)
            plan.clones.clear()

    try:
        copied = await _place(db, settings, actor_id, target_id, data.on_conflict, plans)
    except BaseException:
        await db.rollback()
        for plan in plans:
            await drop_objects(blobs, plan.keys)
        raise
    for plan in plans:
        if plan.reused:
            await drop_objects(blobs, plan.keys)
        if plan.error is not None:
            await drop_objects(blobs, plan.keys)
            results[plan.source_id] = DriveCopyResult(id=plan.source_id, ok=False, error=plan.error)
        else:
            results[plan.source_id] = DriveCopyResult(
                id=plan.source_id, ok=True, new_id=plan.new_id
            )
    return DriveCopyResultsOut(results=[results[i] for i in wanted]), copied


async def _made_before(
    db: AsyncSession, actor_id: uuid.UUID, derived: uuid.UUID
) -> uuid.UUID | None:
    stmt = select(DriveItem.id).where(
        DriveItem.created_by == actor_id, DriveItem.client_op_id == derived
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def _place(
    db: AsyncSession,
    settings: Settings,
    actor_id: uuid.UUID,
    target_id: uuid.UUID,
    on_conflict: str,
    plans: list[_Plan],
) -> bool:
    """One transaction: whether any file was placed."""
    actor = await db.get(User, actor_id)
    target = (await repo.lock_items(db, [target_id])).get(target_id)
    if actor is None or target is None or target.trashed_at is not None:
        raise item_not_found()
    location = await repo.location(db, target.location_id)
    if location is None:
        raise item_not_found()
    (await acl.access(db, actor, location)).require_write()
    locked = await service.lock_location(db, location.id)
    depth = await service.depth_of(db, target.id)
    copied = False
    placed = 0
    for plan in plans:
        if plan.error is not None:
            continue
        try:
            async with db.begin_nested():
                root = plan.root
                name = root.item.name
                existing = await repo.child_by_key(db, target.id, names.key(name))
                if existing is not None:
                    if on_conflict != "rename":
                        raise service.name_taken(existing)
                    name = await service.free_name(
                        db, target.id, name, is_file=root.item.kind == "file"
                    )
                if depth + 1 + root.height > names.MAX_DEPTH:
                    raise service.depth_exceeded()
                await service.require_room(db, target.id)
                size = root.size
                await service.check_quota_in_tx(db, settings, locked, size, with_reservations=False)
                plan.new_id = await _write_tree(db, actor_id, target, root, name, plan)
                nodes = root.walk()
                locked.used_bytes += size
                locked.item_count += len(nodes)
                locked.updated_at = utcnow()
                await db.flush()
            placed += 1
            copied = copied or bool(plan.clones)
        except AppError as exc:
            plan.error = exc.code
            plan.new_id = None
        except IntegrityError:
            # The same client_op_id placed by a request that was faster.
            found = await _made_before(db, actor_id, plan.op_id) if plan.op_id else None
            if found is None:
                raise
            plan.new_id, plan.reused = found, True
    if placed:
        await events.emit_changed(db, location.id, [target.id])
    await db.commit()
    return copied


async def _write_tree(
    db: AsyncSession,
    actor_id: uuid.UUID,
    target: DriveItem,
    root: tree.Node,
    root_name: str,
    plan: _Plan,
) -> uuid.UUID:
    """The rows of the copy: folders and files (parents first), each file with its attachment
    and version 1. Returns the new top item's id."""
    now = utcnow()
    new_ids: dict[uuid.UUID, uuid.UUID] = {}
    for node in root.walk():
        source = node.item
        new_id = uuid7()
        new_ids[source.id] = new_id
        parent_id = target.id if source.id == root.item.id else new_ids[source.parent_id]  # type: ignore[index]
        name = root_name if source.id == root.item.id else source.name
        clone = plan.clones.get(source.id)
        row = DriveItem(
            id=new_id,
            location_id=target.location_id,
            parent_id=parent_id,
            kind=source.kind,
            content_modified_at=source.content_modified_at,
            created_by=actor_id,
            created_at=now,
            updated_by=actor_id,
            updated_at=now,
            change_seq=await events.next_seq(db),
            client_op_id=plan.op_id if source.id == root.item.id else None,
        )
        service.set_name(row, name)
        if clone is not None:
            version_id = uuid7()
            row.current_version_id = version_id
            row.size_bytes = clone.attachment.size_bytes
            row.content_type = clone.attachment.content_type
            row.taken_at = clone.attachment.taken_at
        db.add(row)
        await db.flush()
        if clone is not None:
            attachment = clone.attachment
            attachment.drive_item_id = new_id
            attachment.filename = name
            db.add(attachment)
            await db.flush()
            db.add(
                version_for(
                    clone,
                    new_id,
                    1,
                    source="copy",
                    uploaded_by=actor_id,
                    content_modified_at=node.version.content_modified_at if node.version else None,
                    version_id=version_id,
                )
            )
            await db.flush()
    return new_ids[root.item.id]
