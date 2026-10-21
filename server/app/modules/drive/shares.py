"""External share links, the signed-in side (docs/DRIVE.md §5.4, §9, phase D4, M163).

A link names one item (a file, or a folder and everything under it). Its token is 32 random
bytes (base64url, 43 characters) shown once, in the answer that made it; only its SHA-256 is kept.
Whether a link works is decided on every request (`link_state`, §9.2):

    the workspace's switch AND the location's
    AND not revoked AND not expired AND (no limit OR downloads < limit)
    AND the item is not in the trash and still in the location the link was made in
    AND its creator is an active person (not a guest, not a bot) who can read the item now
    AND (a channel's drive) the channel is not archived

Anything but `active` is refused by the public side without saying why (410). The public side is
app.modules.drive.public.
"""

import hashlib
import ipaddress
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, forbidden, not_found
from app.core.roles import has_capability
from app.core.security import hash_password
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.audit import service as audit
from app.modules.drive import access as acl
from app.modules.drive import events
from app.modules.drive import repository as repo
from app.modules.drive.access import Access
from app.modules.drive.models import DriveItem, DriveLocation, DriveShareEvent, DriveShareLink
from app.modules.drive.schemas import (
    DriveItemLinksOut,
    DriveLinkPolicyOut,
    DriveShareEventListOut,
    DriveShareEventOut,
    DriveShareLinkCreate,
    DriveShareLinkCreatedOut,
    DriveShareLinkListOut,
    DriveShareLinkOut,
    DriveShareLinkPatch,
    DriveShareSettingsOut,
    DriveShareSettingsPatch,
    ShareLinkState,
)
from app.modules.users.models import User
from app.modules.workspace.models import WorkspaceSettings

TOKEN_BYTES = 32
# A client's clock may run a little ahead of ours: an expiry this much past the longest allowed
# is still accepted (the dialog's 「90 日」 is now + 90 days on the client).
EXPIRY_SLACK = timedelta(hours=1)
PAGE = 100


def token_hash(token: str) -> bytes:
    return hashlib.sha256(token.encode("ascii", "replace")).digest()


def links_disabled() -> AppError:
    return forbidden("drive_links_disabled", "External links are turned off here")


def link_not_found() -> AppError:
    return not_found("share_link_not_found", "Share link not found")


def link_unavailable() -> AppError:
    return AppError(410, "share_link_unavailable", "This link no longer works")


# --- the workspace's switches -------------------------------------------------------------------


@dataclass(frozen=True)
class Policy:
    enabled: bool = True
    max_days: int | None = 90
    password_required: bool = False


async def policy(db: AsyncSession) -> Policy:
    row = (await db.execute(select(WorkspaceSettings))).scalar_one_or_none()
    if row is None:
        return Policy()
    return Policy(
        enabled=row.drive_external_links_enabled,
        max_days=row.drive_link_max_days,
        password_required=row.drive_link_password_required,
    )


def settings_out(found: Policy, settings: Settings) -> DriveShareSettingsOut:
    return DriveShareSettingsOut(
        external_links_enabled=found.enabled,
        link_max_days=found.max_days,
        link_password_required=found.password_required,
        default_days=default_days(found, settings),
    )


def default_days(found: Policy, settings: Settings) -> int:
    days = settings.drive_share_default_days
    return min(days, found.max_days) if found.max_days is not None else days


