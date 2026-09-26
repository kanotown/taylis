"""Channels, memberships and DM resolution (DATA_MODEL.md §3, SECURITY.md §3.2)."""

import hashlib
import uuid

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import bad_request, conflict, forbidden, not_found
from app.core.time import utcnow
from app.events.envelope import Audience
from app.events.models import OutboxEvent
from app.events.outbox import AudienceType, write_outbox
from app.modules.audit import service as audit
from app.modules.channels import events
from app.modules.channels import repository as repo
from app.modules.channels.models import Channel, ChannelMember
from app.modules.channels.schemas import (
    ChannelCreate,
    ChannelOut,
    ChannelUpdate,
    MemberOut,
    MembershipOut,
)
from app.modules.reads import service as reads
from app.modules.reads.schemas import ReadMark, ReadStateOut
from app.modules.users.models import User

MAX_DM_MEMBERS = 9


async def load_users(db: AsyncSession, user_ids: list[uuid.UUID]) -> list[User]:
    """Resolve users referenced by membership / DM requests.

    Read-only access to the users table is an explicit exception to the module rule
    (ARCHITECTURE.md §5).
    """
    unique_ids = list(dict.fromkeys(user_ids))
    if not unique_ids:
        return []
    result = await db.execute(select(User).where(User.id.in_(unique_ids)))
    users = list(result.scalars().all())
    if len(users) != len(unique_ids):
        raise not_found("user_not_found", "User not found")
    return users


def _membership_out(membership: ChannelMember | None) -> MembershipOut | None:
    if membership is None:
        return None
    return MembershipOut(role=membership.role, joined_at=membership.joined_at)


def to_channel_out(
    channel: Channel, membership: ChannelMember | None, dm_user_ids: list[uuid.UUID] | None
) -> ChannelOut:
    return ChannelOut(
        id=channel.id,
        type=channel.type,  # type: ignore[arg-type]
        name=channel.name,
        topic=channel.topic,
        purpose=channel.purpose,
        archived=channel.is_archived,
        created_by=channel.created_by,
        last_seq=channel.last_seq,
        last_message_at=channel.last_message_at,
        created_at=channel.created_at,
        updated_at=channel.updated_at,
        membership=_membership_out(membership),
        dm_user_ids=dm_user_ids,
    )


def to_member_out(member: ChannelMember) -> MemberOut:
    return MemberOut(user_id=member.user_id, role=member.role, joined_at=member.joined_at)


def dm_key_for(user_ids: list[uuid.UUID]) -> str:
    return hashlib.sha256(",".join(str(i) for i in sorted(user_ids)).encode()).hexdigest()


# --- events -----------------------------------------------------------------------------------


async def resolve_event_audience(db: AsyncSession, event: OutboxEvent) -> Audience:
    """Injected into the OutboxRelay: turns an outbox row's audience into user / session ids."""
    if event.audience_type == "all":
        return Audience(kind="all")
    if event.audience_type == "user" and event.audience_id is not None:
        return Audience(kind="users", ids=(event.audience_id,))
    if event.audience_type == "session" and event.audience_id is not None:
        return Audience(kind="sessions", ids=(event.audience_id,))
    if event.audience_type == "channel" and event.channel_id is not None:
        members = await repo.member_ids_for_channels(db, [event.channel_id])
        return Audience(kind="users", ids=tuple(members.get(event.channel_id, [])))
    raise ValueError(f"unresolvable audience {event.audience_type!r} for event {event.id}")


async def _emit_channel(
    db: AsyncSession,
    event_type: str,
    channel: Channel,
    *,
    audience_type: AudienceType,
    audience_id: uuid.UUID | None = None,
) -> None:
    member_ids = (await repo.member_ids_for_channels(db, [channel.id])).get(channel.id, [])
    data = events.ChannelEventData(
        channel=to_channel_out(channel, None, member_ids if channel.is_dm else None),
        member_ids=member_ids,
    )
    await write_outbox(
        db,
        event_type=event_type,
        audience_type=audience_type,
        audience_id=audience_id,
        channel_id=channel.id,
        payload=data.model_dump(mode="json"),
    )


async def _emit_member(
    db: AsyncSession,
    event_type: str,
    channel_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    audience_type: AudienceType,
    audience_id: uuid.UUID | None = None,
) -> None:
    data = events.ChannelMemberData(channel_id=channel_id, user_id=user_id)
    await write_outbox(
        db,
        event_type=event_type,
        audience_type=audience_type,
        audience_id=audience_id,
        channel_id=channel_id,
        payload=data.model_dump(mode="json"),
    )


# --- access checks ----------------------------------------------------------------------------


async def require_channel(db: AsyncSession, channel_id: uuid.UUID) -> Channel:
    channel = await repo.get_channel(db, channel_id)
    if channel is None:
        raise not_found("channel_not_found", "Channel not found")
    return channel


async def require_member(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID
) -> tuple[Channel, ChannelMember]:
    """Every access to a channel's content goes through here (SECURITY.md §3.2)."""
    channel = await require_channel(db, channel_id)
    membership = await repo.get_membership(db, channel_id, user_id)
    if membership is None:
        raise forbidden("not_a_member", "You are not a member of this channel")
    return channel, membership


