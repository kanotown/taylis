"""Who may do what in a drive location (docs/DRIVE.md §3.2).

Decided on every request from the current role and membership (no effective table: three kinds
of location, one membership row). An item someone cannot read does not exist for them (404
drive_item_not_found on every route); readable but not writable is 403 drive_read_only (an archived
channel, a channel where only owners post).
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, forbidden, not_found
from app.core.roles import PERSON_ROLES, has_capability
from app.modules.channels import service as channels
from app.modules.channels.models import Channel, ChannelMember
from app.modules.drive.models import DriveItem, DriveLocation
from app.modules.users.models import User

WORKSPACE_NAME = "研究室ドライブ"
MY_DRIVE_NAME = "マイドライブ"


def item_not_found() -> AppError:
    return not_found("drive_item_not_found", "Drive item not found")


def read_only() -> AppError:
    return forbidden("drive_read_only", "This drive is read-only for you")


def manage_restricted() -> AppError:
    return forbidden("drive_manage_restricted", "You cannot manage this drive")


def is_person(user: User) -> bool:
    """Admins, managers and members (not guests, not bots) who can sign in."""
    return user.role in PERSON_ROLES and user.is_active


@dataclass(frozen=True)
class Access:
    location: DriveLocation
    channel: Channel | None
    membership: ChannelMember | None
    can_read: bool
    can_write: bool
    can_manage: bool

    @property
    def archived(self) -> bool:
        return self.channel is not None and self.channel.is_archived

    def require_read(self) -> "Access":
        if not self.can_read:
            raise item_not_found()
        return self

    def require_write(self) -> "Access":
        self.require_read()
        if not self.can_write:
            raise read_only()
        return self

    def require_manage(self) -> "Access":
        self.require_read()
        if self.archived:
            raise read_only()
        if not self.can_manage:
            raise manage_restricted()
        return self


async def access(db: AsyncSession, actor: User, location: DriveLocation) -> Access:
    if location.deleted_at is not None or not actor.is_active:
        return Access(location, None, None, False, False, False)
    if location.kind == "workspace":
        person = is_person(actor)
        return Access(
            location, None, None, person, person, person and has_capability(actor, "drive.admin")
        )
    if location.kind == "user":
        own = location.user_id == actor.id and is_person(actor)
        return Access(location, None, None, own, own, own)
    assert location.channel_id is not None
    channel = await channels.find_channel(db, location.channel_id)
    membership = (
        await channels.membership_of(db, actor.id, location.channel_id)
        if channel is not None and not channel.is_dm
        else None
    )
    if channel is None or membership is None:
        return Access(location, channel, None, False, False, False)
    owner = membership.role == "owner"
    writable = not channel.is_archived and (
        channel.posting_policy != "owners" or owner or has_capability(actor, "channels.moderate")
    )
    return Access(location, channel, membership, True, writable, owner and not channel.is_archived)


async def readers(db: AsyncSession, location: DriveLocation) -> list[uuid.UUID]:
    """Who can read the location now (the audience of its events)."""
    if location.deleted_at is not None:
        return []
    if location.kind == "workspace":
        rows = await db.execute(
            select(User.id).where(User.role.in_(PERSON_ROLES), User.deactivated_at.is_(None))
        )
        return list(rows.scalars().all())
    if location.kind == "user":
        assert location.user_id is not None
        user = await db.get(User, location.user_id)
        return [user.id] if user is not None and is_person(user) else []
    assert location.channel_id is not None
    return await channels.member_ids_of(db, location.channel_id)


async def location_name(db: AsyncSession, location: DriveLocation) -> str:
    if location.kind == "workspace":
        return WORKSPACE_NAME
    if location.kind == "user":
        return MY_DRIVE_NAME
    assert location.channel_id is not None
    channel = await channels.find_channel(db, location.channel_id)
    return (channel.name if channel is not None else None) or ""


async def can_read_item(db: AsyncSession, actor: User, item_id: uuid.UUID) -> bool:
    """attachments.get_for_access's check for a drive file's versions (injected by main.py):
    the item exists, is not in the trash, and its location is readable."""
    item = await db.get(DriveItem, item_id)
    if item is None or item.trashed_at is not None:
        return False
    location = await db.get(DriveLocation, item.location_id)
    return location is not None and (await access(db, actor, location)).can_read