async def update_settings(
    db: AsyncSession, actor: User, settings: Settings, data: DriveShareSettingsPatch
) -> DriveShareSettingsOut:
    """PATCH /admin/drive/settings, audited as workspace.settings_updated (before / after). Turning
    the switch off stops every link at once (none is removed: they work again when it is on)."""
    await db.execute(
        insert(WorkspaceSettings)
        .values(singleton=True)
        .on_conflict_do_nothing(index_elements=["singleton"])
    )
    row = (await db.execute(select(WorkspaceSettings).with_for_update())).scalar_one()
    wanted: dict[str, Any] = {}
    sent = data.model_fields_set
    if "external_links_enabled" in sent and data.external_links_enabled is not None:
        wanted["drive_external_links_enabled"] = data.external_links_enabled
    if "link_max_days" in sent:
        wanted["drive_link_max_days"] = data.link_max_days
    if "link_password_required" in sent and data.link_password_required is not None:
        wanted["drive_link_password_required"] = data.link_password_required
    changes = {
        column: {"from": getattr(row, column), "to": value}
        for column, value in wanted.items()
        if getattr(row, column) != value
    }
    if changes:
        for column, change in changes.items():
            setattr(row, column, change["to"])
        row.updated_at = utcnow()
        row.updated_by = actor.id
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="workspace.settings_updated",
            target_type="workspace",
            target_id=None,
            details=changes,
        )
    await db.commit()
    return settings_out(await policy(db), settings)


# --- who may do what ----------------------------------------------------------------------------


def may_share(found: Policy, location: DriveLocation, actor: User, rights: Access) -> bool:
    """Make a link here: both switches on, a person (not a guest or a bot) who can write."""
    return found.enabled and location.external_links and acl.is_person(actor) and rights.can_write


def may_manage_links(actor: User, rights: Access) -> bool:
    """See and revoke every link of the location (§3.2): its managers (channel owners, the owner
    of a My Drive, the administrators in 研究室ドライブ) and the administrators everywhere."""
    return rights.can_manage or has_capability(actor, "drive.admin")


async def can_share_location(db: AsyncSession, actor: User, location: DriveLocation) -> bool:
    rights = await acl.access(db, actor, location)
    return may_share(await policy(db), location, actor, rights)


# --- whether a link works (§9.2) ----------------------------------------------------------------


@dataclass
class Resolved:
    link: DriveShareLink
    state: ShareLinkState
    item: DriveItem | None
    location: DriveLocation | None


async def link_state(
    db: AsyncSession,
    link: DriveShareLink,
    *,
    found: Policy | None = None,
    now: datetime | None = None,
) -> Resolved:
    now = now or utcnow()
    item = await db.get(DriveItem, link.item_id)
    location = await db.get(DriveLocation, link.location_id)
    if link.revoked_at is not None:
        return Resolved(link, "revoked", item, location)
    if link.expires_at is not None and link.expires_at <= now:
        return Resolved(link, "expired", item, location)
    if link.max_downloads is not None and link.download_count >= link.max_downloads:
        return Resolved(link, "exhausted", item, location)
    found = found or await policy(db)
    if (
        item is None
        or location is None
        or item.trashed_at is not None
        or item.location_id != link.location_id
        or location.deleted_at is not None
        or not found.enabled
        or not location.external_links
    ):
        return Resolved(link, "paused", item, location)
    creator = await db.get(User, link.created_by)
    if creator is None or not acl.is_person(creator):
        return Resolved(link, "paused", item, location)
    rights = await acl.access(db, creator, location)
    if not rights.can_read or rights.archived:
        return Resolved(link, "paused", item, location)
    return Resolved(link, "active", item, location)


# --- what the signed-in side shows -------------------------------------------------------------