def require_writable(channel: Channel) -> None:
    if channel.is_archived:
        raise conflict("channel_archived", "Channel is archived")


def _require_not_dm(channel: Channel) -> None:
    if channel.is_dm:
        raise conflict("dm_immutable", "Direct message channels cannot be modified")


async def _load_for_manage(
    db: AsyncSession, actor: User, channel_id: uuid.UUID
) -> tuple[Channel, ChannelMember | None]:
    """Owner or administrator. Administrators may manage channels they are not a member of."""
    if actor.is_admin:
        channel = await require_channel(db, channel_id)
        return channel, await repo.get_membership(db, channel_id, actor.id)
    channel, membership = await require_member(db, actor.id, channel_id)
    if membership.role != "owner":
        raise forbidden("forbidden", "Channel owner or administrator required")
    return channel, membership


# --- use cases --------------------------------------------------------------------------------


async def create_channel(db: AsyncSession, actor: User, data: ChannelCreate) -> ChannelOut:
    if await repo.get_channel_by_name(db, data.name) is not None:
        raise conflict("name_taken", "A channel with this name already exists")
    channel = Channel(
        type=data.type, name=data.name, topic=data.topic, purpose=data.purpose, created_by=actor.id
    )
    membership = ChannelMember(channel_id=channel.id, user_id=actor.id, role="owner")
    try:
        db.add(channel)
        await db.flush()
        membership.channel_id = channel.id
        db.add(membership)
        await db.flush()
        await reads.initialize_in_tx(db, actor.id, channel.id, channel.last_seq)
        await _emit_channel(
            db,
            events.CHANNEL_CREATED,
            channel,
            audience_type="all" if channel.type == "public" else "channel",
        )
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise conflict("name_taken", "A channel with this name already exists") from exc
    return to_channel_out(channel, membership, None)


async def list_channels(db: AsyncSession, actor: User, *, include_public: bool) -> list[ChannelOut]:
    rows = await repo.list_user_channels(db, actor.id)
    dm_ids = [c.id for c, _ in rows if c.is_dm]
    members = await repo.member_ids_for_channels(db, dm_ids)
    out = [to_channel_out(c, m, members.get(c.id)) for c, m in rows]
    if include_public:
        out.extend(
            to_channel_out(c, None, None)
            for c in await repo.list_public_channels_not_member(db, actor.id)
        )
    return out


