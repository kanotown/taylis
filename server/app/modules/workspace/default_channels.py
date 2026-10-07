"""「既定のチャンネル」 (M90, docs/MEMBERSHIP.md §6): the public channels every new non-guest
account joins, and the administrator's 「今いる人も全員入れる」.

A module of its own because it needs both the workspace settings and the channels service (which
itself reads the workspace settings)."""

import logging
import uuid
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.roles import PERSON_ROLES
from app.modules.audit import service as audit
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.users.models import User
from app.modules.workspace import service as workspace
from app.modules.workspace.schemas import DefaultChannelApplied, DefaultChannelsApplyOut

log = logging.getLogger("app.workspace")

# Who gets the default channels: people, not guests (they see only what they are added to) nor
# bots (webhooks, recurring posts, the AI: plumbing, not people).
JOINING_ROLES = PERSON_ROLES


async def _legacy_channels(db: AsyncSession, names: Sequence[str]) -> list[Channel]:
    """M48's SSO_DEFAULT_CHANNELS (deprecated): the named open public channels."""
    found: list[Channel] = []
    for name in names:
        channel = await channels.find_channel_by_name(db, name)
        if not workspace.usable_default(channel):
            log.warning("SSO_DEFAULT_CHANNELS names no open public channel: %s", name)
            continue
        assert channel is not None
        if channel not in found:
            found.append(channel)
    return found


async def channels_for_new_account(
    db: AsyncSession, legacy_names: Sequence[str] = ()
) -> list[Channel]:
    """The administrator's list when it was ever saved; otherwise ``legacy_names``
    (SSO_DEFAULT_CHANNELS, passed only by Google sign-in's auto-provision). Channels archived,
    deleted or made private since are skipped. The returned channels stay locked until the caller
    commits (review v0.1.30 #1: a channel made private meanwhile is never joined)."""
    ids = await workspace.default_channel_ids(db)
    if ids is None:
        ids = [c.id for c in await _legacy_channels(db, legacy_names)]
    return await workspace.lock_usable_default_channels(db, ids)


async def join_in_tx(
    db: AsyncSession, user: User, *, legacy_names: Sequence[str] = ()
) -> list[Channel]:
    """A freshly created account joins the default channels, each through the normal membership
    path (events, read position, the 「参加しました」 line when M88's setting is on). Guests, bots
    and deactivated accounts get none. The caller commits."""
    if user.role not in JOINING_ROLES or not user.is_active:
        return []
    joined = await channels_for_new_account(db, legacy_names)
    for channel in joined:
        await channels.add_member_in_tx(db, channel, user.id, announce=True)
    return joined


async def apply_to_everyone(
    db: AsyncSession, actor: User, *, dry_run: bool
) -> DefaultChannelsApplyOut:
    """「今いる人も全員入れる」: every active admin / member joins the default channels they are not
    in, with one 「A が B、C … を追加しました」 line per channel. Idempotent (a second run adds
    nobody). Only the saved list counts (not SSO_DEFAULT_CHANNELS). Audited when anyone was
    added."""
    targets = (
        (
            await db.execute(
                select(User.id)
                .where(User.role.in_(JOINING_ROLES), User.deactivated_at.is_(None))
                .order_by(User.username)
            )
        )
        .scalars()
        .all()
    )
    ids = await workspace.default_channel_ids(db)
    # Review v0.1.30 #1: a real run locks the channels and re-reads them, so one made private or
    # archived after the list was read is skipped (and one being changed waits for this commit).
    usable = await (
        workspace.usable_default_channels(db, ids)
        if dry_run
        else workspace.lock_usable_default_channels(db, ids)
    )
    results: list[DefaultChannelApplied] = []
    people: set[uuid.UUID] = set()
    memberships = 0
    for channel in usable:
        members = set(await channels.member_ids_of(db, channel.id))
        missing = [uid for uid in targets if uid not in members]
        added = (
            missing if dry_run else await channels.add_members_in_tx(db, channel, actor.id, missing)
        )
        results.append(
            DefaultChannelApplied(id=channel.id, name=channel.name or "", added=len(added))
        )
        people.update(added)
        memberships += len(added)
    if not dry_run:
        if memberships:
            await audit.record_in_tx(
                db,
                actor_id=actor.id,
                action="workspace.default_channels_applied",
                target_type="workspace",
                target_id=None,
                details={
                    "users": len(people),
                    "memberships": memberships,
                    "channels": {str(r.id): r.added for r in results},
                },
            )
        await db.commit()
    return DefaultChannelsApplyOut(
        dry_run=dry_run, users=len(people), memberships=memberships, channels=results
    )