async def _names(db: AsyncSession, user_ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not user_ids:
        return {}
    rows = await db.execute(
        select(User.id, User.display_name, User.username).where(User.id.in_(list(user_ids)))
    )
    return {row[0]: row[1] or row[2] for row in rows.all()}


async def _location_label(db: AsyncSession, location: DriveLocation | None) -> str:
    if location is None:
        return ""
    if location.kind == "user" and location.user_id is not None:
        owner = await db.get(User, location.user_id)
        name = (owner.display_name or owner.username) if owner is not None else ""
        return f"{acl.MY_DRIVE_NAME}（{name}）" if name else acl.MY_DRIVE_NAME
    return await acl.location_name(db, location)


async def links_out(
    db: AsyncSession, actor: User, rows: list[DriveShareLink]
) -> list[DriveShareLinkOut]:
    found = await policy(db)
    now = utcnow()
    names = await _names(db, {row.created_by for row in rows})
    labels: dict[uuid.UUID, str] = {}
    manage: dict[uuid.UUID, bool] = {}
    out: list[DriveShareLinkOut] = []
    for row in rows:
        resolved = await link_state(db, row, found=found, now=now)
        location = resolved.location
        if row.location_id not in labels:
            labels[row.location_id] = await _location_label(db, location)
            manage[row.location_id] = location is not None and may_manage_links(
                actor, await acl.access(db, actor, location)
            )
        own = row.created_by == actor.id
        item = resolved.item
        out.append(
            DriveShareLinkOut(
                id=row.id,
                item_id=row.item_id,
                item_name=item.name if item is not None else "",
                item_kind=(item.kind if item is not None else "file"),  # type: ignore[arg-type]
                location_id=row.location_id,
                location_kind=(location.kind if location is not None else "workspace"),  # type: ignore[arg-type]
                location_name=labels[row.location_id],
                created_by=row.created_by,
                created_by_name=names.get(row.created_by, ""),
                created_at=row.created_at,
                expires_at=row.expires_at,
                has_password=row.password_hash is not None,
                max_downloads=row.max_downloads,
                download_count=row.download_count,
                note=row.note,
                last_used_at=row.last_used_at,
                state=resolved.state,
                can_edit=own and row.revoked_at is None,
                can_revoke=row.revoked_at is None
                and (own or manage[row.location_id] or has_capability(actor, "drive.admin")),
            )
        )
    return out


def policy_out(
    found: Policy, settings: Settings, location: DriveLocation, actor: User, rights: Access
) -> DriveLinkPolicyOut:
    return DriveLinkPolicyOut(
        enabled=found.enabled,
        location_enabled=location.external_links,
        can_share=may_share(found, location, actor, rights),
        max_days=found.max_days,
        default_days=default_days(found, settings),
        password_required=found.password_required,
    )


async def _readable(
    db: AsyncSession, actor: User, item_id: uuid.UUID
) -> tuple[DriveItem, DriveLocation, Access]:
    item = await repo.item(db, item_id)
    if item is None or item.trashed_at is not None:
        raise acl.item_not_found()
    location = await repo.location(db, item.location_id)
    if location is None:
        raise acl.item_not_found()
    rights = (await acl.access(db, actor, location)).require_read()
    return item, location, rights


async def item_links(
    db: AsyncSession, actor: User, settings: Settings, item_id: uuid.UUID
) -> DriveItemLinksOut:
    """The item's links that are not revoked: mine, or every one for those who manage the
    location's links."""
    item, location, rights = await _readable(db, actor, item_id)
    stmt = select(DriveShareLink).where(
        DriveShareLink.item_id == item.id, DriveShareLink.revoked_at.is_(None)
    )
    if not may_manage_links(actor, rights):
        stmt = stmt.where(DriveShareLink.created_by == actor.id)
    rows = list((await db.execute(stmt.order_by(DriveShareLink.created_at.desc()))).scalars())
    found = await policy(db)
    return DriveItemLinksOut(
        links=await links_out(db, actor, rows),
        policy=policy_out(found, settings, location, actor, rights),
    )


def _check_expiry(found: Policy, expires_at: datetime | None, now: datetime) -> None:
    if expires_at is None:
        if found.max_days is not None:
            raise AppError(
                422,
                "share_link_expiry_too_long",
                f"A link expires within {found.max_days} days",
                details={"max_days": found.max_days},
            )
        return
    if expires_at.tzinfo is None:
        raise AppError(422, "validation_error", "expires_at needs a time zone")
    if expires_at <= now:
        raise AppError(422, "validation_error", "expires_at is in the past")
    if (
        found.max_days is not None
        and expires_at > now + timedelta(days=found.max_days) + EXPIRY_SLACK
    ):
        raise AppError(
            422,
            "share_link_expiry_too_long",
            f"A link expires within {found.max_days} days",
            details={"max_days": found.max_days},
        )


def _password_required() -> AppError:
    return AppError(422, "share_link_password_required", "A password is required for links")


def public_path(token: str) -> str:
    return f"/s/{token}"


async def create_link(
    db: AsyncSession,
    actor: User,
    settings: Settings,
    item_id: uuid.UUID,
    data: DriveShareLinkCreate,
) -> DriveShareLinkCreatedOut:
    item, location, rights = await _readable(db, actor, item_id)
    if not acl.is_person(actor):
        raise forbidden("guest_restricted", "Guests cannot make external links")
    rights.require_write()
    found = await policy(db)
    if not found.enabled or not location.external_links:
        raise links_disabled()
    if item.parent_id is None:
        raise AppError(
            409, "drive_root_immutable", "A drive's top folder cannot be shared by a link"
        )
    now = utcnow()
    expires_at = (
        data.expires_at
        if "expires_at" in data.model_fields_set
        else now + timedelta(days=default_days(found, settings))
    )
    _check_expiry(found, expires_at, now)
    if found.password_required and not data.password:
        raise _password_required()
    token = secrets.token_urlsafe(TOKEN_BYTES)
    link = DriveShareLink(
        item_id=item.id,
        location_id=location.id,
        created_by=actor.id,
        token_hash=token_hash(token),
        password_hash=await hash_password(data.password) if data.password else None,
        expires_at=expires_at,
        max_downloads=data.max_downloads,
        note=(data.note or "").strip() or None,
    )
    db.add(link)
    await db.flush()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="drive.link_created",
        target_type="drive_share_link",
        target_id=link.id,
        details={
            "item_id": str(item.id),
            "item_kind": item.kind,
            "location_id": str(location.id),
            "expires_at": expires_at.isoformat() if expires_at else None,
            "has_password": link.password_hash is not None,
            "max_downloads": link.max_downloads,
            "note": link.note,
        },
    )
    await events.emit_changed(db, location.id, [item.parent_id, item.id])
    await db.commit()
    path = public_path(token)
    base = settings.public_base_url.strip().rstrip("/")
    return DriveShareLinkCreatedOut(
        link=(await links_out(db, actor, [link]))[0],
        url=f"{base}{path}" if base else path,
        path=path,
    )


