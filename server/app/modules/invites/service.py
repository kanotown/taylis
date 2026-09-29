"""Invite links (M12h, SECURITY.md §2.5).

An administrator issues a link; whoever opens it chooses a username, a display name and a
password and becomes a member (or an admin, if the invite says so). There is still no public
registration: without a live token the endpoints only answer 404 / 410. The token is random,
travels only in the URL and is stored hashed; the response of `create` is the one time it is
shown.
"""

import re
import secrets
import uuid
from datetime import datetime, timedelta

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, bad_request, conflict, forbidden, not_found
from app.core.security import hash_password, hash_token
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.admin import service as admin
from app.modules.admin.schemas import AdminUserCreate
from app.modules.audit import service as audit
from app.modules.auth import service as auth
from app.modules.auth.schemas import LoginRequest, TokenResponse
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.invites import repository as repo
from app.modules.invites.models import Invite
from app.modules.invites.schemas import (
    InviteAccept,
    InviteCreate,
    InviteLabPreview,
    InviteOut,
    InvitePreviewOut,
    status_of,
    to_invite_out,
)
from app.modules.lab import service as lab
from app.modules.lab.schemas import LabPreset
from app.modules.users import service as users
from app.modules.users.models import User

TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{20,128}$")


async def _invite_channels(db: AsyncSession, actor: User, ids: list[uuid.UUID]) -> list[Channel]:
    """Channels an invite may hand out: public ones, or private ones the issuer belongs to."""
    result: list[Channel] = []
    for channel_id in dict.fromkeys(ids):
        channel = await channels.require_channel(db, channel_id)
        if channel.is_dm:
            raise bad_request("invalid_channel", "Direct messages cannot be joined by invite")
        if channel.is_archived:
            raise conflict("channel_archived", "Channel is archived")
        if (
            channel.type == "private"
            and await channels.membership_of(db, actor.id, channel.id) is None
        ):
            raise forbidden("not_a_member", "You are not a member of this channel")
        result.append(channel)
    return result


async def create(db: AsyncSession, actor: User, data: InviteCreate) -> tuple[InviteOut, str]:
    selected = await _invite_channels(db, actor, data.channel_ids)
    if data.lab is not None:
        if data.lab.times and data.role == "guest":
            raise bad_request("guest_restricted", "A guest cannot have a times channel")
        if data.lab.supervisor_id is not None:
            await lab.check_supervisor(db, data.lab.supervisor_id)
    token = secrets.token_urlsafe(32)
    now = utcnow()
    invite = Invite(
        token_hash=hash_token(token),
        created_by=actor.id,
        role=data.role,
        channel_ids=[c.id for c in selected],
        note=(data.note or "").strip() or None,
        max_uses=data.max_uses,
        use_count=0,
        used_by=[],
        expires_at=now + timedelta(hours=data.expires_in_hours),
        created_at=now,
        lab_preset=data.lab.model_dump(mode="json") if data.lab else None,
    )
    db.add(invite)
    await db.flush()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="admin.invite_created",
        target_type="invite",
        target_id=invite.id,
        details={
            "role": invite.role,
            "channel_ids": [str(c.id) for c in selected],
            "max_uses": invite.max_uses,
            "expires_at": invite.expires_at.isoformat(),
            "lab": invite.lab_preset,
        },
    )
    await db.commit()
    return to_invite_out(invite, now), token


async def list_invites(db: AsyncSession) -> list[InviteOut]:
    now = utcnow()
    return [to_invite_out(row, now) for row in await repo.list_all(db)]


async def revoke(db: AsyncSession, actor: User, invite_id: uuid.UUID) -> None:
    invite = await repo.get(db, invite_id)
    if invite is None:
        raise not_found("invite_not_found", "Invite not found")
    if invite.revoked_at is None:
        invite.revoked_at = utcnow()
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="admin.invite_revoked",
            target_type="invite",
            target_id=invite.id,
        )
        await db.commit()


