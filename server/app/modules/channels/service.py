"""Channels, memberships and DM resolution (DATA_MODEL.md §3, SECURITY.md §3.2)."""

import hashlib
import uuid
from collections.abc import Awaitable, Callable

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
    ChannelReadStateOut,
    ChannelUpdate,
    MemberOut,
    MembershipOut,
)
from app.modules.reads import service as reads
from app.modules.reads.schemas import ReadMark, ReadStateOut
from app.modules.users.models import User
from app.modules.workspace import service as workspace

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
    channel: Channel,
    membership: ChannelMember | None,
    dm_user_ids: list[uuid.UUID] | None,
    member_count: int | None = None,
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
        posting_policy=channel.posting_policy,  # type: ignore[arg-type]
        times_owner_id=channel.times_owner_id,
        member_count=member_count
        if member_count is not None
        else (len(dm_user_ids) if dm_user_ids else None),
    )


def to_member_out(member: ChannelMember) -> MemberOut:
    return MemberOut(user_id=member.user_id, role=member.role, joined_at=member.joined_at)


def dm_key_for(user_ids: list[uuid.UUID]) -> str:
    return hashlib.sha256(",".join(str(i) for i in sorted(user_ids)).encode()).hexdigest()


# --- events -----------------------------------------------------------------------------------


# user.* events carry profiles: guests get only those of people they share a channel with (M13e).
USER_EVENTS = ("user.created", "user.updated", "user.deactivated")
GROUP_UPDATED = "group.updated"  # member lists: not for guests
ROSTER_UPDATED = "roster.updated"  # the lab roster (M23): not for guests either


async def _user_event_audience(db: AsyncSession, subject: uuid.UUID) -> list[uuid.UUID]:
    audience = await repo.non_guest_user_ids(db)
    for guest_id in await repo.guest_user_ids(db):
        if guest_id == subject or subject in await shared_member_ids(db, guest_id):
            audience.append(guest_id)
    return audience


async def visible_user_ids(db: AsyncSession, actor: User) -> set[uuid.UUID] | None:
    """Whom the actor may see: everyone (None), or for a guest the people sharing a channel."""
    return await shared_member_ids(db, actor.id) if actor.is_guest else None