async def _link_for(
    db: AsyncSession, link_id: uuid.UUID, *, for_update: bool = False
) -> DriveShareLink:
    link = await db.get(
        DriveShareLink, link_id, with_for_update=for_update, populate_existing=for_update
    )
    if link is None or link.revoked_at is not None:
        raise link_not_found()
    return link


def _summary(link: DriveShareLink) -> dict[str, Any]:
    return {
        "expires_at": link.expires_at.isoformat() if link.expires_at else None,
        "has_password": link.password_hash is not None,
        "max_downloads": link.max_downloads,
        "note": link.note,
    }


async def update_link(
    db: AsyncSession, actor: User, link_id: uuid.UUID, data: DriveShareLinkPatch
) -> DriveShareLinkOut:
    """Only its creator, while they can still read the item."""
    link = await _link_for(db, link_id, for_update=True)
    if link.created_by != actor.id:
        raise link_not_found()
    await _readable(db, actor, link.item_id)
    found = await policy(db)
    before = _summary(link)
    sent = data.model_fields_set
    if "expires_at" in sent:
        _check_expiry(found, data.expires_at, utcnow())
        link.expires_at = data.expires_at
    if "password" in sent:
        if data.password is None and found.password_required:
            raise _password_required()
        link.password_hash = await hash_password(data.password) if data.password else None
        link.password_version += 1
    if "max_downloads" in sent:
        link.max_downloads = data.max_downloads
    if "note" in sent:
        link.note = (data.note or "").strip() or None
    after = _summary(link)
    if before != after or "password" in sent:
        link.updated_at = utcnow()
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="drive.link_updated",
            target_type="drive_share_link",
            target_id=link.id,
            details={
                "item_id": str(link.item_id),
                "from": before,
                "to": after,
                "password_changed": "password" in sent,
            },
        )
    await db.commit()
    return (await links_out(db, actor, [link]))[0]