async def _require_live(
    db: AsyncSession, token: str, now: datetime, *, for_update: bool = False
) -> Invite:
    if not TOKEN_PATTERN.match(token):
        raise not_found("invite_not_found", "Invite not found")
    invite = await repo.get_by_token_hash(db, hash_token(token), for_update=for_update)
    if invite is None:
        raise not_found("invite_not_found", "Invite not found")
    status = status_of(invite, now)
    if status != "active":
        raise AppError(410, f"invite_{status}", f"Invite is {status}", details={"status": status})
    return invite


async def _apply_lab_preset(db: AsyncSession, invite: Invite, user: User) -> None:
    """L7: the roster line, the managed groups and (for members) a times, in the acceptance's
    transaction. A supervisor who is no longer faculty is dropped rather than failing the join."""
    preset = LabPreset.model_validate(invite.lab_preset)
    put = preset.as_put()
    if put.supervisor_id is not None:
        try:
            await lab.check_supervisor(db, put.supervisor_id)
        except AppError:
            put = put.model_copy(update={"supervisor_id": None})
    if preset.times and user.role != "guest":
        followers = [put.supervisor_id] if put.supervisor_id else []
        await channels.create_times_in_tx(db, user, followers)
    issuer = await users.get_user(db, invite.created_by)
    await lab.put_in_tx(db, issuer, user.id, put)


async def preview(db: AsyncSession, token: str, settings: Settings) -> InvitePreviewOut:
    invite = await _require_live(db, token, utcnow())
    issuer = await users.get_user(db, invite.created_by)
    names: list[str] = []
    for channel_id in invite.channel_ids or []:
        channel = await channels.find_channel(db, channel_id)
        if channel is not None and channel.name and not channel.is_archived:
            names.append(channel.name)
    lab_preview = None
    if invite.lab_preset:
        preset = LabPreset.model_validate(invite.lab_preset)
        supervisor = (
            await users.get_user(db, preset.supervisor_id) if preset.supervisor_id else None
        )
        lab_preview = InviteLabPreview(
            affiliation=preset.affiliation,
            rank=preset.rank,
            grade=preset.grade,
            supervisor_name=supervisor.display_name if supervisor else None,
            times=preset.times and invite.role != "guest",
        )
    return InvitePreviewOut(
        invited_by=issuer.display_name if issuer else "管理者",
        role=invite.role,
        channels=names,
        expires_at=invite.expires_at,
        password_min_length=settings.password_min_length,
        lab=lab_preview,
    )


async def accept(
    db: AsyncSession, token: str, data: InviteAccept, settings: Settings, ip: str | None
) -> TokenResponse:
    """Create the account (one transaction), then log it in like any other login."""
    if len(data.password) < settings.password_min_length:
        raise AppError(
            422,
            "password_too_short",
            f"Password must be at least {settings.password_min_length} characters",
            details={"min_length": settings.password_min_length},
        )
    password_hash = await hash_password(data.password)
    now = utcnow()
    invite = await _require_live(db, token, now, for_update=True)
    try:
        user = await admin.create_user_in_tx(
            db,
            AdminUserCreate(
                username=data.username,
                display_name=data.display_name,
                role="admin"
                if invite.role == "admin"
                else "guest"
                if invite.role == "guest"
                else "member",
            ),
            password_hash=password_hash,
            must_change_password=False,
            actor_id=invite.created_by,
            details={"invite_id": str(invite.id)},
        )
        for channel_id in invite.channel_ids or []:
            channel = await channels.find_channel(db, channel_id)
            if channel is None or channel.is_archived or channel.is_dm:
                continue  # the invite outlived the channel
            if (
                channel.type == "private"
                and await channels.membership_of(db, invite.created_by, channel.id) is None
            ):
                continue  # made private since, or the issuer left: not theirs to hand out
            await channels.add_member_in_tx(db, channel, user.id)
        if invite.lab_preset:
            await _apply_lab_preset(db, invite, user)
        invite.use_count += 1
        invite.used_by = [*(invite.used_by or []), user.id]
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise conflict("username_taken", "Username is already in use") from exc
    # A separate transaction: the account exists even if this login fails, and the invitee can
    # simply log in with the password they chose.
    request = LoginRequest(username=data.username, password=data.password, device=data.device)
    return await auth.login(db, request, settings, ip)