async def get_channel(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> ChannelOut:
    channel = await require_channel(db, channel_id)
    membership = await repo.get_membership(db, channel_id, actor.id)
    if membership is None and channel.type != "public":
        raise forbidden("not_a_member", "You are not a member of this channel")
    dm_ids = None
    if channel.is_dm:
        dm_ids = (await repo.member_ids_for_channels(db, [channel.id])).get(channel.id)
    return to_channel_out(channel, membership, dm_ids)


async def update_channel(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, data: ChannelUpdate
) -> ChannelOut:
    channel, membership = await _load_for_manage(db, actor, channel_id)
    _require_not_dm(channel)
    if data.name is not None and data.name.lower() != (channel.name or "").lower():
        if await repo.get_channel_by_name(db, data.name) is not None:
            raise conflict("name_taken", "A channel with this name already exists")
        channel.name = data.name
    if data.topic is not None:
        channel.topic = data.topic
    if data.purpose is not None:
        channel.purpose = data.purpose
    channel.updated_at = utcnow()
    try:
        await db.flush()
        await _emit_channel(db, events.CHANNEL_UPDATED, channel, audience_type="channel")
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise conflict("name_taken", "A channel with this name already exists") from exc
    return to_channel_out(channel, membership, None)


async def archive_channel(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> ChannelOut:
    channel, membership = await _load_for_manage(db, actor, channel_id)
    _require_not_dm(channel)
    if not channel.is_archived:
        channel.archived_at = utcnow()
        channel.updated_at = channel.archived_at
        await db.flush()
        await write_outbox(
            db,
            event_type=events.CHANNEL_ARCHIVED,
            audience_type="channel",
            channel_id=channel.id,
            payload=events.ChannelArchivedData(channel_id=channel.id).model_dump(mode="json"),
        )
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="channel.archived",
            target_type="channel",
            target_id=channel.id,
        )
        await db.commit()
    return to_channel_out(channel, membership, None)


async def join_channel(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> ChannelOut:
    channel = await require_channel(db, channel_id)
    if channel.type != "public":
        raise forbidden("not_a_member", "You are not a member of this channel")
    require_writable(channel)
    membership = await repo.get_membership(db, channel_id, actor.id)
    if membership is None:
        membership = ChannelMember(channel_id=channel.id, user_id=actor.id, role="member")
        await reads.initialize_in_tx(db, actor.id, channel.id, channel.last_seq)
        db.add(membership)
        try:
            await db.flush()
            await _emit_member(
                db, events.CHANNEL_MEMBER_ADDED, channel.id, actor.id, audience_type="channel"
            )
            # The joiner's other devices learn about the channel this way.
            await _emit_channel(
                db, events.CHANNEL_CREATED, channel, audience_type="user", audience_id=actor.id
            )
            await db.commit()
        except IntegrityError:
            await db.rollback()
            membership = await repo.get_membership(db, channel_id, actor.id)
            if membership is None:
                raise
    return to_channel_out(channel, membership, None)


async def leave_channel(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> None:
    channel, membership = await require_member(db, actor.id, channel_id)
    _require_not_dm(channel)
    await _emit_member(
        db, events.CHANNEL_MEMBER_REMOVED, channel.id, actor.id, audience_type="channel"
    )
    await _emit_member(
        db,
        events.CHANNEL_MEMBER_REMOVED,
        channel.id,
        actor.id,
        audience_type="user",
        audience_id=actor.id,
    )
    await db.delete(membership)
    await db.commit()


async def list_members(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> list[MemberOut]:
    await require_member(db, actor.id, channel_id)
    return [to_member_out(m) for m in await repo.list_members(db, channel_id)]


async def add_member(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, target: User
) -> MemberOut:
    channel, _ = await require_member(db, actor.id, channel_id)
    _require_not_dm(channel)
    require_writable(channel)
    if not target.is_active:
        raise conflict("user_deactivated", "User is deactivated")
    existing = await repo.get_membership(db, channel_id, target.id)
    if existing is not None:
        return to_member_out(existing)
    membership = ChannelMember(channel_id=channel_id, user_id=target.id, role="member")
    await reads.initialize_in_tx(db, target.id, channel_id, channel.last_seq)
    db.add(membership)
    try:
        await db.flush()
        await _emit_member(
            db, events.CHANNEL_MEMBER_ADDED, channel.id, target.id, audience_type="channel"
        )
        await _emit_channel(
            db, events.CHANNEL_CREATED, channel, audience_type="user", audience_id=target.id
        )
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing = await repo.get_membership(db, channel_id, target.id)
        if existing is None:
            raise
        return to_member_out(existing)
    return to_member_out(membership)


async def remove_member(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, target_user_id: uuid.UUID
) -> None:
    channel, _ = await _load_for_manage(db, actor, channel_id)
    _require_not_dm(channel)
    membership = await repo.get_membership(db, channel_id, target_user_id)
    if membership is None:
        raise not_found("member_not_found", "User is not a member of this channel")
    await _emit_member(
        db, events.CHANNEL_MEMBER_REMOVED, channel.id, target_user_id, audience_type="channel"
    )
    await _emit_member(
        db,
        events.CHANNEL_MEMBER_REMOVED,
        channel.id,
        target_user_id,
        audience_type="user",
        audience_id=target_user_id,
    )
    await db.delete(membership)
    await db.commit()


async def get_or_create_dm(
    db: AsyncSession, actor: User, participants: list[User]
) -> tuple[ChannelOut, bool]:
    """Resolve the DM / group DM for a set of users. Idempotent and safe under concurrency."""
    for user in participants:
        if not user.is_active:
            raise conflict("user_deactivated", "User is deactivated")
    user_ids = sorted({u.id for u in participants} | {actor.id})
    if len(user_ids) > MAX_DM_MEMBERS:
        raise bad_request(
            "too_many_members", f"A group DM can have at most {MAX_DM_MEMBERS} members"
        )
    dm_type = "group_dm" if len(user_ids) > 2 else "dm"
    dm_key = dm_key_for(user_ids)

    created = False
    channel = await repo.get_by_dm_key(db, dm_key)
    if channel is None:
        try:
            async with db.begin_nested():
                channel = Channel(type=dm_type, dm_key=dm_key, created_by=actor.id)
                db.add(channel)
                await db.flush()
                db.add_all(
                    ChannelMember(channel_id=channel.id, user_id=uid, role="member")
                    for uid in user_ids
                )
                await db.flush()
                for uid in user_ids:
                    await reads.initialize_in_tx(db, uid, channel.id, 0)
                await _emit_channel(db, events.CHANNEL_CREATED, channel, audience_type="channel")
            await db.commit()
            created = True
        except IntegrityError:
            # Someone created the same DM concurrently; the savepoint was rolled back.
            channel = await repo.get_by_dm_key(db, dm_key)
            if channel is None:
                raise
    membership = await repo.get_membership(db, channel.id, actor.id)
    return to_channel_out(channel, membership, user_ids), created


async def mark_read(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, data: ReadMark
) -> ReadStateOut:
    """PUT /channels/{id}/read (SYNC_PROTOCOL.md §4.5 / §10): monotonic, or exact with mode=set."""
    channel, _ = await require_member(db, actor.id, channel_id)
    if data.mode == "set":
        state = await reads.set_in_tx(
            db, actor.id, channel_id, data.last_read_seq, last_seq=channel.last_seq
        )
    else:
        state = await reads.advance_in_tx(
            db, actor.id, channel_id, data.last_read_seq, last_seq=channel.last_seq
        )
    await db.commit()
    return state