async def revoke_link(
    db: AsyncSession, actor: User, link_id: uuid.UUID, *, as_admin: bool = False
) -> None:
    """Its creator, the location's managers, the administrators (§3.2)."""
    link = await _link_for(db, link_id, for_update=True)
    allowed = as_admin or link.created_by == actor.id or has_capability(actor, "drive.admin")
    location = await db.get(DriveLocation, link.location_id)
    if not allowed and location is not None:
        allowed = may_manage_links(actor, await acl.access(db, actor, location))
    if not allowed:
        raise link_not_found()
    link.revoked_at = utcnow()
    link.revoked_by = actor.id
    link.updated_at = link.revoked_at
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="drive.link_revoked",
        target_type="drive_share_link",
        target_id=link.id,
        details={
            "item_id": str(link.item_id),
            "location_id": str(link.location_id),
            # Not its creator: an administrator, or one who manages the location's links.
            "by_admin": as_admin
            or (link.created_by != actor.id and has_capability(actor, "drive.admin")),
            "by_creator": link.created_by == actor.id,
        },
    )
    item = await db.get(DriveItem, link.item_id)
    if item is not None:
        await events.emit_changed(db, item.location_id, [item.parent_id, item.id])
    await db.commit()


def _cursor(raw: str | None) -> uuid.UUID | None:
    if raw is None:
        return None
    try:
        return uuid.UUID(raw)
    except ValueError as exc:
        raise AppError(400, "invalid_cursor", "Malformed cursor") from exc


async def my_links(
    db: AsyncSession, actor: User, cursor: str | None, limit: int = PAGE
) -> DriveShareLinkListOut:
    """The links I made that are not revoked, newest first."""
    stmt = select(DriveShareLink).where(
        DriveShareLink.created_by == actor.id, DriveShareLink.revoked_at.is_(None)
    )
    return await _page(db, actor, stmt, cursor, limit)


async def all_links(
    db: AsyncSession, actor: User, cursor: str | None, limit: int = PAGE
) -> DriveShareLinkListOut:
    """Every link that is not revoked, in every location (§3.4, the administrators)."""
    stmt = select(DriveShareLink).where(DriveShareLink.revoked_at.is_(None))
    return await _page(db, actor, stmt, cursor, limit)


async def _page(
    db: AsyncSession, actor: User, stmt: Any, cursor: str | None, limit: int
) -> DriveShareLinkListOut:
    after = _cursor(cursor)
    if after is not None:
        stmt = stmt.where(DriveShareLink.id < after)
    rows: list[DriveShareLink] = list(
        (await db.execute(stmt.order_by(DriveShareLink.id.desc()).limit(limit + 1))).scalars()
    )
    more = len(rows) > limit
    rows = rows[:limit]
    return DriveShareLinkListOut(
        links=await links_out(db, actor, rows),
        next_cursor=str(rows[-1].id) if more and rows else None,
    )


def mask_ip(ip: str | None) -> str | None:
    """The creator sees where a link was used roughly (§9.5): 203.0.x.x, 2001:db8:x:…"""
    if not ip:
        return None
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv4Address):
        a, b, _, _ = str(address).split(".")
        return f"{a}.{b}.x.x"
    groups = address.exploded.split(":")
    return f"{groups[0].lstrip('0') or '0'}:{groups[1].lstrip('0') or '0'}:x:x:x:x:x:x"