async def resolve_event_audience(db: AsyncSession, event: OutboxEvent) -> Audience:
    """Injected into the OutboxRelay: turns an outbox row's audience into user / session ids."""
    if event.audience_type == "all":
        # A public channel appearing or changing visibility (M15b): not for guests (M13e).
        if event.event_type in (
            events.CHANNEL_CREATED,
            events.CHANNEL_UPDATED,
            GROUP_UPDATED,
            ROSTER_UPDATED,
        ):
            ids = await repo.non_guest_user_ids(db)
            if (
                event.event_type == events.CHANNEL_UPDATED
                and event.channel_id is not None
                and (event.payload.get("channel") or {}).get("type") == "private"
            ):
                # The bare event of a channel made private (update_channel): its members got
                # the full one and must not drop the channel on this one.
                members = await repo.member_ids_for_channels(db, [event.channel_id])
                ids = [uid for uid in ids if uid not in set(members.get(event.channel_id, []))]
            return Audience(kind="users", ids=tuple(ids))
        if event.event_type in USER_EVENTS:
            subject = uuid.UUID(str(event.payload["user"]["id"]))
            return Audience(kind="users", ids=tuple(await _user_event_audience(db, subject)))
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
    bare: bool = False,
) -> None:
    """`bare`: the event for people outside a channel that just became private, without the
    topic, purpose, member count or member list (empty, so the clients drop the channel)."""
    member_ids = (await repo.member_ids_for_channels(db, [channel.id])).get(channel.id, [])
    if bare:
        out = to_channel_out(channel, None, None, None).model_copy(
            update={"topic": None, "purpose": None}
        )
        data = events.ChannelEventData(channel=out, member_ids=[])
    else:
        data = events.ChannelEventData(
            channel=to_channel_out(
                channel, None, member_ids if channel.is_dm else None, len(member_ids)
            ),
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


async def announce_created_in_tx(db: AsyncSession, channel: Channel) -> None:
    """channel.created for a channel made outside the API (M18 import), as create_channel does."""
    await _emit_channel(
        db,
        events.CHANNEL_CREATED,
        channel,
        audience_type="all" if channel.type == "public" else "channel",
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


# --- join / leave lines (M88, docs/MEMBERSHIP.md §1) -------------------------------------------

# (db, channel_id, actor_id, kind, user_ids) -> the line's seq. The messages module registers it
# (channels does not depend on messages).
MembershipWriter = Callable[
    [AsyncSession, uuid.UUID, uuid.UUID, str, list[uuid.UUID]], Awaitable[int]
]
_membership_writer: MembershipWriter | None = None


def set_membership_writer(writer: MembershipWriter | None) -> None:
    global _membership_writer
    _membership_writer = writer


async def _bot_ids(db: AsyncSession, user_ids: list[uuid.UUID]) -> set[uuid.UUID]:
    if not user_ids:
        return set()
    stmt = select(User.id).where(User.id.in_(user_ids), User.role == "bot")
    return set((await db.execute(stmt)).scalars().all())


async def announce_membership_in_tx(
    db: AsyncSession,
    channel: Channel,
    actor_id: uuid.UUID,
    kind: str,
    user_ids: list[uuid.UUID],
) -> int | None:
    """A join / leave line in a public or private channel, unless 「参加・退出の表示」 is off. Not
    in DMs or archived channels, never about bots (webhooks, recurring posts, the AI) nor by
    them. Returns its seq (None when nothing was written); the caller commits."""
    if _membership_writer is None or channel.type not in ("public", "private"):
        return None
    if channel.is_archived:
        return None
    bots = await _bot_ids(db, [actor_id, *user_ids])
    subjects = [uid for uid in dict.fromkeys(user_ids) if uid not in bots]
    if actor_id in bots or not subjects:
        return None
    if not (await workspace.settings(db)).show_membership_messages:
        return None
    seq = await _membership_writer(db, channel.id, actor_id, kind, subjects)
    await db.refresh(
        channel, ["last_seq"]
    )  # the answer (a join's ChannelOut) carries the line's seq
    return seq


async def _joined_in_tx(
    db: AsyncSession, channel: Channel, actor_id: uuid.UUID, user_ids: list[uuid.UUID]
) -> None:
    """After memberships were added: the line (joined when the actor is the one who came, added
    otherwise), and the newcomers' read position after it (their own line is not news to them)."""
    kind = "member_joined" if user_ids == [actor_id] else "members_added"
    seq = await announce_membership_in_tx(db, channel, actor_id, kind, user_ids)
    if seq is not None:
        for user_id in user_ids:
            await reads.initialize_in_tx(db, user_id, channel.id, seq)


# --- access checks ----------------------------------------------------------------------------


def require_not_guest(actor: User) -> None:
    """M13e: guests neither create nor browse nor join channels, nor add members."""
    if actor.is_guest:
        raise forbidden("guest_restricted", "Guests cannot do this")


async def shared_member_ids(db: AsyncSession, user_id: uuid.UUID) -> set[uuid.UUID]:
    """Everyone who shares a channel with the user (the people a guest may see and message)."""
    rows = await repo.list_user_channels(db, user_id)
    members = await repo.member_ids_for_channels(db, [c.id for c, _ in rows])
    return {uid for ids in members.values() for uid in ids} | {user_id}


async def member_channel_ids(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    """Every conversation the user belongs to, DMs included (canvases: GET /canvases)."""
    return [channel.id for channel, _ in await repo.list_user_channels(db, user_id)]


async def member_ids_of(db: AsyncSession, channel_id: uuid.UUID) -> list[uuid.UUID]:
    return (await repo.member_ids_for_channels(db, [channel_id])).get(channel_id, [])


async def manager_ids_of(db: AsyncSession, channel_id: uuid.UUID) -> set[uuid.UUID]:
    """The members who manage a channel's content: its owners and the administrators among its
    members (the calendar's editors, CALENDAR.md §3)."""
    members = await repo.list_members(db, channel_id)
    owners = {m.user_id for m in members if m.role == "owner"}
    others = [m.user_id for m in members if m.role != "owner"]
    if not others:
        return owners
    admins = await db.execute(select(User.id).where(User.id.in_(others), User.role == "admin"))
    return owners | set(admins.scalars().all())


async def find_channel(db: AsyncSession, channel_id: uuid.UUID) -> Channel | None:
    """A channel row or None, for modules that own the access decision (M12h invites)."""
    return await repo.get_channel(db, channel_id)


async def find_channel_by_name(db: AsyncSession, name: str) -> Channel | None:
    """A public or private channel by name, for M48's default channels of new SSO accounts."""
    return await repo.get_channel_by_name(db, name)


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


async def require_readable(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> Channel:
    """Reading a channel's messages (SECURITY.md §3.2): its members, and in a public channel
    everyone but a guest, who could join it anyway (M27: the preview before joining, Slack).
    Writing, reactions, votes and read positions stay with the members (require_member)."""
    channel = await require_channel(db, channel_id)
    if await repo.get_membership(db, channel_id, actor.id) is not None:
        return channel
    if channel.type == "public" and not actor.is_guest:
        # M88 (docs/MEMBERSHIP.md §3): an administrator can turn the preview off; administrators
        # are no exception (they join like everyone else).
        if not await preview_allowed(db):
            raise forbidden("preview_disabled", "Join this channel to read its messages")
        return channel
    raise forbidden("not_a_member", "You are not a member of this channel")


async def preview_allowed(db: AsyncSession) -> bool:
    """M88: whether public channels can be read before joining (the workspace setting)."""
    return (await workspace.settings(db)).preview_before_join


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
    require_not_guest(actor)
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
    return await _out_with_count(db, channel, membership)


async def list_channels(db: AsyncSession, actor: User, *, include_public: bool) -> list[ChannelOut]:
    rows = await repo.list_user_channels(db, actor.id)
    dm_ids = [c.id for c, _ in rows if c.is_dm]
    members = await repo.member_ids_for_channels(db, dm_ids)
    browse = include_public and not actor.is_guest  # M13e: guests see only their channels
    browsable = await repo.list_public_channels_not_member(db, actor.id) if browse else []
    counts = await repo.member_counts_for_channels(
        db, [c.id for c, _ in rows if not c.is_dm] + [c.id for c in browsable]
    )
    out = [to_channel_out(c, m, members.get(c.id), counts.get(c.id)) for c, m in rows]
    out.extend(to_channel_out(c, None, None, counts.get(c.id, 0)) for c in browsable)
    return out


async def list_public_times_not_member(db: AsyncSession, actor: User) -> list[ChannelOut]:
    """is:times (L8) widens the search to these; never for guests (M13e)."""
    if actor.is_guest or not await preview_allowed(db):  # M88: no preview, no reading them
        return []
    rows = await repo.list_public_times_not_member(db, actor.id)
    counts = await repo.member_counts_for_channels(db, [c.id for c in rows])
    return [to_channel_out(c, None, None, counts.get(c.id, 0)) for c in rows]


async def _out_with_count(
    db: AsyncSession, channel: Channel, membership: ChannelMember | None
) -> ChannelOut:
    """A single non-DM channel with its current member count (M11h)."""
    counts = await repo.member_counts_for_channels(db, [channel.id])
    return to_channel_out(channel, membership, None, counts.get(channel.id, 0))


async def get_channel(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> ChannelOut:
    channel = await require_channel(db, channel_id)
    membership = await repo.get_membership(db, channel_id, actor.id)
    # The same rule as reading its messages (require_readable): a guest sees nothing of a public
    # channel they are not in, not even its name and size (M13e).
    if membership is None and (channel.type != "public" or actor.is_guest):
        raise forbidden("not_a_member", "You are not a member of this channel")
    dm_ids = None
    if channel.is_dm:
        dm_ids = (await repo.member_ids_for_channels(db, [channel.id])).get(channel.id)
    counts = await repo.member_counts_for_channels(db, [channel.id])
    return to_channel_out(channel, membership, dm_ids, counts.get(channel.id, 0))


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
    if data.posting_policy is not None:
        channel.posting_policy = data.posting_policy
    if "times_owner_id" in data.model_fields_set and data.times_owner_id != channel.times_owner_id:
        await _set_times_owner(db, actor, channel, data.times_owner_id)
    converted = data.type is not None and data.type != channel.type
    if converted:
        # Making a private channel public exposes its whole history: administrators only, and (L4,
        # LAB.md J) only one who is a member, so a staff admin cannot open a students' channel.
        if data.type == "public" and not actor.is_admin:
            raise forbidden("admin_required", "Only an administrator can make a channel public")
        if data.type == "public" and membership is None:
            raise forbidden(
                "admin_not_member", "Only an administrator who is a member can make it public"
            )
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="channel.converted",
            target_type="channel",
            target_id=channel.id,
            details={"from": channel.type, "to": data.type},
        )
        channel.type = data.type  # type: ignore[assignment]
        if channel.type != "public":  # M90: a default channel must stay public
            await workspace.drop_default_channel_in_tx(
                db, channel.id, actor.id, "channel_made_private"
            )
    channel.updated_at = utcnow()
    try:
        await db.flush()
        if converted and channel.type == "private":
            # Made private: the members get the full event; everyone else only learns that the
            # channel left their browser (a bare event without its topic or member list, since
            # those are now the members' business). resolve_event_audience keeps the members out
            # of the second one.
            await _emit_channel(db, events.CHANNEL_UPDATED, channel, audience_type="channel")
            await _emit_channel(db, events.CHANNEL_UPDATED, channel, audience_type="all", bare=True)
        else:
            # A visibility change reaches everyone (non-members gain the channel in their
            # browser); other changes only the members.
            await _emit_channel(
                db,
                events.CHANNEL_UPDATED,
                channel,
                audience_type="all" if converted else "channel",
            )
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise conflict("name_taken", "A channel with this name already exists") from exc
    return await _out_with_count(db, channel, membership)


# --- times (M24, DATA_MODEL.md channels) ---------------------------------------------------------

TIMES_NAME_TRIES = 20


async def ensure_times(
    db: AsyncSession, actor: User, followers: list[uuid.UUID]
) -> tuple[ChannelOut, bool]:
    """My times, made on the first call (True) as the public channel `times-{username}` I own;
    `followers` (the supervisors on the lab roster, main.py) become members. Later calls return
    it (False)."""
    require_not_guest(actor)
    existing = await repo.get_times_of(db, actor.id)
    if existing is not None:
        membership = await repo.get_membership(db, existing.id, actor.id)
        if membership is None and not existing.is_archived:
            # I had left my own times: back in, as its owner again.
            await add_member_in_tx(db, existing, actor.id, announce=True)
            membership = await repo.get_membership(db, existing.id, actor.id)
            if membership is not None:
                membership.role = "owner"
            await db.commit()
        return await _out_with_count(db, existing, membership), False
    try:
        channel, membership = await create_times_in_tx(db, actor, followers)
        await db.commit()
    except IntegrityError:
        # Made meanwhile by another request of mine (the one-per-person index): that one it is.
        await db.rollback()
        made = await repo.get_times_of(db, actor.id)
        if made is None:
            raise
        return await _out_with_count(
            db, made, await repo.get_membership(db, made.id, actor.id)
        ), False
    return await _out_with_count(db, channel, membership), True


async def create_times_in_tx(
    db: AsyncSession, owner: User, followers: list[uuid.UUID]
) -> tuple[Channel, ChannelMember]:
    """A new times for `owner` (who has none); also an invite's preset on acceptance (L7). The
    caller commits (and handles the one-per-person index)."""
    name = await _free_times_name(db, f"times-{owner.username}")
    channel = Channel(
        type="public",
        name=name,
        purpose=f"{owner.display_name} の作業ログ",
        created_by=owner.id,
        times_owner_id=owner.id,
    )
    db.add(channel)
    await db.flush()
    membership = ChannelMember(channel_id=channel.id, user_id=owner.id, role="owner")
    db.add(membership)
    await db.flush()
    await reads.initialize_in_tx(db, owner.id, channel.id, channel.last_seq)
    await _emit_channel(db, events.CHANNEL_CREATED, channel, audience_type="all")
    for user_id in dict.fromkeys(followers):
        if user_id != owner.id:
            await add_member_in_tx(db, channel, user_id)
    return channel, membership


async def times_of(db: AsyncSession, owner_id: uuid.UUID) -> Channel | None:
    """For the lab module (L7): someone's times, archived or not."""
    return await repo.get_times_of(db, owner_id)


async def set_archived_in_tx(db: AsyncSession, channel: Channel, archived: bool) -> bool:
    """For the lab module (L7): archive a graduate's times, or undo it; the caller commits.
    False when it already was so."""
    if channel.is_archived == archived:
        return False
    channel.archived_at = utcnow() if archived else None
    channel.updated_at = utcnow()
    await db.flush()
    if archived:
        await write_outbox(
            db,
            event_type=events.CHANNEL_ARCHIVED,
            audience_type="channel",
            channel_id=channel.id,
            payload=events.ChannelArchivedData(channel_id=channel.id).model_dump(mode="json"),
        )
        await workspace.drop_default_channel_in_tx(db, channel.id, None, "channel_archived")
    else:
        await _emit_channel(db, events.CHANNEL_UPDATED, channel, audience_type="channel")
    return True


async def conversations_of(
    db: AsyncSession, user_id: uuid.UUID, *, include_dms: bool = False
) -> list[tuple[Channel, str]]:
    """For the lab module (L7) and the calendar (M51): the public and private channels someone
    belongs to, with their role in each (DMs are left alone unless asked for: tasks, L9), by
    name."""
    return await repo.channel_memberships_of(db, user_id, include_dms=include_dms)


async def _free_times_name(db: AsyncSession, base: str) -> str:
    for n in range(1, TIMES_NAME_TRIES + 1):
        name = base if n == 1 else f"{base}-{n}"
        if await repo.get_channel_by_name(db, name) is None:
            return name
    raise conflict("name_taken", "A channel with this name already exists")


def times_name_follows(name: str | None, username: str) -> bool:
    """Whether a times channel's name is still the one made from `username` (`times-{username}`,
    or `-2` … when that was taken): renamed by hand, it is the owner's choice and stays."""
    if name is None:
        return False
    base = f"times-{username}".lower()
    lowered = name.lower()
    if lowered == base:
        return True
    suffix = lowered.removeprefix(base + "-")
    return suffix != lowered and suffix.isdigit() and 2 <= int(suffix) <= TIMES_NAME_TRIES


async def rename_times_for_username_in_tx(
    db: AsyncSession, owner_id: uuid.UUID, old_username: str, new_username: str
) -> tuple[str, str] | None:
    """M96 (DATA_MODEL.md users「ユーザー名の変更」): the owner's times follows a new username when
    its name still is the one made from the old (`times_name_follows`). Returns (from, to), or None
    when there is no such times or every candidate name is taken (the name then stays). The
    caller commits."""
    channel = await repo.get_times_of(db, owner_id)
    if channel is None or not times_name_follows(channel.name, old_username):
        return None
    base = f"times-{new_username}"
    for n in range(1, TIMES_NAME_TRIES + 1):
        candidate = base if n == 1 else f"{base}-{n}"
        if candidate.lower() == (channel.name or "").lower():
            return None  # already right (cannot happen with a changed username, but harmless)
        if await repo.get_channel_by_name(db, candidate) is None:
            break
    else:
        return None
    previous = channel.name or ""
    channel.name = candidate
    channel.updated_at = utcnow()
    await db.flush()
    await _emit_channel(db, events.CHANNEL_UPDATED, channel, audience_type="channel")
    return previous, candidate


async def follow_times_in_tx(db: AsyncSession, owner_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    """For the lab module: a supervisor joins their student's times, if any (caller commits)."""
    channel = await repo.get_times_of(db, owner_id)
    if channel is None or channel.is_archived or user_id == owner_id:
        return False
    return await add_member_in_tx(db, channel, user_id, announce=True)


async def _set_times_owner(
    db: AsyncSession, actor: User, channel: Channel, owner_id: uuid.UUID | None
) -> None:
    """An administrator marks a channel as someone's times (a Mattermost import's, say) or unmarks
    it; the owner becomes a channel owner, so they can switch it to threads only."""
    if not actor.is_admin:
        raise forbidden("admin_required", "Only an administrator can mark a channel as times")
    if owner_id is not None:
        owners = await load_users(db, [owner_id])
        if owners[0].is_guest:
            raise forbidden("guest_restricted", "A guest cannot have a times channel")
        other = await repo.get_times_of(db, owner_id)
        if other is not None and other.id != channel.id:
            raise conflict("times_exists", "That person already has a times channel")
        membership = await repo.get_membership(db, channel.id, owner_id)
        if membership is None:
            await add_member_in_tx(db, channel, owner_id, announce=True, actor_id=actor.id)
            membership = await repo.get_membership(db, channel.id, owner_id)
        if membership is not None and membership.role != "owner":
            membership.role = "owner"
    channel.times_owner_id = owner_id
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="channel.times_owner_set",
        target_type="channel",
        target_id=channel.id,
        details={"times_owner_id": str(owner_id) if owner_id else None},
    )


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
        await workspace.drop_default_channel_in_tx(db, channel.id, actor.id, "channel_archived")
        await db.commit()
    return await _out_with_count(db, channel, membership)


async def unarchive_channel(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> ChannelOut:
    """M13d: the reverse of archive (owner or admin); members learn through channel.updated."""
    channel, membership = await _load_for_manage(db, actor, channel_id)
    _require_not_dm(channel)
    if channel.is_archived:
        channel.archived_at = None
        channel.updated_at = utcnow()
        await db.flush()
        await _emit_channel(db, events.CHANNEL_UPDATED, channel, audience_type="channel")
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="channel.unarchived",
            target_type="channel",
            target_id=channel.id,
        )
        await db.commit()
    return await _out_with_count(db, channel, membership)


async def join_channel(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> ChannelOut:
    require_not_guest(actor)
    channel = await require_channel(db, channel_id)
    if channel.type != "public":
        raise forbidden("not_a_member", "You are not a member of this channel")
    require_writable(channel)
    membership = await repo.get_membership(db, channel_id, actor.id)
    if membership is None:
        actor_id = actor.id  # instances expire on rollback (a lazy load would fail in async code)
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
            await _joined_in_tx(db, channel, actor_id, [actor_id])
            await db.commit()
        except IntegrityError:
            await db.rollback()  # a concurrent join won: answer with that membership
            membership = await repo.get_membership(db, channel_id, actor_id)
            if membership is None:
                raise
            channel = await require_channel(db, channel_id)
    return await _out_with_count(db, channel, membership)


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
    await db.flush()
    await announce_membership_in_tx(db, channel, actor.id, "member_left", [actor.id])
    await db.commit()


async def list_members(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> list[MemberOut]:
    await require_member(db, actor.id, channel_id)
    return [to_member_out(m) for m in await repo.list_members(db, channel_id)]


async def add_member(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, target: User
) -> MemberOut:
    return (await add_members(db, actor, channel_id, [target]))[0]


async def add_members(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, targets: list[User]
) -> list[MemberOut]:
    """Add people (M88: several in one action, one 「A が B、C を追加しました」 line); those
    already in are answered as they are. One MemberOut per target, in order."""
    require_not_guest(actor)
    channel, _ = await require_member(db, actor.id, channel_id)
    _require_not_dm(channel)
    require_writable(channel)
    if any(not target.is_active for target in targets):
        raise conflict("user_deactivated", "User is deactivated")
    actor_id = actor.id
    target_ids = list(dict.fromkeys(target.id for target in targets))
    added: list[uuid.UUID] = []
    for target_id in target_ids:
        if await repo.get_membership(db, channel_id, target_id) is not None:
            continue
        try:
            async with db.begin_nested():
                db.add(ChannelMember(channel_id=channel_id, user_id=target_id, role="member"))
                await db.flush()
        except IntegrityError:
            continue  # added concurrently: that membership is the answer
        await reads.initialize_in_tx(db, target_id, channel_id, channel.last_seq)
        await _emit_member(
            db, events.CHANNEL_MEMBER_ADDED, channel_id, target_id, audience_type="channel"
        )
        await _emit_channel(
            db, events.CHANNEL_CREATED, channel, audience_type="user", audience_id=target_id
        )
        added.append(target_id)
    if added:
        await _joined_in_tx(db, channel, actor_id, added)
    await db.commit()
    by_id: dict[uuid.UUID, MemberOut] = {}
    for target_id in target_ids:
        membership = await repo.get_membership(db, channel_id, target_id)
        if membership is None:  # removed again in the meantime
            raise not_found("member_not_found", "User is not a member of this channel")
        by_id[target_id] = to_member_out(membership)
    return [by_id[target_id] for target_id in target_ids]


async def membership_of(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID
) -> ChannelMember | None:
    return await repo.get_membership(db, channel_id, user_id)


async def add_member_in_tx(
    db: AsyncSession,
    channel: Channel,
    user_id: uuid.UUID,
    *,
    announce: bool = False,
    actor_id: uuid.UUID | None = None,
) -> bool:
    """Membership for a freshly created account (M12h invites); the caller commits.

    Returns False when the user already belongs to the channel. Archived channels and DMs are the
    caller's responsibility (invites drop them silently, as the invite may be older than the
    archive). `announce` (M88): the join line — 「参加しました」, or 「追加しました」 by `actor_id`.
    Off for bots' plumbing and the lab rollover (a bulk operation with its own undo).
    """
    if await repo.get_membership(db, channel.id, user_id) is not None:
        return False
    membership = ChannelMember(channel_id=channel.id, user_id=user_id, role="member")
    await reads.initialize_in_tx(db, user_id, channel.id, channel.last_seq)
    db.add(membership)
    await db.flush()
    await _emit_member(
        db, events.CHANNEL_MEMBER_ADDED, channel.id, user_id, audience_type="channel"
    )
    await _emit_channel(
        db, events.CHANNEL_CREATED, channel, audience_type="user", audience_id=user_id
    )
    if announce:
        await _joined_in_tx(db, channel, actor_id or user_id, [user_id])
    return True


async def add_members_in_tx(
    db: AsyncSession, channel: Channel, actor_id: uuid.UUID, user_ids: list[uuid.UUID]
) -> list[uuid.UUID]:
    """Several memberships at once with one 「A が B、C … を追加しました」 line (M90: the
    administrator's 「今いる人も全員入れる」); the caller commits. Returns who was added (those
    already in, or added concurrently, are skipped). Archived channels and DMs are the caller's
    responsibility."""
    added: list[uuid.UUID] = []
    for user_id in dict.fromkeys(user_ids):
        if await repo.get_membership(db, channel.id, user_id) is not None:
            continue
        try:
            async with db.begin_nested():
                db.add(ChannelMember(channel_id=channel.id, user_id=user_id, role="member"))
                await db.flush()
        except IntegrityError:
            continue
        await reads.initialize_in_tx(db, user_id, channel.id, channel.last_seq)
        await _emit_member(
            db, events.CHANNEL_MEMBER_ADDED, channel.id, user_id, audience_type="channel"
        )
        await _emit_channel(
            db, events.CHANNEL_CREATED, channel, audience_type="user", audience_id=user_id
        )
        added.append(user_id)
    if added:
        await _joined_in_tx(db, channel, actor_id, added)
    return added


async def remove_member_in_tx(db: AsyncSession, channel: Channel, user_id: uuid.UUID) -> bool:
    """Drop a membership without committing (M13a webhooks); False when there was none."""
    membership = await repo.get_membership(db, channel.id, user_id)
    if membership is None:
        return False
    await _emit_member(
        db, events.CHANNEL_MEMBER_REMOVED, channel.id, user_id, audience_type="channel"
    )
    await _emit_member(
        db,
        events.CHANNEL_MEMBER_REMOVED,
        channel.id,
        user_id,
        audience_type="user",
        audience_id=user_id,
    )
    await db.delete(membership)
    await db.flush()
    return True


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
    await db.flush()
    if target_user_id == actor.id:  # an owner or admin removing themselves left
        await announce_membership_in_tx(db, channel, actor.id, "member_left", [actor.id])
    else:
        await announce_membership_in_tx(db, channel, actor.id, "member_removed", [target_user_id])
    await db.commit()


async def update_member_role(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, target_user_id: uuid.UUID, role: str
) -> MemberOut:
    """L4: an owner or an administrator makes a member an owner (e.g. a teacher of #お知らせ) or
    takes it back. A channel with owners keeps at least one; guests are never owners."""
    channel, _ = await _load_for_manage(db, actor, channel_id)
    _require_not_dm(channel)
    membership = await repo.get_membership(db, channel_id, target_user_id)
    if membership is None:
        raise not_found("member_not_found", "User is not a member of this channel")
    if membership.role == role:
        return to_member_out(membership)
    if role == "owner":
        target = await db.get(User, target_user_id)
        if target is None or target.is_guest or target.role == "bot":
            raise forbidden("owner_not_allowed", "Guests and bots cannot own a channel")
    elif await repo.count_owners(db, channel_id) <= 1:
        raise conflict("last_owner", "A channel keeps at least one owner")
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="channel.member_role",
        target_type="channel",
        target_id=channel.id,
        details={"user_id": str(target_user_id), "from": membership.role, "to": role},
    )
    await set_member_role_in_tx(db, channel, target_user_id, role, membership)
    await db.commit()
    return to_member_out(membership)


async def set_member_role_in_tx(
    db: AsyncSession,
    channel: Channel,
    user_id: uuid.UUID,
    role: str,
    membership: ChannelMember | None = None,
) -> bool:
    """A member's role and channel.member_updated (also a rollover's undo, L7); the caller
    commits."""
    membership = membership or await repo.get_membership(db, channel.id, user_id)
    if membership is None:
        return False
    membership.role = role
    data = events.ChannelMemberRoleData(channel_id=channel.id, user_id=user_id, role=role)
    await write_outbox(
        db,
        event_type=events.CHANNEL_MEMBER_UPDATED,
        audience_type="channel",
        channel_id=channel.id,
        payload=data.model_dump(mode="json"),
    )
    return True


async def get_or_create_dm(
    db: AsyncSession, actor: User, participants: list[User]
) -> tuple[ChannelOut, bool]:
    """Resolve the DM / group DM for a set of users. Idempotent and safe under concurrency."""
    for user in participants:
        if not user.is_active:
            raise conflict("user_deactivated", "User is deactivated")
    if actor.is_guest:  # M13e: only people who share a channel with the guest
        allowed = await shared_member_ids(db, actor.id)
        if any(u.id not in allowed for u in participants):
            raise forbidden("guest_restricted", "Guests can only message members of their channels")
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


async def mark_all_read(
    db: AsyncSession, actor: User, *, only: set[uuid.UUID] | None = None
) -> list[ChannelReadStateOut]:
    """POST /channels/read-all (M12a): every channel I belong to (or those in `only`) is read to
    its end.

    Each channel that moves emits its own read.updated, so other devices catch up as usual.
    """
    states: list[ChannelReadStateOut] = []
    for channel in await list_channels(db, actor, include_public=False):
        if only is not None and channel.id not in only:
            continue
        state = await reads.advance_in_tx(
            db, actor.id, channel.id, channel.last_seq, last_seq=channel.last_seq
        )
        states.append(ChannelReadStateOut(channel_id=channel.id, **state.model_dump()))
    await db.commit()
    return states


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