async def link_events(
    db: AsyncSession, actor: User, link_id: uuid.UUID, cursor: str | None, limit: int = PAGE
) -> DriveShareEventListOut:
    """Its creator (the addresses cut to their first two parts) and the administrators."""
    link = await db.get(DriveShareLink, link_id)
    admin = has_capability(actor, "drive.admin")
    if link is None or (link.created_by != actor.id and not admin):
        raise link_not_found()
    stmt = select(DriveShareEvent).where(DriveShareEvent.link_id == link.id)
    if cursor is not None:
        try:
            stmt = stmt.where(DriveShareEvent.id < int(cursor))
        except ValueError as exc:
            raise AppError(400, "invalid_cursor", "Malformed cursor") from exc
    rows = list(
        (await db.execute(stmt.order_by(DriveShareEvent.id.desc()).limit(limit + 1))).scalars()
    )
    more = len(rows) > limit
    rows = rows[:limit]
    items = await repo.items(db, [r.item_id for r in rows if r.item_id is not None])
    full = admin
    return DriveShareEventListOut(
        events=[
            DriveShareEventOut(
                id=row.id,
                kind=row.kind,  # type: ignore[arg-type]
                item_id=row.item_id,
                item_name=items[row.item_id].name if row.item_id in items else None,
                bytes=row.bytes,
                ip=(str(row.ip) if row.ip else None)
                if full
                else mask_ip(str(row.ip) if row.ip else None),
                user_agent=row.user_agent,
                created_at=row.created_at,
            )
            for row in rows
        ],
        next_cursor=str(rows[-1].id) if more and rows else None,
    )


# --- the listing's sign of sharing ----------------------------------------------------------------


def _working(now: datetime) -> Any:
    return and_(
        DriveShareLink.revoked_at.is_(None),
        or_(DriveShareLink.expires_at.is_(None), DriveShareLink.expires_at > now),
        or_(
            DriveShareLink.max_downloads.is_(None),
            DriveShareLink.download_count < DriveShareLink.max_downloads,
        ),
    )


async def link_counts(db: AsyncSession, item_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """Links per item that are not revoked, expired or used up (paused ones count: they work
    again by themselves)."""
    if not item_ids:
        return {}
    stmt = (
        select(DriveShareLink.item_id, func.count())
        .where(DriveShareLink.item_id.in_(list(set(item_ids))), _working(utcnow()))
        .group_by(DriveShareLink.item_id)
    )
    return {row[0]: int(row[1]) for row in (await db.execute(stmt)).all()}


async def shared_above(db: AsyncSession, chain: list[uuid.UUID]) -> int:
    """Links on these items (a folder and the folders above it)."""
    return sum((await link_counts(db, chain)).values())


# --- set location switch ----------------------------------------------------------------------


async def set_location_links(
    db: AsyncSession, actor: User, location_id: uuid.UUID, enabled: bool
) -> DriveLocation:
    """PATCH /drive/locations/{id} {external_links}: those who manage the location (§3.2).
    Off stops the location's links (none is removed)."""
    location = await repo.location(db, location_id, for_update=True)
    if location is None:
        raise acl.item_not_found()
    (await acl.access(db, actor, location)).require_manage()
    if location.external_links != enabled:
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="drive.location_links_changed",
            target_type="drive_location",
            target_id=location.id,
            details={"from": location.external_links, "to": enabled},
        )
        location.external_links = enabled
        location.updated_at = utcnow()
        await events.emit_location_updated(db, location.id)
    await db.commit()
    return location


# --- the people who leave, the housekeeping ------------------------------------------------------


async def revoke_created_by_in_tx(db: AsyncSession, user_id: uuid.UUID) -> int:
    """An anonymised person's links end for good (§3.3); a deactivated one's only pause."""
    result = await db.execute(
        update(DriveShareLink)
        .where(DriveShareLink.created_by == user_id, DriveShareLink.revoked_at.is_(None))
        .values(revoked_at=utcnow(), updated_at=utcnow())
        .execution_options(synchronize_session=False)
    )
    return int(result.rowcount or 0)  # type: ignore[attr-defined]


async def prune_events(db: AsyncSession, *, days: int, now: datetime, limit: int = 5000) -> int:
    """The public side's events after DRIVE_SHARE_EVENTS_DAYS (§9.5)."""
    cutoff = now - timedelta(days=days)
    doomed = (
        select(DriveShareEvent.id)
        .where(DriveShareEvent.created_at < cutoff)
        .order_by(DriveShareEvent.id)
        .limit(limit)
        .scalar_subquery()
    )
    result = await db.execute(delete(DriveShareEvent).where(DriveShareEvent.id.in_(doomed)))
    await db.commit()
    return int(result.rowcount or 0)  # type: ignore[attr-defined]
